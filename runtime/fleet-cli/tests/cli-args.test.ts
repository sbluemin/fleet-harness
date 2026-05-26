import { describe, expect, it } from "vitest";

import { buildFleetHelpText, parseFleetCliOptions } from "../src/cli-args.js";

describe("fleet CLI args", () => {
  it("enables cursor sync by default", () => {
    expect(parseFleetCliOptions([], {}).cursorSync).toBe(true);
    expect(parseFleetCliOptions([], {}).cursorSyncExplicitlyEnabled).toBe(false);
  });

  it("parses the cursor sync disable flag", () => {
    expect(parseFleetCliOptions(["--disable-cursor-sync"], {}).cursorSync).toBe(false);
  });

  it("parses the cursor sync environment off-switch without mutating process.env", () => {
    const before = { ...process.env };

    expect(parseFleetCliOptions([], { FLEET_CURSOR_SYNC: "0" }).cursorSync).toBe(false);
    expect(parseFleetCliOptions([], { FLEET_CURSOR_SYNC: "false" }).cursorSync).toBe(false);
    expect(parseFleetCliOptions([], { FLEET_CURSOR_SYNC: "1" }).cursorSync).toBe(true);
    expect(parseFleetCliOptions([], { FLEET_CURSOR_SYNC: "1" }).cursorSyncExplicitlyEnabled).toBe(true);
    expect(parseFleetCliOptions([], { FLEET_CURSOR_SYNC: "true" }).cursorSyncExplicitlyEnabled).toBe(true);
    expect(process.env).toEqual(before);
  });

  it("does not treat disable flags as explicit cursor sync enablement", () => {
    expect(parseFleetCliOptions(["--disable-cursor-sync"], { FLEET_CURSOR_SYNC: "1" })).toMatchObject({
      cursorSync: false,
      cursorSyncExplicitlyEnabled: false,
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
    expect(helpText).toContain("-h, --help");
    expect(helpText).toContain("--disable-cursor-sync");
    expect(helpText).toContain("Claude Code on Windows defaults to disabled");
    expect(helpText).toContain("FLEET_CURSOR_SYNC=1 to override");
    expect(helpText).not.toContain("\x1b[");
    expect(helpText).not.toContain("fleet —");
  });

  it("rejects unknown flags", () => {
    expect(() => parseFleetCliOptions(["--unknown"], {})).toThrow("Unknown fleet option: --unknown");
  });
});
