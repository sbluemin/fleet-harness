import { describe, expect, it, vi } from "vitest";

import type { CdpClient } from "./cdp.js";
import { describeDomKey, isImeKeyEvent, macEditCommand, modifierBits, toCdpKeyParams } from "./keys.js";
import {
  applyRemoteInputBatch,
  applySelectChoice,
  createRemotePermissionBridge,
  createRemoteSelectRegistry,
  dispatchRemoteIme,
  dispatchRemoteKey,
  dispatchRemoteMouse,
  probeSelectTarget,
  RemoteInputError,
} from "./remote-input.js";

function fakeClient(responses: Record<string, (params: Record<string, unknown>) => Record<string, unknown>> = {}): { client: CdpClient; calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> } {
  const calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const client: CdpClient = {
    send: (async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      calls.push({ method, params, sessionId });
      const respond = responses[method];
      return (respond ? respond(params) : {}) as Record<string, unknown>;
    }) as CdpClient["send"],
    on: () => () => undefined,
    closed: new Promise<void>(() => undefined),
    close: async () => undefined,
  };
  return { client, calls };
}

describe("remote keys", () => {
  it("maps hangul mode keys and modifiers", () => {
    expect(describeDomKey("HangulMode", "Lang1", { alt: false, ctrl: false, meta: false, shift: false })).toMatchObject({ key: "HangulMode", code: "Lang1", keyCode: 21 });
    expect(describeDomKey("HanjaMode", "Lang2", { alt: false, ctrl: false, meta: false, shift: false })).toMatchObject({ key: "HanjaMode", keyCode: 25 });
    expect(modifierBits({ alt: true, ctrl: true, meta: true, shift: true })).toBe(15);
    expect(macEditCommand("a", { alt: false, ctrl: false, meta: true, shift: false })).toBe("selectAll");
    expect(macEditCommand("z", { alt: false, ctrl: false, meta: true, shift: true })).toBe("redo");
    expect(macEditCommand("a", { alt: false, ctrl: true, meta: false, shift: false })).toBeUndefined();
  });

  it("treats IME keys as IME-path only", () => {
    expect(isImeKeyEvent({ keyCode: 229 })).toBe(true);
    expect(isImeKeyEvent({ isComposing: true, keyCode: 65, key: "a" })).toBe(true);
    expect(isImeKeyEvent({ key: "Process" })).toBe(true);
    expect(isImeKeyEvent({ keyCode: 65, key: "a" })).toBe(false);
    expect(toCdpKeyParams(describeDomKey("a", "KeyA", { alt: false, ctrl: false, meta: false, shift: false }), { alt: false, ctrl: false, meta: false, shift: false })).toMatchObject({ text: "a", unmodifiedText: "a" });
  });
});

