import { createKeybindingRegistry, type KeybindingDefinition, type RoutedMouseInput } from "../src/controls/index.js";
import { createCsiUInputNormalizer } from "../src/controls/index.js";
import { describe, expect, it } from "vitest";

import { createFleetHostInputKeybindingConfig } from "../src/app.js";
import { createDedicatedMouseRouter } from "../src/controls/index.js";

const TEST_HOST_KEYBINDINGS: readonly KeybindingDefinition[] = [
  { action: "host-exit", key: "\x11" },
  { action: "host-interrupt", key: "\x03" },
  { action: "mode-toggle", key: "\x14" },
];

describe("app keybinding composition", () => {
  it("maps keybindings to Fleet host TUI handlers", () => {
    const events: string[] = [];
    const registry = createKeybindingRegistry({ definitions: TEST_HOST_KEYBINDINGS });
    const keybindings = createFleetHostInputKeybindingConfig({
      definitions: registry.list(),
      handlers: {
        "host-exit": () => events.push("exit"),
        "host-interrupt": () => events.push("interrupt"),
        "mode-toggle": () => events.push("mode-toggle"),
      },
    });

    expect(keybindings.exitKeys.has("\x03")).toBe(true);
    expect(keybindings.exitKeys.has("\x11")).toBe(true);
    expect(keybindings.modeToggleKeys.has("\x14")).toBe(true);
    expect(keybindings.dispatch("\x1bo")).toBe(false);
    expect(events).toEqual([]);
  });

  it("does not dispatch removed Alt+O host bindings", () => {
    const events: string[] = [];
    const registry = createKeybindingRegistry({ definitions: TEST_HOST_KEYBINDINGS });
    const keybindings = createFleetHostInputKeybindingConfig({
      definitions: registry.list(),
      handlers: {
        "host-exit": () => events.push("exit"),
        "host-interrupt": () => events.push("interrupt"),
        "mode-toggle": () => events.push("mode-toggle"),
      },
    });
    const normalizer = createCsiUInputNormalizer({
      csiUMap: registry.createCsiUNormalizationMap(),
    });

    expect(keybindings.dispatch("\x1bo")).toBe(false);
    expect(keybindings.dispatch("\x1bO")).toBe(false);
    expect(keybindings.dispatch(normalizer.normalize("\x1b[111;3u"))).toBe(false);
    expect(keybindings.dispatch(normalizer.normalize("\x1b[79;3u"))).toBe(false);
    expect(events).toEqual([]);
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
