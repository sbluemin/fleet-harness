import { describe, expect, it } from "vitest";

import { buildHostShellCommand, buildPosixShellCommand } from "../src/agent-cli/builders/toml.js";

describe("agent CLI shell command builders", () => {
  it("quotes POSIX hook commands with single quotes", () => {
    expect(buildPosixShellCommand(["/opt/fleet node", "cli's.mjs"])).toBe("'/opt/fleet node' 'cli'\\''s.mjs'");
  });

  it("quotes Windows hook commands without POSIX single quotes", () => {
    const command = buildHostShellCommand(["C:\\Program Files\\nodejs\\node.exe", "cli.mjs", "hook&capture"], "win32");

    expect(command).toBe("\"C:\\Program Files\\nodejs\\node.exe\" \"cli.mjs\" \"hook&capture\"");
    expect(command).not.toContain("'");
  });
});
