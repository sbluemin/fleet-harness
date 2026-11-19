// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerComposerDraft, sendComposerText, type ComposerDraftHandle } from "./commodore-composer-bridge.js";

const extendObjective = vi.hoisted(() => vi.fn<(objectiveId: string, language: "en" | "ko", context: string) => Promise<void>>());
vi.mock("./board.js", () => ({ extendObjective }));

const { ExtendAction } = await import("./commodore-person-inbox.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 입력창이 맡긴 손잡이의 시험 대역 — 글과 표식을 들고 비우기·초점 호출을 센다. */
function draftOf(text: string, extra: { readonly sending?: boolean } = {}) {
  const state = { text, revision: 3, sending: extra.sending ?? false };
  const handle: ComposerDraftHandle = {
    read: () => ({ ...state }),
    clear: vi.fn((revision: number) => { if (revision === state.revision) state.text = ""; }),
    focus: vi.fn(),
  };
  return { state, handle };
}

describe("sendComposerText", () => {
  const unregister: (() => void)[] = [];
  const register = (theaterId: string, handle: ComposerDraftHandle) => { unregister.push(registerComposerDraft(theaterId, handle)); };
  afterEach(() => { for (const off of unregister.splice(0)) off(); });

  it("sends the trimmed text once and empties the box only after the send succeeds", async () => {
    const { state, handle } = draftOf("  carry this into development  ");
    register("c1", handle);
    const send = vi.fn(async () => { expect(handle.clear).not.toHaveBeenCalled(); });
    await expect(sendComposerText("c1", send)).resolves.toBe("sent");
    expect(send).toHaveBeenCalledExactlyOnceWith("carry this into development");
    expect(handle.clear).toHaveBeenCalledWith(3);
    expect(state.text).toBe("");
    expect(handle.focus).not.toHaveBeenCalled();
  });

  it("only moves focus to the box when it is empty", async () => {
    for (const text of ["", "  \n "]) {
      const { handle } = draftOf(text);
      register("c1", handle);
      const send = vi.fn(async () => undefined);
      await expect(sendComposerText("c1", send)).resolves.toBe("empty");
      expect(send).not.toHaveBeenCalled();
      expect(handle.clear).not.toHaveBeenCalled();
      expect(handle.focus).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the typed text when the send fails and does not overlap a message still sending", async () => {
    const failing = draftOf("keep me");
    register("c1", failing.handle);
    await expect(sendComposerText("c1", async () => { throw new Error("not_in_review"); })).rejects.toThrow("not_in_review");
    expect(failing.handle.clear).not.toHaveBeenCalled();
    expect(failing.state.text).toBe("keep me");
    const sending = draftOf("typed", { sending: true });
    register("c2", sending.handle);
    const send = vi.fn(async () => undefined);
    await expect(sendComposerText("c2", send)).resolves.toBe("busy");
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves text typed during the send in place", async () => {
    const { state, handle } = draftOf("first");
    register("c1", handle);
    await sendComposerText("c1", async () => { state.revision += 1; state.text = "first and more"; });
    expect(state.text).toBe("first and more");
  });

  it("does nothing without a composer standing for that Theater", async () => {
    const send = vi.fn(async () => undefined);
    await expect(sendComposerText("nowhere", send)).resolves.toBe("empty");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("ExtendAction in the decision line", () => {
  let host: HTMLDivElement;
  const roots: ReturnType<typeof createRoot>[] = [];
  const off: (() => void)[] = [];
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); extendObjective.mockReset(); extendObjective.mockResolvedValue(undefined); });
  afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); for (const stop of off.splice(0)) stop(); host.remove(); });

  const mount = (item: { readonly kind: "criteria" | "review" | "followup" | "ask"; readonly objectiveId: string | null }, onFailed = vi.fn()) => {
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(createElement(ExtendAction, { item, theaterId: "c1", language: "ko", onFailed })));
    return { onFailed, button: host.querySelector<HTMLButtonElement>("button") };
  };

  it("stands only on a handed review and reads 범위 넓히기", () => {
    expect(mount({ kind: "review", objectiveId: "o1" }).button?.textContent).toBe("범위 넓히기");
    for (const kind of ["criteria", "followup", "ask"] as const) {
      act(() => roots.at(-1)!.unmount()); roots.pop();
      expect(mount({ kind, objectiveId: "o1" }).button).toBeNull();
    }
    act(() => roots.at(-1)!.unmount()); roots.pop();
    expect(mount({ kind: "review", objectiveId: null }).button).toBeNull();
  });

  it("extends the objective with the composer text, then empties the box", async () => {
    const { state, handle } = draftOf("Expand with this design");
    off.push(registerComposerDraft("c1", handle));
    const { button } = mount({ kind: "review", objectiveId: "o1" });
    await act(async () => { button!.click(); });
    expect(extendObjective).toHaveBeenCalledExactlyOnceWith("o1", "ko", "Expand with this design");
    expect(state.text).toBe("");
    expect(handle.focus).not.toHaveBeenCalled();
    expect(button!.disabled).toBe(false);
  });

  it("sends nothing and only focuses the box when it is empty", async () => {
    const { handle } = draftOf("");
    off.push(registerComposerDraft("c1", handle));
    const { button } = mount({ kind: "review", objectiveId: "o1" });
    await act(async () => { button!.click(); });
    expect(extendObjective).not.toHaveBeenCalled();
    expect(handle.focus).toHaveBeenCalledTimes(1);
  });

  it("reports a failure through the line's own path and keeps the text", async () => {
    extendObjective.mockRejectedValue(new Error("not_in_review"));
    const { state, handle } = draftOf("Expand");
    off.push(registerComposerDraft("c1", handle));
    const { button, onFailed } = mount({ kind: "review", objectiveId: "o1" });
    await act(async () => { button!.click(); });
    expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ message: "not_in_review" }));
    expect(state.text).toBe("Expand");
  });
});
