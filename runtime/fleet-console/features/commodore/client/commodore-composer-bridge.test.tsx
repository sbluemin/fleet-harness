// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerComposerDraft, sendComposerText, type ComposerDraftHandle } from "./commodore-composer-bridge.js";

const extendObjective = vi.hoisted(() => vi.fn<(objectiveId: string, language: "en" | "ko", context: string) => Promise<void>>());
vi.mock("./board.js", () => ({ extendObjective }));

const { ExtendAction } = await import("./commodore-person-inbox.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 입력창이 맡긴 손잡이의 시험 대역 — 글과 표식을 들고, 예약(`sending`)과 비우기·초점 호출을 센다. */
function draftOf(text: string, extra: { readonly sending?: boolean } = {}) {
  const state = { text, revision: 3, sending: extra.sending ?? false };
  const handle: ComposerDraftHandle = {
    read: () => ({ ...state }),
    clear: vi.fn((revision: number) => { if (revision === state.revision) state.text = ""; }),
    focus: vi.fn(),
    reserve: vi.fn((on: boolean) => { state.sending = on; }),
  };
  return { state, handle };
}

// 입력창의 글을 가져가는 길의 독립한 방어들 — 한마디가 비면 보내지 않고, 보내는 동안 일반 전송과 겹치지 않으며, 실패하거나 이어 쓴 글은 지킨다.
describe("sendComposerText", () => {
  const unregister: (() => void)[] = [];
  const register = (theaterId: string, handle: ComposerDraftHandle) => { unregister.push(registerComposerDraft(theaterId, handle)); };
  afterEach(() => { for (const off of unregister.splice(0)) off(); });

  it("only moves focus to the box when it is empty", async () => {
    const { handle } = draftOf("  \n ");
    register("c1", handle);
    const send = vi.fn(async () => undefined);
    await expect(sendComposerText("c1", send)).resolves.toBe("empty");
    expect(send).not.toHaveBeenCalled();
    expect(handle.focus).toHaveBeenCalledTimes(1);
  });

  it("reserves the shared box while sending and releases it on success and on failure", async () => {
    const { state, handle } = draftOf("carry on");
    register("c1", handle);
    await sendComposerText("c1", async () => { expect(state.sending).toBe(true); });
    expect(state.sending).toBe(false);
    state.text = "carry on";
    await expect(sendComposerText("c1", async () => { throw new Error("not_in_review"); })).rejects.toThrow("not_in_review");
    expect(state.sending).toBe(false);
    // 실패한 글은 그대로 남는다.
    expect(state.text).toBe("carry on");
  });

  it("does not send over a message that is already sending", async () => {
    const { handle } = draftOf("typed", { sending: true });
    register("c1", handle);
    const send = vi.fn(async () => undefined);
    await expect(sendComposerText("c1", send)).resolves.toBe("busy");
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves text typed during the send in place", async () => {
    const { state, handle } = draftOf("first");
    register("c1", handle);
    await sendComposerText("c1", async () => { state.revision += 1; state.text = "first and more"; });
    expect(state.text).toBe("first and more");
  });
});

// 결정 한 줄의 단추는 검토 항목에서만 서고, 입력창의 글로 그 목표를 넓힌 뒤 입력창을 비운다.
describe("ExtendAction", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const off: (() => void)[] = [];
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); extendObjective.mockReset(); extendObjective.mockResolvedValue(undefined); });
  afterEach(() => { act(() => root.unmount()); for (const stop of off.splice(0)) stop(); host.remove(); });

  const mount = (kind: "criteria" | "review" | "followup" | "ask") => {
    act(() => root.render(createElement(ExtendAction, { item: { kind, objectiveId: "o1" }, theaterId: "c1", language: "ko", onFailed: vi.fn() })));
    return host.querySelector<HTMLButtonElement>("button");
  };

  it("stands only on a handed review", () => {
    expect(mount("review")).not.toBeNull();
    for (const kind of ["criteria", "followup", "ask"] as const) expect(mount(kind)).toBeNull();
  });

  it("extends the objective with the composer text, then empties the box", async () => {
    const { state, handle } = draftOf("Expand with this design");
    off.push(registerComposerDraft("c1", handle));
    const button = mount("review")!;
    await act(async () => { button.click(); });
    expect(extendObjective).toHaveBeenCalledExactlyOnceWith("o1", "ko", "Expand with this design");
    expect(state.text).toBe("");
  });
});
