// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationCatalogPlugin } from "@fleet-console/sdk/operations";

import { CanvasContextMenu } from "../core/client/src/canvas/canvas-context-menu.js";
import { EFFORT_CONFIRM_TIP_SEEN_KEY } from "../core/client/src/components/feature-tour.js";
import { hydrateGlobalSettings } from "../core/client/src/global-settings-store.js";
import { readLaunchStartSurface, withStartSurface } from "../core/client/src/launch-start-surface.js";
import type { GlobalSettingsState } from "../core/client/src/types.js";

const SETTINGS: GlobalSettingsState = {
  consolePortMode: "dynamic",
  consoleStaticPort: null,
  remoteAccess: { enabled: false, publicEndpointEnabled: false, listenAddress: "", advertisedHost: "", listenPort: { mode: "auto", value: 49152 }, advertisedPort: { mode: "auto", value: 49153 }, acknowledgment: null },
  language: "auto",
  seenFeatureTours: [],
  theme: "instrument",
  uiFont: { source: "builtin", id: "manrope", size: 14 },
};

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  hydrateGlobalSettings(SETTINGS);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  hydrateGlobalSettings(SETTINGS);
});

describe("launch menu start surface", () => {
  it("stands a mark only on rows whose kind declares a chat start", () => {
    renderMenu();

    expect(surfaceMark("fable")).not.toBeNull();
    expect(surfaceMark("opus")).not.toBeNull();
    // Codex는 launchViews를 선언하지 않는다 — 못 여는 표면을 고를 수 있는 척하면 안 된다.
    expect(surfaceMark("gpt")).toBeNull();
  });

  it("opens on the terminal surface until something says otherwise", () => {
    renderMenu();

    expect(surfaceMark("fable")!.dataset.launchStartSurface).toBe("terminal");
    expect(surfaceMark("opus")!.dataset.launchStartSurface).toBe("terminal");
  });

  // 값은 메뉴 하나에 하나다. 세 행이 함께 뒤집히는 것이 곧 그 계약의 설명이므로, 한 행만 바뀌는
  // 회귀는 사용자에게 "행마다 다른 표면"이라는 없는 규칙을 가르친다.
  it("flips every chat-capable row from one mark, and launches nothing", () => {
    const onLaunchKind = vi.fn();
    renderMenu(onLaunchKind);

    act(() => surfaceMark("fable")!.click());

    expect(surfaceMark("fable")!.dataset.launchStartSurface).toBe("chat");
    expect(surfaceMark("opus")!.dataset.launchStartSurface).toBe("chat");
    expect(onLaunchKind).not.toHaveBeenCalled();
  });

  it("carries viewMode only while the menu is armed for chat", () => {
    const onLaunchKind = vi.fn();
    renderMenu(onLaunchKind);

    act(() => row("fable").click());
    expect(onLaunchKind.mock.calls[0]![2]).toEqual({ model: "fable" });

    act(() => surfaceMark("fable")!.click());
    act(() => row("fable").click());
    expect(onLaunchKind.mock.calls[1]![2]).toEqual({ model: "fable", viewMode: "chat" });
  });

  // 같은 행이 어떻게 눌렸는지에 따라 다른 곳에서 태어나면 안 된다 — 트랙에서 확정하는 실행도
  // 같은 표면으로 나간다.
  it("keeps the effort-track launch on the same surface", () => {
    const onLaunchKind = vi.fn();
    // 트랙 확정 팁은 졸업 기록을 서버에 되쓴다 — 이 시험이 보려는 것은 표면이므로 이미 본 것으로 둔다.
    hydrateGlobalSettings({ ...SETTINGS, seenFeatureTours: [EFFORT_CONFIRM_TIP_SEEN_KEY] });
    renderMenu(onLaunchKind);

    act(() => surfaceMark("fable")!.click());
    act(() => row("fable").parentElement!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    act(() => effortHandle("fable").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));

    const track = document.querySelector<HTMLElement>(".effort-track");
    if (!track) throw new Error("Missing the effort track");
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    act(() => track.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

    const launch = onLaunchKind.mock.calls.at(-1)![2] as Record<string, string>;
    expect(launch).toEqual({ model: "fable", effort: "max", viewMode: "chat" });
  });

  it("hands the choice to the next menu that opens", () => {
    renderMenu();
    act(() => surfaceMark("fable")!.click());

    expect(readLaunchStartSurface()).toBe("chat");

    act(() => root.unmount());
    root = createRoot(container);
    renderMenu();

    expect(surfaceMark("fable")!.dataset.launchStartSurface).toBe("chat");
  });

  // 왼쪽은 표면, 오른쪽은 강도. 포인터와 키보드가 같은 조건에서 같은 값을 바꾼다.
  it("answers the left arrow on a row that carries the mark", () => {
    renderMenu();

    act(() => row("fable").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));

    expect(surfaceMark("fable")!.dataset.launchStartSurface).toBe("chat");
  });

  it("stays silent on the left arrow where no mark stands", () => {
    renderMenu();

    act(() => row("gpt").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));

    expect(surfaceMark("fable")!.dataset.launchStartSurface).toBe("terminal");
    expect(readLaunchStartSurface()).toBe("terminal");
  });
});

