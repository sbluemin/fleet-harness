import { createInputKeybindingConfig, type RoutedMouseInput } from "../src/controls/index.js";
import { createCsiUInputNormalizer } from "../src/controls/index.js";
import { describe, expect, it } from "vitest";

import { createDedicatedMouseRouter } from "../src/controls/index.js";

describe("app keybinding composition", () => {
  it("does not reserve Fleet host global shortcuts", () => {
    const keybindings = createInputKeybindingConfig({});

    expect(keybindings.dispatch("\x03")).toBe(false);
    expect(keybindings.dispatch("\x11")).toBe(false);
    expect(keybindings.dispatch("\x14")).toBe(false);
    expect(keybindings.dispatch("\x1bo")).toBe(false);
  });

  it("does not dispatch removed Alt+O host bindings", () => {
    const keybindings = createInputKeybindingConfig({});
    const normalizer = createCsiUInputNormalizer({
      csiUMap: new Map(),
    });

    expect(keybindings.dispatch("\x1bo")).toBe(false);
    expect(keybindings.dispatch("\x1bO")).toBe(false);
    expect(keybindings.dispatch(normalizer.normalize("\x1b[111;3u"))).toBe(false);
    expect(keybindings.dispatch(normalizer.normalize("\x1b[79;3u"))).toBe(false);
  });
});

describe("dedicated mouse routing composition", () => {
  it("scrolls normal-buffer xterm scrollback when child mouse is off", () => {
    const writes: string[] = [];
    const scrolls: number[] = [];
    let renderRequests = 0;
    const routeMouse = createDedicatedMouseRouter({
      ptyHost: {
        getMouseProtocol: () => ({ activeEncoding: "default", activeProtocol: "none", mouseTrackingEnabled: false }),
        write: (data) => writes.push(data),
      },
      ptyView: {
        isAlternateBufferActive: () => false,
        scrollLines: (delta) => {
          scrolls.push(delta);
          return true;
        },
      },
      requestRender: () => {
        renderRequests += 1;
      },
    });

    expect(routeMouse(mouseEvent({ wheelDirection: "up" }))).toBe(true);

    expect(writes).toEqual([]);
    expect(scrolls).toEqual([-3]);
    expect(renderRequests).toBe(1);
  });

  it("writes arrow keys for alternate-buffer wheel when child mouse is off", () => {
    const writes: string[] = [];
    const routeMouse = createDedicatedMouseRouter({
      ptyHost: {
        getMouseProtocol: () => ({ activeEncoding: "default", activeProtocol: "none", mouseTrackingEnabled: false }),
        write: (data) => writes.push(data),
      },
      ptyView: {
        isAlternateBufferActive: () => true,
        scrollLines: () => false,
      },
      requestRender: () => undefined,
    });

    expect(routeMouse(mouseEvent({ wheelDirection: "down" }))).toBe(true);

    expect(writes).toEqual(["\x1b[B"]);
  });

  it("passes through re-encoded SGR mouse when child mouse is on", () => {
    const writes: string[] = [];
    const routeMouse = createDedicatedMouseRouter({
      ptyHost: {
        getMouseProtocol: () => ({ activeEncoding: "sgr", activeProtocol: "vt200", mouseTrackingEnabled: true }),
        write: (data) => writes.push(data),
      },
      ptyView: {
        isAlternateBufferActive: () => false,
        scrollLines: () => false,
      },
      requestRender: () => undefined,
    });

    expect(routeMouse(mouseEvent({ localRow: 2, row: 7, wheelDirection: "up" }))).toBe(true);

    expect(writes).toEqual(["\x1b[<64;4;2M"]);
  });

  it("forwards press, motion, release, and wheel events with local coordinates for app-mouse children", () => {
    const writes: string[] = [];
    const routeMouse = createDedicatedMouseRouter({
      ptyHost: {
        getMouseProtocol: () => ({ activeEncoding: "sgr", activeProtocol: "drag", dragTrackingEnabled: true, mouseTrackingEnabled: true }),
        write: (data) => writes.push(data),
      },
      ptyView: {
        isAlternateBufferActive: () => false,
        scrollLines: () => false,
      },
      requestRender: () => undefined,
    });

    routeMouse(mouseEvent({ buttonCode: 0, final: "M", localColumn: 2, localRow: 3, raw: "\x1b[<0;10;11M", wheelDirection: null }));
    routeMouse(mouseEvent({ buttonCode: 32, final: "M", localColumn: 3, localRow: 4, raw: "\x1b[<32;10;11M", wheelDirection: null }));
    routeMouse(mouseEvent({ buttonCode: 0, final: "m", localColumn: 4, localRow: 5, raw: "\x1b[<0;10;11m", wheelDirection: null }));
    routeMouse(mouseEvent({ buttonCode: 64, final: "M", localColumn: 5, localRow: 6, raw: "\x1b[<64;10;11M", wheelDirection: "up" }));

    expect(writes).toEqual([
      "\x1b[<0;2;3M",
      "\x1b[<32;3;4M",
      "\x1b[<0;4;5m",
      "\x1b[<64;5;6M",
    ]);
  });
});

function mouseEvent(overrides: Partial<RoutedMouseInput> = {}): RoutedMouseInput {
  return {
    buttonCode: 64,
    column: 4,
    final: "M",
    localColumn: 4,
    localRow: 1,
    raw: "\x1b[<64;4;1M",
    row: 1,
    wheelDirection: "up",
    ...overrides,
  };
}
