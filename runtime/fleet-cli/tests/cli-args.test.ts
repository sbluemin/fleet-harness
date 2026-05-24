import { describe, expect, it } from "vitest";

import { FLEET_HELP_TEXT, parseFleetCliOptions } from "../src/cli-args.js";

describe("fleet CLI args", () => {
  it("enables cursor sync by default", () => {
    expect(parseFleetCliOptions([], {}).cursorSync).toBe(true);
  });

  it("parses the cursor sync disable flag", () => {
    expect(parseFleetCliOptions(["--disable-cursor-sync"], {}).cursorSync).toBe(false);
  });

  it("parses --model with a separate value", () => {
    expect(parseFleetCliOptions(["--model", "opus"], {}).model).toBe("opus");
  });

  it("parses --model=value", () => {
    expect(parseFleetCliOptions(["--model=sonnet"], {}).model).toBe("sonnet");
  });

  it("consumes model values that look like native flags", () => {
    const options = parseFleetCliOptions(["--model", "-n"], {});

    expect(options.model).toBe("-n");
    expect(options.native).toBe(false);
  });

  it("consumes model values that look like help flags", () => {
    const options = parseFleetCliOptions(["--model", "--help"], {});

    expect(options.model).toBe("--help");
    expect(options.help).toBe(false);
  });

  it("consumes model values that look like CLI selectors", () => {
    const options = parseFleetCliOptions(["--model", "--cli=claude"], {});

    expect(options.model).toBe("--cli=claude");
    expect(options.cliId).toBeUndefined();
  });

  it("parses separate and equals model values equivalently", () => {
    expect(parseFleetCliOptions(["--model=X"], {}).model).toBe("X");
    expect(parseFleetCliOptions(["--model", "X"], {}).model).toBe("X");
  });

  it("consumes CLI selector values that look like native flags", () => {
    const options = parseFleetCliOptions(["--cli", "-n"], {});

    expect(options.cliId).toBe("-n");
    expect(options.native).toBe(false);
  });

  it("parses CLI selector forms", () => {
    expect(parseFleetCliOptions(["--cli", "claude"], {}).cliId).toBe("claude");
    expect(parseFleetCliOptions(["-c", "codex"], {}).cliId).toBe("codex");
    expect(parseFleetCliOptions(["--cli=claude-kimi"], {}).cliId).toBe("claude-kimi");
    expect(parseFleetCliOptions(["-c=claude-zai"], {}).cliId).toBe("claude-zai");
  });

  it("leaves model undefined when omitted", () => {
    expect(parseFleetCliOptions([], {}).model).toBeUndefined();
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
    expect(FLEET_HELP_TEXT).toContain("Underlying CLI Options (forwarded to selected CLI):");
    expect(FLEET_HELP_TEXT).toContain("--disable-cursor-sync");
    expect(FLEET_HELP_TEXT).toContain("--model <name>");
  });
});
