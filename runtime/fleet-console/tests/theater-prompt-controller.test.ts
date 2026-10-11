// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn() }));
vi.mock("../features/settings/client/execution-settings.js", async (original) => ({
  ...await original<object>(),
  fetchTheaterSystemPrompt: http.fetch,
  saveTheaterSystemPrompt: http.save,
}));
// 등록된 Theater 로 본다 — 잊힘 처리는 이 계약의 대상이 아니다.
vi.mock("../core/client/src/hooks/use-store.js", () => ({ useTheaterLabel: (id: string | null | undefined) => id ?? null }));

import { useTheaterPromptController, type PromptTheater, type TheaterPromptController } from "../features/settings/client/theater-prompt-editor.js";

/**
 * Theater Inbox 의 프롬프트 controller 는 다른 Theater 로 바뀌거나(본문이 다른 Theater 로 다시 그려질 때) 닫힐 때(언마운트)
 * 1초 자동 저장을 기다리던 글을 확정해야 한다. 그 글이 버려지거나 새 Theater 에 저장되면 사람이 쓴 지침을 잃는다(저장 무결성).
 * 이 케이스는 Theater 변경과 언마운트만 재현한다 — 같은 시트 안의 섹션 이동은 controller 를 마운트한 채 두는 다른 경로다.
 */
describe("Theater prompt controller lifecycle", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; http.fetch.mockReset(); http.save.mockReset(); vi.useRealTimers(); });

  it("flushes a pending edit to its own Theater when the Theater changes or the editor closes", async () => {
    vi.useFakeTimers();
    http.fetch.mockImplementation(async (theaterId: string) => ({ theaterId, prompt: { mode: "append", body: "" } }));
    http.save.mockImplementation(async (theaterId: string, prompt: unknown) => ({ theaterId, prompt }));
    let controller: TheaterPromptController | null = null;
    function Probe({ theater }: { readonly theater: PromptTheater | null }) {
      controller = useTheaterPromptController(theater, 0, { onMissing: () => undefined, onDiscarded: () => undefined });
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = async (theater: PromptTheater | null) => { await act(async () => { root.render(createElement(Probe, { theater })); }); await act(async () => { await vi.runOnlyPendingTimersAsync(); }); };
    cleanup = () => { act(() => root.unmount()); container.remove(); };

    await render({ id: "alpha", label: "alpha" });
    expect(controller!.loading).toBe(false);
    await act(async () => { controller!.changeBody("alpha draft"); });
    expect(http.save).not.toHaveBeenCalled();

    // 자동 저장 1초가 지나기 전에 다른 Theater 로 — 앞 Theater 의 글이 앞 Theater 에만 저장된다.
    await render({ id: "beta", label: "beta" });
    expect(http.save).toHaveBeenCalledTimes(1);
    expect(http.save).toHaveBeenLastCalledWith("alpha", { mode: "append", body: "alpha draft" });
    expect(http.fetch).toHaveBeenLastCalledWith("beta", expect.anything());
    expect(controller!.draft.body).toBe("");

    // 쓰다 만 채로 닫아도 버리지 않는다.
    await act(async () => { controller!.changeBody("beta draft"); });
    await render(null);
    expect(http.save).toHaveBeenCalledTimes(2);
    expect(http.save).toHaveBeenLastCalledWith("beta", { mode: "append", body: "beta draft" });
  });
});
