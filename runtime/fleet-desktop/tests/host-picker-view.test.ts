import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { createHostPickerView } from "../src/host-picker-view.js";

const PICKER_URL = "http://127.0.0.1:4310/console/?desktop-surface=host-picker";

class FakeContents extends EventEmitter {
  closed = false;
  focused = 0;
  loaded: string | null = null;
  failLoad = false;

  async loadURL(url: string): Promise<void> {
    this.loaded = url;
    if (this.failLoad) throw new Error("ERR_CONNECTION_REFUSED");
    this.emit("did-finish-load");
  }

  close(): void { this.closed = true; }
  focus(): void { this.focused += 1; }
}

/** 덮개가 실제로 화면을 가리는지·걷혔는지는 이 두 값이 전부다. */
function createHarness(options: { readonly failLoad?: boolean } = {}) {
  const trace: string[] = [];
  const contents = new FakeContents();
  contents.failLoad = options.failLoad === true;
  let visible: boolean | null = null;
  let bounds: { width: number; height: number } | null = null;
  const view = {
    webContents: contents,
    setVisible: (next: boolean) => { visible = next; trace.push(`visible:${next}`); },
    setBounds: (next: { width: number; height: number }) => { bounds = { width: next.width, height: next.height }; },
  };
  const children: unknown[] = [];
  const windowEvents = new EventEmitter();
  const mainContents = { focus: () => trace.push("main:focus") };
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    contentView: {
      addChildView: (child: unknown) => { children.push(child); trace.push("addChild"); },
      removeChildView: (child: unknown) => { children.splice(children.indexOf(child), 1); trace.push("removeChild"); },
    },
    on: (event: string, listener: () => void) => windowEvents.on(event, listener),
    off: (event: string, listener: () => void) => windowEvents.off(event, listener),
    webContents: mainContents,
  };

  let clock = 10_000;
  const picker = createHostPickerView({
    createView: () => { trace.push("createView"); return view as never; },
    window: () => window as never,
    confine: () => trace.push("confine"),
    attachBridge: () => trace.push("attachBridge"),
    log: (message) => trace.push(`log:${message}`),
    now: () => clock,
  });

  return {
    picker,
    trace,
    contents,
    children,
    windowEvents,
    isVisible: () => visible,
    getBounds: () => bounds,
    advance: (ms: number) => { clock += ms; },
  };
}

describe("host picker view", () => {
  it("keeps the cover invisible until the list has actually drawn", async () => {
    const harness = createHarness();

    await harness.picker.open(PICKER_URL);

    // 먼저 숨기고, 그린 뒤에 드러낸다 — 순서가 뒤집히면 빈 판이 한 프레임 보인다.
    expect(harness.trace.filter((entry) => entry.startsWith("visible:"))).toEqual(["visible:false", "visible:true"]);
    expect(harness.isVisible()).toBe(true);
    expect(harness.contents.loaded).toBe(PICKER_URL);
  });

  it("covers the whole window and follows it as it resizes", async () => {
    const harness = createHarness();

    await harness.picker.open(PICKER_URL);
    harness.windowEvents.emit("resize");

    expect(harness.getBounds()).toEqual({ width: 1200, height: 800 });
  });

  it("fences the list off before it is pointed anywhere", async () => {
    const harness = createHarness();

    await harness.picker.open(PICKER_URL);

    // 울타리와 다리가 적재보다 먼저다.
    expect(harness.trace.indexOf("confine")).toBeLessThan(harness.trace.indexOf("visible:true"));
    expect(harness.trace).toContain("attachBridge");
  });

  it("holds exactly one cover however many times it is asked", async () => {
    const harness = createHarness();

    await harness.picker.open(PICKER_URL);
    await harness.picker.open(PICKER_URL);

    expect(harness.trace.filter((entry) => entry === "createView")).toHaveLength(1);
    expect(harness.children).toHaveLength(1);
  });

  it("takes the cover down once, whatever path asks", async () => {
    const harness = createHarness();
    await harness.picker.open(PICKER_URL);

    harness.picker.close();
    harness.picker.close();

    expect(harness.trace.filter((entry) => entry === "removeChild")).toHaveLength(1);
    expect(harness.contents.closed).toBe(true);
    expect(harness.picker.isOpen()).toBe(false);
    // 손은 원래 보던 콘솔로 돌아간다.
    expect(harness.trace).toContain("main:focus");
    expect(harness.windowEvents.listenerCount("resize")).toBe(0);
  });

  it("does not leave a cover behind when its renderer dies", async () => {
    const harness = createHarness();
    await harness.picker.open(PICKER_URL);

    harness.contents.emit("render-process-gone");

    expect(harness.picker.isOpen()).toBe(false);
  });

  it("does not leave a cover behind when the list cannot be loaded", async () => {
    const harness = createHarness({ failLoad: true });

    await expect(harness.picker.open(PICKER_URL)).rejects.toThrow("ERR_CONNECTION_REFUSED");

    expect(harness.picker.isOpen()).toBe(false);
    expect(harness.contents.closed).toBe(true);
  });

  it("closes on Escape", async () => {
    const harness = createHarness();
    await harness.picker.open(PICKER_URL);

    harness.contents.emit("before-input-event", {}, { type: "keyDown", key: "Escape" });

    expect(harness.picker.isOpen()).toBe(false);
  });

  /**
   * 덮개 아래에 깔린 것은 남의 콘솔이다. 걷자마자 다시 소환되는 것은 사람의 손이 아니므로,
   * 그 화면의 스크립트가 신뢰 UI를 반복해 띄우는 길을 좁혀 둔다.
   */
  it("refuses to be summoned again the instant it was dismissed", async () => {
    const harness = createHarness();
    await harness.picker.open(PICKER_URL);
    harness.picker.close();

    await harness.picker.open(PICKER_URL);

    expect(harness.picker.isOpen()).toBe(false);
    expect(harness.trace.some((entry) => entry.startsWith("log:host picker reopen ignored"))).toBe(true);
  });

  it("opens again once the user has had a moment", async () => {
    const harness = createHarness();
    await harness.picker.open(PICKER_URL);
    harness.picker.close();
    harness.advance(1_000);

    await harness.picker.open(PICKER_URL);

    expect(harness.picker.isOpen()).toBe(true);
  });
});
