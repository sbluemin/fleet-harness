import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  assertInputContract,
  createInputKeybindingConfig,
  createInputRouter,
  createInputRouter as createRouter,
  encodeSgrMouseInput,
  parseSgrMouseInput,
} from "../../src/controls/input.js";

describe("input router keybinding injection", () => {
  it("routes injected exit, registered, and mode-toggle keybindings", () => {
    const events: string[] = [];
    const keybindings = createInputKeybindingConfig({
      exitKeys: ["exit"],
      modeToggleKeys: ["toggle"],
      registeredKeybindings: [
        {
          action: "custom",
          key: "custom",
          handler: () => events.push("custom"),
        },
      ],
    });
    const router = createInputRouter({
      initialMode: "MIRROR",
      keybindings,
      onExit: () => events.push("exit"),
      onModeChange: (mode) => events.push(`mode:${mode}`),
      toggleMode: () => "DEDICATED",
      writeDedicated: (data) => events.push(`write:${data}`),
    });

    router.route("custom");
    router.route("toggle");
    router.route("exit");

    assert.deepEqual(events, ["custom", "mode:DEDICATED", "exit"]);
    assert.equal(router.getMode(), "DEDICATED");
  });

  it("keeps non-keybinding input on the dedicated path", () => {
    const writes: string[] = [];
    const keybindings = createInputKeybindingConfig({
      exitKeys: ["exit"],
      modeToggleKeys: ["toggle"],
    });
    const router = createInputRouter({
      initialMode: "MIRROR",
      keybindings,
      onExit: () => undefined,
      onModeChange: () => undefined,
      toggleMode: (mode) => mode,
      writeDedicated: (data) => writes.push(data),
    });

    router.route("abc");

    assert.deepEqual(writes, ["abc"]);
  });

  it("parses SGR mouse input and decodes wheel directions", () => {
    assert.deepEqual(parseSgrMouseInput("\x1b[<64;10;3M"), {
      buttonCode: 64,
      column: 10,
      final: "M",
      raw: "\x1b[<64;10;3M",
      row: 3,
      wheelDirection: "up",
    });
    assert.equal(parseSgrMouseInput("\x1b[<65;10;3M")?.wheelDirection, "down");
  });

  it("re-encodes SGR mouse input with adjusted coordinates", () => {
    const event = parseSgrMouseInput("\x1b[<64;10;3M");

    if (event === null) {
      assert.fail("expected SGR mouse input");
    }
    assert.equal(encodeSgrMouseInput(event, { row: 2 }), "\x1b[<64;10;2M");
  });

  it("routes SGR mouse before keybinding dispatch using current pane geometry", () => {
    const events: string[] = [];
    const keybindings = createInputKeybindingConfig({
      exitKeys: ["exit"],
      modeToggleKeys: ["toggle"],
      registeredKeybindings: [
        {
          action: "mouse-looking-key",
          key: "\x1b[<64;2;2M",
          handler: () => events.push("keybinding"),
        },
      ],
    });
    const router = createRouter({
      getLayout: () => ({ columns: 20, dedicatedRows: 3, fleetRows: 2, totalRows: 5 }),
      initialMode: "MIRROR",
      keybindings,
      onExit: () => events.push("exit"),
      onModeChange: (mode) => events.push(`mode:${mode}`),
      routeDedicatedMouse: (event) => {
        events.push(`dedicated:${event.localColumn}:${event.localRow}:${event.wheelDirection}`);
        return true;
      },
      routeFleetMouse: (event) => {
        events.push(`fleet:${event.localColumn}:${event.localRow}:${event.wheelDirection}`);
        return true;
      },
      toggleMode: () => "DEDICATED",
      writeDedicated: (data) => events.push(`write:${data}`),
    });

    router.route("\x1b[<64;2;2M");
    router.route("\x1b[<65;2;4M");
    router.route("\x1b[<64;99;9M");

    assert.deepEqual(events, ["dedicated:2:2:up", "fleet:2:1:down"]);
  });

  it("rejects non-SGR and malformed mouse input without changing routing", () => {
    const writes: string[] = [];
    const keybindings = createInputKeybindingConfig({
      exitKeys: ["exit"],
      modeToggleKeys: ["toggle"],
    });
    const router = createInputRouter({
      initialMode: "MIRROR",
      keybindings,
      onExit: () => undefined,
      onModeChange: () => undefined,
      toggleMode: (mode) => mode,
      writeDedicated: (data) => writes.push(data),
    });

    assert.equal(parseSgrMouseInput("\x1b[A"), null);
    assert.equal(parseSgrMouseInput("\x1b[<64;10M"), null);
    router.route("\x1b[A");
    router.route("\x1b[<64;10M");

    assert.deepEqual(writes, ["\x1b[A", "\x1b[<64;10M"]);
  });

  it("detects conflicting injected keybindings", () => {
    const keybindings = createInputKeybindingConfig({
      exitKeys: ["same"],
      modeToggleKeys: ["same"],
    });

    assert.throws(() => assertInputContract(keybindings), /must not conflict/);
  });
});
