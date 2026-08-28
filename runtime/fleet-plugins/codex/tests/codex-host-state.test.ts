// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const codexMocks = vi.hoisted(() => ({
  readerMountOptions: [] as Array<{ onEntryRendered?: (entryId: string) => void }>,
  navigatorController: {
    destroy: vi.fn(),
    refreshHealth: vi.fn(),
    refreshLocale: vi.fn(),
    setCurrentEntry: vi.fn(),
    setTheater: vi.fn(),
  },
  readerController: {
    destroy: vi.fn(),
    getDocument: vi.fn(() => null),
    navigateSub: vi.fn(async () => undefined),
    refreshCallbacks: vi.fn(),
    refreshLocale: vi.fn(async () => undefined),
    refreshScrollSpy: vi.fn(),
    setEntry: vi.fn(async () => undefined),
  },
}));

vi.mock("../client/codex/main.js", () => ({
  mountNavigatorApp: vi.fn(() => codexMocks.navigatorController),
}));

vi.mock("../client/codex/reading-controller.js", () => ({
  mountReadingInto: vi.fn((_container: HTMLElement, options: { onEntryRendered?: (entryId: string) => void }) => {
    codexMocks.readerMountOptions.push(options);
    return codexMocks.readerController;
  }),
}));

import {
  getCodexReaderHistoryState,
  mountNavigatorInto,
  mountReaderInto,
  navigateCodexReaderHistory,
  refreshCodexHealth,
  restoreCodexReaderSession,
  saveReaderScroll,
  setNavigatorTheater,
  teardownCodex,
} from "../client/codex-host.js";

let requestAnimationFrameDescriptor: PropertyDescriptor | undefined;
let resizeObserverCallbacks: ResizeObserverCallback[] = [];
let resizeObserverDisconnects: ReturnType<typeof vi.fn>[] = [];