describe("withStartSurface", () => {
  it("refuses to arm a kind that never declared a chat start", () => {
    expect(withStartSurface({ model: "gpt" }, { }, "chat")).toEqual({ model: "gpt" });
    expect(withStartSurface({ model: "gpt" }, { launchViews: ["terminal"] }, "chat")).toEqual({ model: "gpt" });
  });

  it("leaves a terminal launch untouched", () => {
    const launch = { model: "fable" };
    expect(withStartSurface(launch, { launchViews: ["terminal", "chat"] }, "terminal")).toBe(launch);
  });
});

function renderMenu(onLaunchKind = vi.fn()): void {
  act(() => root.render(
    <CanvasContextMenu
      anchor={{ x: 200, y: 120 }}
      viewportBounds={{ width: 1116, height: 856 }}
      catalog={CATALOG}
      canLaunch
      renderKindIcon={() => null}
      onLaunchKind={onLaunchKind}
      onClose={vi.fn()}
    />,
  ));
}

function row(rowId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-launch-variant-row="${rowId}"]`);
  if (!element) throw new Error(`Missing the row for ${rowId}`);
  return element;
}

function surfaceMark(rowId: string): HTMLElement | null {
  return row(rowId).querySelector<HTMLElement>(".operation-launch-surface-mark");
}

function effortHandle(rowId: string): HTMLElement {
  const handle = row(rowId).closest<HTMLElement>(".operation-launch-variant-entry")
    ?.querySelector<HTMLElement>(".operation-launch-variant-effort-handle");
  if (!handle) throw new Error(`Missing the effort handle for ${rowId}`);
  return handle;
}

/** 채팅을 선언한 종류와 선언하지 않은 종류가 한 메뉴에 함께 선다 — 표식의 경계가 이 픽스처다. */
const CATALOG: readonly OperationCatalogPlugin[] = [{
  id: "terminal",
  title: "Terminal",
  kinds: [
    {
      id: "claude",
      type: "agent",
      title: "Claude",
      launchViews: ["terminal", "chat"],
      variants: [{
        id: "native",
        label: "Claude",
        rows: [
          {
            id: "fable",
            label: "Fable",
            launch: { model: "fable" },
            chips: [
              { id: "high", label: "HIGH", launch: { model: "fable", effort: "high" } },
              { id: "max", label: "MAX", launch: { model: "fable", effort: "max" } },
            ],
          },
          {
            id: "opus",
            label: "Opus",
            launch: { model: "opus" },
            chips: [
              { id: "high", label: "HIGH", launch: { model: "opus", effort: "high" } },
            ],
          },
        ],
      }],
    },
    {
      id: "codex",
      type: "agent",
      title: "Codex",
      variants: [{
        id: "native",
        label: "Codex",
        rows: [{
          id: "gpt",
          label: "GPT",
          launch: { model: "gpt" },
          chips: [{ id: "high", label: "HIGH", launch: { model: "gpt", effort: "high" } }],
        }],
      }],
    },
  ],
}];
