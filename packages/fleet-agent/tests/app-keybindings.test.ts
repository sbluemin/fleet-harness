import { createKeybindingRegistry, type KeybindingDefinition, type RoutedMouseInput } from "@sbluemin/fleet-tui/input";
import { createCsiUInputNormalizer } from "@sbluemin/fleet-tui/pty";
import { describe, expect, it } from "vitest";

import { createDedicatedMouseRouter, createFleetHostInputKeybindingConfig } from "../src/app.js";

const TEST_HOST_KEYBINDINGS: readonly KeybindingDefinition[] = [
  { action: "host-exit", key: "\x11" },
  { action: "host-interrupt", key: "\x03" },
  { action: "mode-toggle", key: "\x14" },
  { action: "carrier-status", key: "\x1bo", normalizationAliases: ["\x1bO"] },
];

describe("app keybinding composition", () => {
  it("maps keybindings to Fleet host TUI handlers", () => {
    const events: string[] = [];
    const registry = createKeybindingRegistry({ definitions: TEST_HOST_KEYBINDINGS });
    const keybindings = createFleetHostInputKeybindingConfig({
      definitions: registry.list(),
      handlers: {
        "carrier-status": () => events.push("carrier-status"),
        "host-exit": () => events.push("exit"),
        "host-interrupt": () => events.push("interrupt"),
        "mode-toggle": () => events.push("mode-toggle"),
      },
    });

    expect(keybindings.exitKeys.has("\x03")).toBe(true);
    expect(keybindings.exitKeys.has("\x11")).toBe(true);
    expect(keybindings.modeToggleKeys.has("\x14")).toBe(true);
    expect(keybindings.dispatch("\x1bo")).toBe(true);
    expect(events).toEqual(["carrier-status"]);
  });

  it("normalizes CSI-u Alt+O to Carrier Status without activating Alt+Shift+O", () => {
    const events: string[] = [];
    const registry = createKeybindingRegistry({ definitions: TEST_HOST_KEYBINDINGS });
    const keybindings = createFleetHostInputKeybindingConfig({
      definitions: registry.list(),
      handlers: {
        "carrier-status": () => events.push("carrier-status"),
        "host-exit": () => events.push("exit"),
        "host-interrupt": () => events.push("interrupt"),
        "mode-toggle": () => events.push("mode-toggle"),
      },
    });
    const normalizer = createCsiUInputNormalizer({
      csiUMap: registry.createCsiUNormalizationMap(),
    });

    expect(keybindings.dispatch(normalizer.normalize("\x1b[111;3u"))).toBe(true);
    expect(keybindings.dispatch(normalizer.normalize("\x1b[79;3u"))).toBe(false);
    expect(events).toEqual(["carrier-status"]);
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