beforeEach(() => {
  requestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  teardownCodex();
  vi.clearAllMocks();
  codexMocks.readerMountOptions.length = 0;
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
  it("forwards explicit health refreshes to the mounted navigator", () => {
    mountNavigatorInto(document.body.appendChild(document.createElement("div")), "workspace-a");

    refreshCodexHealth();

    expect(codexMocks.navigatorController.refreshHealth).toHaveBeenCalledOnce();
  });

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

  it("reopens history entries and truncates the forward branch after a new entry", () => {
    const readSlot = document.createElement("div");
    const tocSlot = document.createElement("div");
    const dockSlot = document.createElement("div");
    document.body.append(readSlot, tocSlot, dockSlot);
    const requestEntry = vi.fn();
    const options = {
      initialEntryId: "entry-a",
      kind: "entry" as const,
      theaterId: "workspace-a",
      sessionTheaterId: "theater-a",
      onRelatedClick: requestEntry,
      onClose: vi.fn(),
    };

    mountNavigatorInto(document.body.appendChild(document.createElement("div")), "workspace-a");
    mountReaderInto(readSlot, tocSlot, dockSlot, options);
    mountReaderInto(readSlot, tocSlot, dockSlot, { ...options, initialEntryId: "entry-b" });
    mountReaderInto(readSlot, tocSlot, dockSlot, { ...options, initialEntryId: "entry-c" });
    expect(codexMocks.navigatorController.setCurrentEntry).toHaveBeenLastCalledWith("entry-c");
    expect(getCodexReaderHistoryState()).toEqual({ canGoBack: true, canGoForward: false });

    navigateCodexReaderHistory(-1);
    expect(requestEntry).toHaveBeenLastCalledWith("entry-b");
    mountReaderInto(readSlot, tocSlot, dockSlot, { ...options, initialEntryId: "entry-b" });
    expect(getCodexReaderHistoryState()).toEqual({ canGoBack: true, canGoForward: true });

    mountReaderInto(readSlot, tocSlot, dockSlot, { ...options, initialEntryId: "entry-d" });
    expect(getCodexReaderHistoryState()).toEqual({ canGoBack: true, canGoForward: false });
    navigateCodexReaderHistory(1);
    expect(requestEntry).toHaveBeenCalledTimes(1);
  });

  it("restores the saved entry without adding it to history", () => {
    localStorage.setItem(
      "fleet.codex.reader.session.theater-a",
      JSON.stringify({ entryId: "entry-restored", scrollTop: 240 }),
    );
    expect(restoreCodexReaderSession("theater-a")).toBe("entry-restored");

    const readSlot = document.createElement("div");
    const tocSlot = document.createElement("div");
    const dockSlot = document.createElement("div");
    document.body.append(readSlot, tocSlot, dockSlot);
    mountReaderInto(readSlot, tocSlot, dockSlot, {
      initialEntryId: "entry-restored",
      kind: "entry",
      theaterId: "workspace-a",
      sessionTheaterId: "theater-a",
      onRelatedClick: vi.fn(),
      onClose: vi.fn(),
    });

    expect(readSlot.scrollTop).toBe(240);
    expect(getCodexReaderHistoryState()).toEqual({ canGoBack: false, canGoForward: false });
  });

  it("resumes session scroll saving when a pending restore is superseded", () => {
    localStorage.setItem(
      "fleet.codex.reader.session.theater-a",
      JSON.stringify({ entryId: "entry-restored", scrollTop: 240 }),
    );
    expect(restoreCodexReaderSession("theater-a")).toBe("entry-restored");

    const readSlot = document.createElement("div");
    const tocSlot = document.createElement("div");
    const dockSlot = document.createElement("div");
    document.body.append(readSlot, tocSlot, dockSlot);
    const options = {
      kind: "entry" as const,
      theaterId: "workspace-a",
      sessionTheaterId: "theater-a",
      onRelatedClick: vi.fn(),
      onClose: vi.fn(),
    };
    mountReaderInto(readSlot, tocSlot, dockSlot, { ...options, initialEntryId: "entry-restored" });
    mountReaderInto(readSlot, tocSlot, dockSlot, { ...options, initialEntryId: "entry-new" });
    codexMocks.readerMountOptions.at(-1)?.onEntryRendered?.("entry-new");

    readSlot.scrollTop = 480;
    readSlot.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(500);

    // 확대 여부도 리더 세션의 일부다 — 새로고침이 화면 모드까지 되살린다.
    expect(JSON.parse(localStorage.getItem("fleet.codex.reader.session.theater-a") ?? "null")).toEqual({
      entryId: "entry-new",
      scrollTop: 480,
      expanded: false,
    });
  });

  it("keeps the saved reader position when its previous slot was already detached", () => {
    const firstReadSlot = document.createElement("div");
    const firstTocSlot = document.createElement("div");
    const firstDockSlot = document.createElement("div");
    const nextReadSlot = document.createElement("div");
    const nextTocSlot = document.createElement("div");
    const nextDockSlot = document.createElement("div");
    document.body.append(firstReadSlot, firstTocSlot, firstDockSlot, nextReadSlot, nextTocSlot, nextDockSlot);
    const options = {
      initialEntryId: "entry-a",
      kind: "entry" as const,
      theaterId: "workspace-a",
      sessionTheaterId: "theater-a",
      onRelatedClick: vi.fn(),
      onClose: vi.fn(),
    };

    mountReaderInto(firstReadSlot, firstTocSlot, firstDockSlot, options);
    firstReadSlot.scrollTop = 137;
    saveReaderScroll();
    firstReadSlot.remove();
    firstReadSlot.scrollTop = 0;

    mountReaderInto(nextReadSlot, nextTocSlot, nextDockSlot, options);

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

  it("stops restoring when an unmatched scroll has no resize within 150ms", () => {
    const { nextReadSlot } = mountRelocatedReader(1_400);
    vi.advanceTimersByTime(350);
    nextReadSlot.scrollTop = 936;
    nextReadSlot.dispatchEvent(new Event("scroll"));

    vi.advanceTimersByTime(149);
    expect(resizeObserverDisconnects.at(-1)).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resizeObserverDisconnects.at(-1)).toHaveBeenCalledOnce();

    nextReadSlot.scrollTop = 877;
    triggerLatestResize();
    expect(nextReadSlot.scrollTop).toBe(877);
  });

  it("keeps restoring when resize correlates with a scroll anchoring adjustment", () => {
    const { nextReadSlot } = mountRelocatedReader(1_800);
    nextReadSlot.scrollTop = 730;
    nextReadSlot.dispatchEvent(new Event("scroll"));
    triggerLatestResize();
    vi.advanceTimersByTime(150);

    expect(nextReadSlot.scrollTop).toBe(1_800);
    expect(resizeObserverDisconnects.at(-1)).not.toHaveBeenCalled();
  });

  it("stops restoring immediately when the TOC is clicked", () => {
    const { nextReadSlot, nextTocSlot } = mountRelocatedReader(1_400);
    nextTocSlot.firstElementChild?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(resizeObserverDisconnects.at(-1)).toHaveBeenCalledOnce();

    nextReadSlot.scrollTop = 936;
    triggerLatestResize();
    expect(nextReadSlot.scrollTop).toBe(936);
  });
});

function mountRelocatedReader(scrollTop: number): {
  readonly firstReadSlot: HTMLDivElement;
  readonly nextReadSlot: HTMLDivElement;
  readonly nextTocSlot: HTMLDivElement;
} {
  const firstReadSlot = document.createElement("div");
  const firstTocSlot = document.createElement("div");
  const firstDockSlot = document.createElement("div");
  const nextReadSlot = document.createElement("div");
  const nextTocSlot = document.createElement("div");
  const nextDockSlot = document.createElement("div");
  document.body.append(firstReadSlot, firstTocSlot, firstDockSlot, nextReadSlot, nextTocSlot, nextDockSlot);
  const options = {
    initialEntryId: "entry-a",
    kind: "entry" as const,
    theaterId: "workspace-a",
    sessionTheaterId: "theater-a",
    onRelatedClick: vi.fn(),
    onClose: vi.fn(),
  };

  mountReaderInto(firstReadSlot, firstTocSlot, firstDockSlot, options);
  firstReadSlot.scrollTop = scrollTop;
  saveReaderScroll();
  firstReadSlot.remove();
  mountReaderInto(nextReadSlot, nextTocSlot, nextDockSlot, options);
  return { firstReadSlot, nextReadSlot, nextTocSlot };
}

function triggerLatestResize(): void {
  const callback = resizeObserverCallbacks.at(-1);
  if (!callback) throw new Error("ResizeObserver callback not registered");
  callback([], {} as ResizeObserver);
}
