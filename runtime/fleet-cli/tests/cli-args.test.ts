import { describe, expect, it } from "vitest";

import { buildFleetHelpText, parseFleetCliOptions } from "../src/cli-args.js";

describe("fleet CLI args", () => {
  it("enables cursor sync by default", () => {
    expect(parseFleetCliOptions([], {}).cursorSync).toBe(true);
    expect(parseFleetCliOptions([], {}).nativeTerminal).toBe(false);
  });

  it("parses the cursor sync disable flag", () => {
    expect(parseFleetCliOptions(["--disable-cursor-sync"], {}).cursorSync).toBe(false);
  });

  it("parses the native terminal boot flag without changing cursor sync", () => {
    expect(parseFleetCliOptions(["--native"], {})).toMatchObject({
      cursorSync: true,
      nativeTerminal: true,
    });
    expect(parseFleetCliOptions(["--native", "--disable-cursor-sync"], {})).toMatchObject({
      cursorSync: false,
      nativeTerminal: true,
    });
  });

  it("parses the cursor sync environment off-switch without mutating process.env", () => {
    const before = { ...process.env };

    for (const off of ["0", "false", "no", "off"]) {
      expect(parseFleetCliOptions([], { FLEET_CURSOR_SYNC: off }).cursorSync).toBe(false);
    }
    for (const on of ["1", "true", "yes", "on", "anything-else"]) {
      expect(parseFleetCliOptions([], { FLEET_CURSOR_SYNC: on }).cursorSync).toBe(true);
    }
    expect(process.env).toEqual(before);
  });

  it("lets the disable flag override an enabling env value", () => {
    expect(parseFleetCliOptions(["--disable-cursor-sync"], { FLEET_CURSOR_SYNC: "1" })).toMatchObject({
      cursorSync: false,
    });
  });

  it("documents the cursor sync disable flag in help text", () => {
    const helpText = buildFleetHelpText({ env: { NO_COLOR: "1" }, isTTY: true, release: { version: "0.0.0-test", channel: "stable" } });

    expect(helpText).toContain("Fleet Harness");
    expect(helpText).toContain("USAGE");
    expect(helpText).toContain("COMMANDS");
    expect(helpText).toContain("OPTIONS");
    expect(helpText).toContain("auth");
    expect(helpText).toContain("wiki");
    expect(helpText).toContain("console");
    expect(helpText).toContain("Open Fleet Console, or manage the console server");
    expect(helpText).toContain("-h, --help");
    expect(helpText).toContain("--native");
    expect(helpText).toContain("Run the selected Agent CLI in the real terminal");
    expect(helpText).toContain("--disable-cursor-sync");
    expect(helpText).toContain("problematic IME cursor anchoring (or FLEET_CURSOR_SYNC=0)");
    expect(helpText).not.toContain("\x1b[");
    expect(helpText).not.toContain("fleet —");
  });

  it("rejects unknown flags", () => {
    expect(() => parseFleetCliOptions(["--unknown"], {})).toThrow("Unknown fleet option: --unknown");
  });
});
