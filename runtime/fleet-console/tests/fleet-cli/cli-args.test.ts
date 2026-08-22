import { describe, expect, it } from "vitest";

import { buildFleetHelpText, buildFleetVersionText, isFleetVersionArg, parseFleetCliOptions } from "../../cli/cli-args.js";

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
    expect(helpText).toContain("fleet <runtime> [command] [options]");
    expect(helpText).toContain("-h, --help");
    expect(helpText).toContain("-v, --version");
    expect(helpText).toContain("Unrecognized arguments are passed through to Claude Code.");
    expect(helpText).not.toContain("desktop");
    expect(helpText).not.toContain("\x1b[");
  });

  it("groups the runtimes, their commands, settings, and maintenance into four sections", () => {
    const helpText = buildFleetHelpText({
      env: { NO_COLOR: "1" },
      isTTY: true,
      release: { version: "0.0.0-test", channel: "stable" },
    });

    for (const heading of ["RUNTIME", "RUNTIME COMMANDS", "SETTINGS", "MAINTENANCE"]) {
      expect(helpText).toContain(heading);
    }
    // 런타임은 셋뿐이고, 각 런타임의 서브커맨드는 한 줄로 접힌 뒤 자기 --help로 넘긴다.
    expect(helpText).toContain("start · stop · restart · status");
    expect(helpText).toContain("serve · auth · models · status · set");
    expect(helpText).toContain("Run `fleet <runtime> --help`");
    expect(helpText).not.toContain("RUNTIME SUB COMMAND");
    expect(helpText).not.toContain("console start ");

    // SETTINGS는 명령이 아니라 설정 표면이다.
    expect(helpText).toContain("~/.fleet/settings.json");
    expect(helpText).toContain("~/.fleet/ai-gateway.json");
    expect(helpText).toContain("FLEET_DATA_DIR");
    expect(helpText).toContain("NO_COLOR");

    // 최상위 auth는 help에서 물러나고, 유지보수 동사만 남는다.
    expect(helpText).not.toContain("fleet auth login|list|logout");
    expect(helpText).toContain("Alias of `fleet console status`");
  });

  it("keeps the ordering that puts runtimes above maintenance", () => {
    const helpText = buildFleetHelpText({
      env: { NO_COLOR: "1" },
      isTTY: true,
      release: { version: "0.0.0-test", channel: "stable" },
    });
    const order = ["USAGE", "RUNTIME", "RUNTIME COMMANDS", "SETTINGS", "MAINTENANCE", "OPTIONS"]
      .map((heading) => helpText.indexOf(`\n${heading}`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });

  it("recognizes Fleet version tokens", () => {
    expect(isFleetVersionArg("--version")).toBe(true);
    expect(isFleetVersionArg("-v")).toBe(true);
    expect(isFleetVersionArg("version")).toBe(true);
    expect(isFleetVersionArg("--help")).toBe(false);
  });

  it("prints the Fleet package version, not Claude Code", () => {
    expect(buildFleetVersionText({ version: "1.62.0", channel: "local" })).toBe(
      "@dotobokuri/fleet-console 1.62.0 (local)\nClaude Code version: fleet cli --version\n",
    );
  });
});
