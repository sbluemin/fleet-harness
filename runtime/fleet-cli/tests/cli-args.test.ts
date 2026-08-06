import { describe, expect, it } from "vitest";

import { buildFleetHelpText, parseFleetCliOptions } from "../src/cli-args.js";

describe("fleet CLI args", () => {
  it("passes every argument through by default", () => {
    expect(parseFleetCliOptions(["--model", "sonnet", "prompt"])).toEqual({
      help: false,
      passthroughArgs: ["--model", "sonnet", "prompt"],
    });
  });

  it("recognizes help only as the first argument", () => {
    expect(parseFleetCliOptions(["--help", "--verbose"])).toEqual({
      help: true,
      passthroughArgs: ["--verbose"],
    });
    expect(parseFleetCliOptions(["prompt", "--help"])).toEqual({
      help: false,
      passthroughArgs: ["prompt", "--help"],
    });
    expect(parseFleetCliOptions(["-h"])).toEqual({ help: true, passthroughArgs: [] });
  });

  it("documents the thin launcher and passthrough behavior", () => {
    const helpText = buildFleetHelpText({
      env: { NO_COLOR: "1" },
      isTTY: true,
      release: { version: "0.0.0-test", channel: "stable" },
    });

    expect(helpText).toContain("Fleet Harness");
    expect(helpText).toContain("USAGE");
    expect(helpText).toContain("fleet [claude args...]");
    expect(helpText).toContain("fleet auth login|list|logout");
    expect(helpText).toContain("fleet update");
    expect(helpText).toContain("-h, --help");
    expect(helpText).toContain("Unrecognized arguments are passed through to Claude Code.");
    expect(helpText).not.toContain("console");
    expect(helpText).not.toContain("desktop");
    expect(helpText).not.toContain("\x1b[");
  });
});