describe("remote mouse dispatch", () => {
  it("rounds coordinates and tracks press state like the agent path", async () => {
    const { client, calls } = fakeClient();
    const moved = await dispatchRemoteMouse(client, "sess", { kind: "mouse", type: "move", x: 10.6, y: 20.4, modifiers: { alt: false, ctrl: false, meta: false, shift: true } }, null);
    expect(moved).toBeNull();
    const pressed = await dispatchRemoteMouse(client, "sess", { kind: "mouse", type: "down", x: 11, y: 20, button: "right", modifiers: { alt: false, ctrl: false, meta: false, shift: false } }, moved);
    expect(pressed).toEqual({ button: "right", buttons: 2 });
    // 누른 채 움직이면 Chromium 이 button/buttons 로 드래그를 잇는다.
    await dispatchRemoteMouse(client, "sess", { kind: "mouse", type: "move", x: 12, y: 21, modifiers: { alt: false, ctrl: false, meta: false, shift: false } }, pressed);
    const released = await dispatchRemoteMouse(client, "sess", { kind: "mouse", type: "up", x: 12, y: 21, button: "right", modifiers: { alt: false, ctrl: false, meta: false, shift: false } }, pressed);
    expect(released).toBeNull();
    await dispatchRemoteMouse(client, "sess", { kind: "mouse", type: "wheel", x: 12, y: 21, deltaX: 3, deltaY: -120, modifiers: { alt: false, ctrl: false, meta: false, shift: false } }, null);
    expect(calls.map((call) => call.method)).toEqual([
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
    expect(calls[0]!.params).toMatchObject({ type: "mouseMoved", x: 11, y: 20, modifiers: 8, button: "none" });
    expect(calls[1]!.params).toMatchObject({ type: "mousePressed", button: "right", buttons: 2 });
    expect(calls[2]!.params).toMatchObject({ type: "mouseMoved", button: "right", buttons: 2 });
    expect(calls[3]!.params).toMatchObject({ type: "mouseReleased", button: "right" });
    expect(calls[4]!.params).toMatchObject({ type: "mouseWheel", deltaX: 3, deltaY: -120 });
  });
});

describe("remote key and IME dispatch", () => {
  it("sends keyDown with text and always closes with keyUp", async () => {
    const { client, calls } = fakeClient();
    const outcome = await dispatchRemoteKey(client, "sess", { kind: "key", type: "keyDown", key: "a", code: "KeyA", keyCode: 65, modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    expect(outcome).toBe("dispatched");
    expect(calls.map((call) => `${call.method}:${(call.params as { type: string }).type}`)).toEqual([
      "Input.dispatchKeyEvent:keyDown",
      "Input.dispatchKeyEvent:keyUp",
    ]);
    expect(calls[0]!.params).toMatchObject({ text: "a", unmodifiedText: "a" });
  });

  it("defers IME composing keys to the IME path", async () => {
    const { client, calls } = fakeClient();
    const outcome = await dispatchRemoteKey(client, "sess", { kind: "key", type: "keyDown", key: "Process", code: "", keyCode: 229, modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    expect(outcome).toBe("ime-deferred");
    expect(calls).toHaveLength(0);
  });

  it("drives composition, commit, and cancel without duplication", async () => {
    const { client, calls } = fakeClient();
    await dispatchRemoteIme(client, "sess", { kind: "ime", type: "composition", text: "한" });
    await dispatchRemoteIme(client, "sess", { kind: "ime", type: "composition", text: "한글" });
    await dispatchRemoteIme(client, "sess", { kind: "ime", type: "commit", text: "한글" });
    await dispatchRemoteIme(client, "sess", { kind: "ime", type: "cancel" });
    expect(calls.map((call) => call.method)).toEqual([
      "Input.imeSetComposition",
      "Input.imeSetComposition",
      "Input.insertText",
      "Input.imeSetComposition",
    ]);
    expect(calls[1]!.params).toMatchObject({ text: "한글", selectionStart: 2, selectionEnd: 2 });
    expect(calls[2]!.params).toMatchObject({ text: "한글" });
  });
});

describe("remote batch application", () => {
  it("rejects invalid batches before touching the page", async () => {
    const { client, calls } = fakeClient();
    const hooks = { assertControl: vi.fn(), notePointer: vi.fn() };
    await expect(applyRemoteInputBatch(client, "sess", { tabId: "t", events: [] }, null, hooks)).rejects.toBeInstanceOf(RemoteInputError);
    expect(calls).toHaveLength(0);
    // 검증 실패는 페이지에 닿기 전 — 제어권 판정보다 먼저 걸러진다.
    expect(hooks.assertControl).not.toHaveBeenCalled();
  });

  it("keeps event order and skips the click when a select popup opens", async () => {
    const { client, calls } = fakeClient();
    const hooks = {
      assertControl: vi.fn(),
      notePointer: vi.fn(),
      interceptSelect: vi.fn(async () => ({ id: "sel-t-1", tabId: "t", rect: { x: 1, y: 2, width: 3, height: 4 }, multiple: false, options: [] })),
    };
    const { pointer, result } = await applyRemoteInputBatch(client, "sess", {
      tabId: "t",
      seq: 7,
      events: [
        { kind: "mouse", type: "move", x: 1, y: 2, modifiers: { alt: false, ctrl: false, meta: false, shift: false } },
        { kind: "mouse", type: "down", x: 1, y: 2, button: "left", modifiers: { alt: false, ctrl: false, meta: false, shift: false } },
        { kind: "key", type: "keyDown", key: "Enter", code: "Enter", modifiers: { alt: false, ctrl: false, meta: false, shift: false } },
        { kind: "key", type: "keyUp", key: "Enter", code: "Enter", modifiers: { alt: false, ctrl: false, meta: false, shift: false } },
        { kind: "ime", type: "commit", text: "한" },
      ],
    }, null, hooks);
    expect(pointer).toBeNull();
    expect(result.select?.id).toBe("sel-t-1");
    // down 은 팝업으로 바뀌어 보내지 않고, 나머지는 순서대로 닿는다.
    // 키 한 건은 keyDown+keyUp 두 번의 CDP 로 번진다.
    expect(calls.map((call) => `${call.method}:${(call.params as { type?: string }).type ?? ""}`)).toEqual([
      "Input.dispatchMouseEvent:mouseMoved",
      "Input.dispatchKeyEvent:keyDown",
      "Input.dispatchKeyEvent:keyUp",
      "Input.dispatchKeyEvent:keyDown",
      "Input.dispatchKeyEvent:keyUp",
      "Input.insertText:",
    ]);
    expect(result).toMatchObject({ dispatched: 4, imeDeferred: 0 });
  });
});

describe("remote select", () => {
  it("finds the select under the point without scrolled-page drift", async () => {
    const { client, calls } = fakeClient({
      "Runtime.evaluate": () => ({ result: { objectId: "obj-1" } }),
      "DOM.describeNode": () => ({ node: { backendNodeId: 42 } }),
      "Runtime.callFunctionOn": () => ({
        result: {
          value: {
            rect: { x: 1, y: 2, width: 30, height: 10 },
            multiple: true,
            disabled: false,
            options: [{ index: 0, label: "a", value: "a", disabled: false, selected: true }],
          },
        },
      }),
      "Runtime.releaseObject": () => ({}),
    });
    const hit = await probeSelectTarget(client, "sess", 10.7, 20.2);
    expect(hit).toMatchObject({ backendNodeId: 42, multiple: true });
    expect((calls[0]!.params as { expression: string }).expression).toContain("elementFromPoint(11, 20)");
    expect(calls.map((call) => call.method)).toEqual(["Runtime.evaluate", "DOM.describeNode", "Runtime.callFunctionOn", "Runtime.releaseObject"]);
  });

  it("applies the choice once and expires the popup", async () => {
    const now = { at: 0 };
    const registry = createRemoteSelectRegistry({ now: () => now.at, ttlMs: 100 });
    const popup = registry.open("t", "sess", {
      backendNodeId: 7,
      multiple: false,
      disabled: false,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      options: [],
    });
    const { client, calls } = fakeClient({
      "DOM.resolveNode": () => ({ objectId: "obj-9" }),
      "Runtime.callFunctionOn": (params) => {
        expect((params as { arguments: Array<{ value: unknown }> }).arguments[0]!.value).toEqual([1]);
        return { result: { value: { ok: true, selected: [1] } } };
      },
      "Runtime.releaseObject": () => ({}),
    });
    const first = await applySelectChoice(client, registry, popup.id, "t", [1], false);
    expect(first).toEqual({ applied: true, selected: [1] });
    // 같은 팝업으로 두 번 답하면 소진된다.
    const second = await applySelectChoice(client, registry, popup.id, "t", [1], false);
    expect(second).toEqual({ applied: false, reason: "select_expired" });
    expect(calls.map((call) => call.method)).toEqual(["DOM.resolveNode", "Runtime.callFunctionOn", "Runtime.releaseObject"]);

    const expired = registry.open("t", "sess", { backendNodeId: 8, multiple: false, disabled: false, rect: { x: 0, y: 0, width: 1, height: 1 }, options: [] });
    now.at = 10_000;
    const late = await applySelectChoice(client, registry, expired.id, "t", [0], false);
    expect(late).toEqual({ applied: false, reason: "select_expired" });
    expect(registry.sweep()).toBe(0);
  });
});

describe("remote permission bridge", () => {
  it("resolves allow and deny, and rejects unknown answers", async () => {
    const bridge = createRemotePermissionBridge({ timeoutMs: 50 });
    const waiting = bridge.request({ id: "p1", tabId: "t", origin: "https://example.com", permission: "geolocation" });
    expect(bridge.pending()).toHaveLength(1);
    expect(bridge.answer("nope", "t", true)).toBe(false);
    expect(bridge.answer("p1", "t", true)).toBe(true);
    await expect(waiting).resolves.toBe(true);

    const denied = bridge.request({ id: "p2", tabId: "t", origin: "https://example.com", permission: "camera" });
    expect(bridge.answer("p2", "t", false)).toBe(true);
    await expect(denied).resolves.toBe(false);
    expect(bridge.pending()).toHaveLength(0);
  });

  it("auto-denies when nobody answers in time", async () => {
    const bridge = createRemotePermissionBridge({ timeoutMs: 5 });
    await expect(bridge.request({ id: "p3", tabId: "t", origin: "https://example.com", permission: "microphone" })).resolves.toBe(false);
    expect(bridge.pending()).toHaveLength(0);
  });
});
