// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const codexMocks = vi.hoisted(() => ({
  navigatorController: {
    destroy: vi.fn(),
    refreshLocale: vi.fn(),
    setTheater: vi.fn(),
  },
  readerController: {
    destroy: vi.fn(),
    navigateSub: vi.fn(async () => undefined),
    refreshCallbacks: vi.fn(),
    refreshLocale: vi.fn(async () => undefined),
    setEntry: vi.fn(async () => undefined),
  },
}));

vi.mock("../core/client/src/codex/main.js", () => ({
  mountNavigatorApp: vi.fn(() => codexMocks.navigatorController),
}));

vi.mock("../core/client/src/codex/reading-controller.js", () => ({
  mountReadingInto: vi.fn(() => codexMocks.readerController),
}));

import {
  mountNavigatorInto,
  mountReaderInto,
  saveReaderScroll,
  setNavigatorTheater,
  teardownCodex,
} from "../core/client/src/codex-host.js";

let requestAnimationFrameDescriptor: PropertyDescriptor | undefined;
let resizeObserverCallbacks: ResizeObserverCallback[] = [];
let resizeObserverDisconnects: ReturnType<typeof vi.fn>[] = [];

beforeEach(() => {
  requestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  teardownCodex();
  vi.clearAllMocks();
  document.body.replaceChildren();
  resizeObserverCallbacks = [];
  resizeObserverDisconnects = [];
  vi.stubGlobal("ResizeObserver", class {
    readonly disconnect = vi.fn();

    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallbacks.push(callback);
      resizeObserverDisconnects.push(this.disconnect);
    }

    observe(): void {}
    unobserve(): void {}
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
});

afterEach(() => {
  teardownCodex();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (requestAnimationFrameDescriptor) {
    Object.defineProperty(globalThis, "requestAnimationFrame", requestAnimationFrameDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  }
});

describe("Codex host in-memory state", () => {
  it("does not reset navigator state when the same workspace is assigned again", () => {
    const firstSlot = document.createElement("div");
    const secondSlot = document.createElement("div");
    document.body.append(firstSlot, secondSlot);

    mountNavigatorInto(firstSlot, "workspace-a");
    setNavigatorTheater("workspace-a");
    mountNavigatorInto(secondSlot, "workspace-a");
    setNavigatorTheater("workspace-a");

    expect(codexMocks.navigatorController.setTheater).toHaveBeenCalledTimes(1);
    expect(codexMocks.navigatorController.setTheater).toHaveBeenLastCalledWith("workspace-a");

    setNavigatorTheater("workspace-b");

    expect(codexMocks.navigatorController.setTheater).toHaveBeenCalledTimes(2);
    expect(codexMocks.navigatorController.setTheater).toHaveBeenLastCalledWith("workspace-b");
  });

  it("keeps the saved reader position when its previous slot was already detached", () => {
    const firstReadSlot = document.createElement("div");
    const firstTocSlot = document.createElement("div");
    const nextReadSlot = document.createElement("div");
    const nextTocSlot = document.createElement("div");
    document.body.append(firstReadSlot, firstTocSlot, nextReadSlot, nextTocSlot);
    const options = {
      initialEntryId: "entry-a",
      kind: "entry" as const,
      theaterId: "workspace-a",
      onRelatedClick: vi.fn(),
      onClose: vi.fn(),
    };

    mountReaderInto(firstReadSlot, firstTocSlot, options);
    firstReadSlot.scrollTop = 137;
    saveReaderScroll();
    firstReadSlot.remove();
    firstReadSlot.scrollTop = 0;

    mountReaderInto(nextReadSlot, nextTocSlot, options);

    expect(nextReadSlot.scrollTop).toBe(137);
  });

  it("reapplies the saved reader position after asynchronous content resize", () => {
    const { firstReadSlot, nextReadSlot } = mountRelocatedReader(1_400);
    expect(nextReadSlot.scrollTop).toBe(1_400);

    nextReadSlot.scrollTop = 996;
    triggerLatestResize();

    expect(nextReadSlot.scrollTop).toBe(1_400);
    expect(firstReadSlot.isConnected).toBe(false);
  });

  it("keeps restoring when a later resize follows a temporarily matching scroll position", () => {
    const { nextReadSlot } = mountRelocatedReader(1_400);
    triggerLatestResize();
    vi.advanceTimersByTime(200);
    expect(resizeObserverDisconnects.at(-1)).not.toHaveBeenCalled();

    nextReadSlot.scrollTop = 936;
    triggerLatestResize();

    expect(nextReadSlot.scrollTop).toBe(1_400);
    expect(resizeObserverDisconnects.at(-1)).not.toHaveBeenCalled();
  });

  it("cleans up only after the 400ms quiet window elapses", () => {
    mountRelocatedReader(1_800);
    triggerLatestResize();

    vi.advanceTimersByTime(399);
    expect(resizeObserverDisconnects.at(-1)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(resizeObserverDisconnects.at(-1)).toHaveBeenCalledOnce();
  });

  it("stops restoring as soon as the user scrolls", () => {
    const { nextReadSlot } = mountRelocatedReader(1_800);
    nextReadSlot.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    expect(resizeObserverDisconnects.at(-1)).toHaveBeenCalledOnce();

    nextReadSlot.scrollTop = 730;
    triggerLatestResize();

    expect(nextReadSlot.scrollTop).toBe(730);
  });
});

function mountRelocatedReader(scrollTop: number): {
  readonly firstReadSlot: HTMLDivElement;
  readonly nextReadSlot: HTMLDivElement;
} {
  const firstReadSlot = document.createElement("div");
  const firstTocSlot = document.createElement("div");
  const nextReadSlot = document.createElement("div");
  const nextTocSlot = document.createElement("div");
  document.body.append(firstReadSlot, firstTocSlot, nextReadSlot, nextTocSlot);
  const options = {
    initialEntryId: "entry-a",
    kind: "entry" as const,
    theaterId: "workspace-a",
    onRelatedClick: vi.fn(),
    onClose: vi.fn(),
  };

  mountReaderInto(firstReadSlot, firstTocSlot, options);
  firstReadSlot.scrollTop = scrollTop;
  saveReaderScroll();
  firstReadSlot.remove();
  mountReaderInto(nextReadSlot, nextTocSlot, options);
  return { firstReadSlot, nextReadSlot };
}

function triggerLatestResize(): void {
  const callback = resizeObserverCallbacks.at(-1);
  if (!callback) throw new Error("ResizeObserver callback not registered");
  callback([], {} as ResizeObserver);
}
