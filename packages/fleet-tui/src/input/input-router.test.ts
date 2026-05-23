import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertInputContract } from "./conflict.js";
import { createInputKeybindingConfig } from "./keybindings.js";
import { createInputRouter } from "./input-router.js";

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

  it("detects conflicting injected keybindings", () => {
    const keybindings = createInputKeybindingConfig({
      exitKeys: ["same"],
      modeToggleKeys: ["same"],
    });

    assert.throws(() => assertInputContract(keybindings), /must not conflict/);
  });
});
