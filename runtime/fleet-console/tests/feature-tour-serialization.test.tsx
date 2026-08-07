// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureTourOverlay } from "../core/client/src/components/feature-tour.js";
import { getGlobalSettingsStoreState, hydrateGlobalSettings } from "../core/client/src/global-settings-store.js";
import type { GlobalSettingsState } from "../core/client/src/types.js";

const SETTINGS: GlobalSettingsState = {
  consolePortMode: "dynamic",
  consoleStaticPort: null,
  language: "auto",
  seenFeatureTours: [],
  theme: "instrument",
  uiFont: { source: "builtin", id: "manrope", size: 14 },
};

// canvas-modes 워크스루가 끝나자마자 같은 화면에서 claude-operations 워크스루가 이어진다.
// finish()는 시청 기록 저장이 끝나기 전에 락을 풀지 않아야 하므로, 첫 PUT을 지연시켜
// '저장 중' 상태에서 다음 투어가 열리지 않는지와, 저장이 끝난 뒤에야 열리는지를 검증한다.
const LAUNCH_KINDS = [
  '<div class="command-band-mode-switch"></div>',
  '<div class="command-band-mode-tray"></div>',
  '<button data-operation-launch-kind="claude-native">Claude (Native)</button>',
  '<button data-operation-launch-kind="claude-gateway">Claude (Gateway)</button>',
].join("");

const originalFetch = globalThis.fetch;
let root: Root | null = null;

beforeEach(() => {
  document.body.replaceChildren();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function primaryButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(".feature-tour-primary");
}

describe("feature tour seen-key serialization", () => {
  it("holds the next tour until the prior seen-key save completes", async () => {
    document.body.innerHTML = LAUNCH_KINDS;

    // 첫 PUT(모드 워크스루 저장)은 수동 해제 전까지 답하지 않는다.
    let resolveFirst!: (value: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockImplementation(async () => new Response(JSON.stringify({
        state: {
          ...SETTINGS,
          seenFeatureTours: ["canvas-modes.walkthrough", "claude-operations.walkthrough"],
        },
      })));
    globalThis.fetch = fetchMock as typeof fetch;
    hydrateGlobalSettings(SETTINGS);

    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => { root?.render(<FeatureTourOverlay />); });

    // canvas-modes 워크스루가 두 단계로 재생된다.
    expect(document.querySelector('[data-feature-tour-id]')?.getAttribute("data-feature-tour-id"))
      .toBe("canvas-modes");

    // 다음 → 시작하기(마지막 단계)로 완료한다. 마지막 클릭은 저장을 시작하고,
    // 그 저장이 끝나기 전에는 뒤따르는 투어가 열리면 안 된다.
    await act(async () => { primaryButton()?.click(); });
    await act(async () => { primaryButton()?.click(); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-feature-tour-id]')).toBeNull();

    // 저장이 끝나야 락이 풀리고 claude-operations 워크스루가 열린다.
    await act(async () => {
      resolveFirst(new Response(JSON.stringify({
        state: { ...SETTINGS, seenFeatureTours: ["canvas-modes.walkthrough"] },
      })));
    });
    expect(document.querySelector('[data-feature-tour-id]')?.getAttribute("data-feature-tour-id"))
      .toBe("claude-operations");

    // 두 번째 투어를 끝내면 저장이 끝난 뒤의 쓰기라 동시 저장에 밀리지 않고 두 키가 모두 남는다.
    await act(async () => { primaryButton()?.click(); });
    await act(async () => { primaryButton()?.click(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies[0]).toEqual({ seenFeatureTours: ["canvas-modes.walkthrough"] });
    expect(bodies[1]).toEqual({
      seenFeatureTours: ["canvas-modes.walkthrough", "claude-operations.walkthrough"],
    });
    expect(getGlobalSettingsStoreState().state?.seenFeatureTours).toContain("claude-operations.walkthrough");
  });
});
