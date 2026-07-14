import { describe, expect, it, vi } from "vitest";

import { createTerminalCopyOnSelect } from "../client/shared/terminal-copy-on-select.js";

describe("createTerminalCopyOnSelect", () => {
  it("ignores an empty selection", () => {
    const harness = createHarness("");

    harness.primaryDown();
    harness.notifySelectionChange();
    harness.primaryUp();

    expect(harness.writeText).not.toHaveBeenCalled();
  });

  it("does not copy an unchanged selection after a primary gesture", () => {
    const harness = createHarness("already selected");

    harness.primaryDown();
    harness.primaryUp();

    expect(harness.writeText).not.toHaveBeenCalled();
  });

  it("ignores a secondary-button gesture even when the selection is non-empty", () => {
    const harness = createHarness("selection");

    harness.mouseDown(2);
    harness.notifySelectionChange();
    harness.mouseUp(2);

    expect(harness.writeText).not.toHaveBeenCalled();
  });

  it("coalesces repeated selection notifications into one copy after mouseup", () => {
    const harness = createHarness("selected text");

    harness.primaryDown();
    harness.notifySelectionChange();
    harness.notifySelectionChange();
    harness.primaryUp();

    expect(harness.writeText).toHaveBeenCalledTimes(1);
    expect(harness.writeText).toHaveBeenCalledWith("selected text");
  });

  it("cancels on blur and disposes its subscription and listeners", () => {
    const harness = createHarness("selected text");

    harness.primaryDown();
    harness.notifySelectionChange();
    harness.windowTarget.dispatchEvent(new Event("blur"));
    harness.primaryUp();
    expect(harness.writeText).not.toHaveBeenCalled();

    harness.controller.dispose();
    expect(harness.selectionSubscription.dispose).toHaveBeenCalledTimes(1);
    harness.primaryDown();
    harness.notifySelectionChange();
    harness.primaryUp();
    expect(harness.writeText).not.toHaveBeenCalled();
  });

  it("contains synchronous and asynchronous clipboard write failures", async () => {
    const synchronousFailure = createHarness("selected text", () => {
      throw new Error("blocked");
    });
    synchronousFailure.primaryDown();
    synchronousFailure.notifySelectionChange();
    expect(() => synchronousFailure.primaryUp()).not.toThrow();

    const asynchronousFailure = createHarness("selected text", () => Promise.reject(new Error("blocked")));
    asynchronousFailure.primaryDown();
    asynchronousFailure.notifySelectionChange();
    asynchronousFailure.primaryUp();
    await Promise.resolve();
    expect(asynchronousFailure.writeText).toHaveBeenCalledWith("selected text");
  });
});

function createHarness(selection: string, write = () => Promise.resolve()): {
  readonly controller: ReturnType<typeof createTerminalCopyOnSelect>;
  readonly mouseDown: (button: number) => void;
  readonly mouseUp: (button: number) => void;
  readonly primaryDown: () => void;
  readonly primaryUp: () => void;
  readonly notifySelectionChange: () => void;
  readonly selectionSubscription: { readonly dispose: ReturnType<typeof vi.fn> };
  readonly windowTarget: EventTarget;
  readonly writeText: ReturnType<typeof vi.fn>;
} {
  const selectionTarget = new EventTarget();
  const windowTarget = new EventTarget();
  const writeText = vi.fn(write);
  let onSelectionChange: (() => void) | undefined;
  const selectionSubscription = { dispose: vi.fn() };
  const controller = createTerminalCopyOnSelect({
    terminal: {
      getSelection: () => selection,
      onSelectionChange: (listener) => {
        onSelectionChange = listener;
        return selectionSubscription;
      },
    },
    selectionTarget,
    windowTarget,
    clipboard: { writeText },
  });
  const mouseDown = (button: number) => dispatchMouse(selectionTarget, "mousedown", button);
  const mouseUp = (button: number) => dispatchMouse(windowTarget, "mouseup", button);

  return {
    controller,
    mouseDown,
    mouseUp,
    primaryDown: () => mouseDown(0),
    primaryUp: () => mouseUp(0),
    notifySelectionChange: () => onSelectionChange?.(),
    selectionSubscription,
    windowTarget,
    writeText,
  };
}

function dispatchMouse(target: EventTarget, type: "mousedown" | "mouseup", button: number): void {
  const event = new Event(type);
  Object.defineProperty(event, "button", { value: button });
  target.dispatchEvent(event);
}
