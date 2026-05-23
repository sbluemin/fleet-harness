import { createKeybindingRegistry, type KeybindingDefinition } from "@sbluemin/fleet-tui/input";
import { createCsiUInputNormalizer } from "@sbluemin/fleet-tui/pty";
import { describe, expect, it } from "vitest";

import { createFleetHostInputKeybindingConfig } from "../src/app.js";

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
