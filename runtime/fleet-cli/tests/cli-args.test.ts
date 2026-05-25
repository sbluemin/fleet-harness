import { describe, expect, it } from "vitest";

import { FLEET_HELP_TEXT, parseFleetCliOptions } from "../src/cli-args.js";

describe("fleet CLI args", () => {
  it("enables cursor sync by default", () => {
    expect(parseFleetCliOptions([], {}).cursorSync).toBe(true);
  });

  it("parses the cursor sync disable flag", () => {
    expect(parseFleetCliOptions(["--disable-cursor-sync"], {}).cursorSync).toBe(false);
  });

  it("parses the cursor sync environment off-switch without mutating process.env", () => {
    const before = { ...process.env };

    expect(parseFleetCliOptions([], { FLEET_CURSOR_SYNC: "0" }).cursorSync).toBe(false);
    expect(parseFleetCliOptions([], { FLEET_CURSOR_SYNC: "false" }).cursorSync).toBe(false);
    expect(parseFleetCliOptions([], { FLEET_CURSOR_SYNC: "1" }).cursorSync).toBe(true);
    expect(process.env).toEqual(before);
  });

  it("documents the cursor sync disable flag in help text", () => {
    expect(FLEET_HELP_TEXT).toContain("Fleet Agent Options:");
    expect(FLEET_HELP_TEXT).toContain("--disable-cursor-sync");
  });

  it("rejects unknown flags", () => {
    expect(() => parseFleetCliOptions(["--unknown"], {})).toThrow("Unknown fleet option: --unknown");
  });
});
