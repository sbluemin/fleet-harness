import { describe, expect, it } from "vitest";

import type { RemoteBrowserInputBatch } from "@fleet-console/protocol/desktop";

import {
  contentRect,
  createRemoteInputSender,
  formatRemoteChord,
  isComposingKey,
  matchesConsoleShortcut,
  toViewportPoint,
} from "../src/remote-browser-input.js";

describe("remote input geometry", () => {
  it("maps the full frame one to one", () => {
    const box = { x: 0, y: 0, width: 800, height: 600 };
    const css = { width: 800, height: 600 };
    expect(contentRect(box, css)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(toViewportPoint(123.6, 456.4, box, css)).toEqual({ x: 123.6, y: 456.4 });
  });

  it("letterboxes with top-center alignment like the stage frame", () => {
    // 요소 800x600 안에 CSS 800x400 프레임을 contain 으로 그리면 위에서부터 800x400 이 찬다.
    const box = { x: 0, y: 0, width: 800, height: 600 };
    const css = { width: 800, height: 400 };
    const content = contentRect(box, css, { x: "center", y: "top" });
    expect(content).toEqual({ x: 0, y: 0, width: 800, height: 400 });
    expect(toViewportPoint(400, 200, box, css, { x: "center", y: "top" })).toEqual({ x: 400, y: 200 });
    // 아래 여백을 찍으면 가장 가까운 콘텐츠 가장자리로 붙는다.
    expect(toViewportPoint(400, 590, box, css, { x: "center", y: "top" })).toEqual({ x: 400, y: 400 });
  });

  it("pillarboxes wide content and clamps outside points", () => {
    const box = { x: 10, y: 20, width: 400, height: 600 };
    const css = { width: 800, height: 600 };
    const content = contentRect(box, css);
    expect(content).toEqual({ x: 10, y: 170, width: 400, height: 300 });
    expect(toViewportPoint(-50, -50, box, css)).toEqual({ x: 0, y: 0 });
    expect(toViewportPoint(9999, 9999, box, css)).toEqual({ x: 800, y: 600 });
  });

  it("returns the origin for degenerate boxes", () => {
    expect(toViewportPoint(10, 10, { x: 0, y: 0, width: 0, height: 0 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 0 });
  });
});

describe("console shortcut guard", () => {
  it("formats the same chord as the execution side", () => {
    expect(formatRemoteChord({ meta: true, ctrl: false, alt: false, shift: true, code: "KeyP" }, "darwin")).toBe("Mod+Shift+KeyP");
    expect(formatRemoteChord({ meta: false, ctrl: true, alt: false, shift: false, code: "Space" }, "linux")).toBe("Mod+Space");
  });

  it("does not forward a registered shortcut", () => {
    const registered = new Set(["Mod+Shift+KeyP"]);
    expect(matchesConsoleShortcut({ meta: true, ctrl: false, alt: false, shift: true, code: "KeyP" }, registered, "darwin")).toBe(true);
    expect(matchesConsoleShortcut({ meta: true, ctrl: false, alt: false, shift: false, code: "KeyP" }, registered, "darwin")).toBe(false);
  });

  it("treats AltGr like the execution side", () => {
    const registered = new Set(["Mod+KeyE"]);
    expect(matchesConsoleShortcut({ meta: false, ctrl: true, alt: true, shift: false, code: "KeyE" }, registered, "linux")).toBe(false);
    expect(matchesConsoleShortcut({ meta: false, ctrl: true, alt: false, shift: false, code: "Space" }, new Set(["Ctrl+Space"]), "linux")).toBe(true);
  });

  it("classifies IME composing keys", () => {
    expect(isComposingKey({ keyCode: 229, isComposing: false, key: "Process" })).toBe(true);
    expect(isComposingKey({ keyCode: 0, isComposing: true, key: "a" })).toBe(true);
    expect(isComposingKey({ keyCode: 65, isComposing: false, key: "a" })).toBe(false);
  });
});

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("remote input sender", () => {
  it("coalesces moves to the latest and sums wheel deltas while inflight", async () => {
    const sent: RemoteBrowserInputBatch[] = [];
    const releasers: Array<() => void> = [];
    const sender = createRemoteInputSender({
      tabId: "tab-1",
      transport: {
        send: (batch) => new Promise<void>((resolve) => {
          sent.push(batch);
          releasers.push(resolve);
        }),
      },
    });
    sender.pushMouse({ kind: "mouse", type: "move", x: 10, y: 10, modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    expect(sent).toHaveLength(1);
    sender.pushMouse({ kind: "mouse", type: "move", x: 20, y: 20, modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    sender.pushMouse({ kind: "mouse", type: "move", x: 30, y: 30, modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    expect(sent).toHaveLength(1);
    releasers[0]!();
    await tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.events).toHaveLength(1);
    expect(sent[1]!.events[0]).toMatchObject({ kind: "mouse", type: "move", x: 30, y: 30 });
    releasers[1]!();
    await tick();

    // 휠은 전송 중인 동안 들어온 연속분을 델타 합산 1건으로 묶는다.
    sender.pushKey({ kind: "key", type: "keyDown", key: "Shift", code: "ShiftLeft", keyCode: 16, modifiers: { alt: false, ctrl: false, meta: false, shift: true } });
    expect(sent).toHaveLength(3);
    sender.pushMouse({ kind: "mouse", type: "wheel", x: 30, y: 30, deltaX: 0, deltaY: 10, modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    sender.pushMouse({ kind: "mouse", type: "wheel", x: 31, y: 31, deltaX: 0, deltaY: 20, modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    expect(sent).toHaveLength(3);
    releasers[2]!();
    await tick();
    expect(sent).toHaveLength(4);
    expect(sent[3]!.events).toHaveLength(1);
    expect(sent[3]!.events[0]).toMatchObject({ type: "wheel", deltaY: 30 });
    releasers[3]!();
    await tick();
  });

  it("preserves the order of discrete events across coalesced moves", async () => {
    const sent: RemoteBrowserInputBatch[] = [];
    const releasers: Array<() => void> = [];
    const order: string[] = [];
    const sender = createRemoteInputSender({
      tabId: "tab-1",
      transport: {
        send: (batch) => new Promise<void>((resolve) => {
          sent.push(batch);
          for (const event of batch.events) {
            if (event.kind === "mouse") order.push(`${event.type}@${event.x},${event.y}`);
            else if (event.kind === "key") order.push(`${event.type}:${event.key}`);
            else order.push(event.kind);
          }
          releasers.push(resolve);
        }),
      },
    });
    sender.pushMouse({ kind: "mouse", type: "move", x: 1, y: 1, modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    sender.pushMouse({ kind: "mouse", type: "down", x: 5, y: 5, button: "left", modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    sender.pushMouse({ kind: "mouse", type: "move", x: 6, y: 6, modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    sender.pushMouse({ kind: "mouse", type: "move", x: 7, y: 7, modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    sender.pushKey({ kind: "key", type: "keyDown", key: "a", code: "KeyA", keyCode: 65, modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    sender.pushMouse({ kind: "mouse", type: "up", x: 7, y: 7, button: "left", modifiers: { alt: false, ctrl: false, meta: false, shift: false } });
    // 첫 배치가 전송 중인 동안 들어온 move 2건은 끝의 1건으로만 묶이고, down·key·up 사이는 그대로다.
    for (const release of [...releasers]) {
      release();
      await tick();
    }
    expect(order).toEqual(["move@1,1", "down@5,5", "move@7,7", "keyDown:a", "up@7,7"]);
    expect(sent.map((batch) => batch.seq)).toEqual([1, 2]);
  });

  it("keeps working after a failed batch without resending it", async () => {
    const sent: RemoteBrowserInputBatch[] = [];
    let failNext = true;
    const sender = createRemoteInputSender({
      tabId: "tab-1",
      transport: {
        send: (batch) => {
          sent.push(batch);
          return failNext ? ((failNext = false), Promise.reject(new Error("offline"))) : Promise.resolve();
        },
      },
    });
    sender.pushFocus(true);
    await tick();
    sender.pushFocus(false);
    await tick();
    // 실패한 배치를 다시 보내면 focus 짝이 어긋나므로 버리고 다음부터 잇는다.
    expect(sent.map((batch) => batch.seq)).toEqual([1, 2]);
    expect(sent[1]!.events).toEqual([{ kind: "focus", focused: false }]);
  });
});
