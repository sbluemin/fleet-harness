import { describe, expect, it } from "vitest";

import { createAgentCliDetector } from "../../fleet-plugins/terminal/server/agent-api/agent-cli-detect.js";

interface VersionCall {
  readonly bin: string;
  readonly args: readonly string[];
}

describe("agent cli detector", () => {
  it("reports the four distinct binaries in declaration order (zai/kimi/glm collapse into claude)", async () => {
    const detector = createAgentCliDetector({
      resolve: () => undefined,
      runVersion: async () => "",
    });
    const result = await detector.detect();
    expect(result.map((cli) => cli.id)).toEqual(["claude", "codex", "opencode", "cursor-agent"]);
    expect(result.map((cli) => cli.displayName)).toEqual(["Claude Code", "Codex CLI", "OpenCode", "Cursor Agent"]);
  });

  it("marks a resolvable binary available and parses its semver version", async () => {
    const detector = createAgentCliDetector({
      resolve: (command) => (command === "claude" ? { bin: "/usr/local/bin/claude", prefixArgs: [] } : undefined),
      runVersion: async () => "claude 2.1.0 (build 42)",
    });
    const result = await detector.detect();
    const claude = result.find((cli) => cli.id === "claude");
    expect(claude).toEqual({ id: "claude", displayName: "Claude Code", available: true, version: "2.1.0" });
  });

  it("marks an unresolvable binary unavailable with a null version and never probes it", async () => {
    const calls: VersionCall[] = [];
    const detector = createAgentCliDetector({
      resolve: () => undefined,
      runVersion: async (bin, args) => {
        calls.push({ bin, args });
        return "";
      },
    });
    const result = await detector.detect();
    expect(result.every((cli) => cli.available === false && cli.version === null)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("returns a null version (never raw stdout) when --version output has no semver, so paths cannot leak", async () => {
    const detector = createAgentCliDetector({
      resolve: (command) => (command === "claude" ? { bin: "/usr/local/bin/claude", prefixArgs: [] } : undefined),
      // 경로/사용자명을 포함하지만 semver는 없는 출력. 절대 그대로 노출되어선 안 된다.
      runVersion: async () => "claude installed at /Users/alice/.local/bin/claude",
    });
    const result = await detector.detect();
    const claude = result.find((cli) => cli.id === "claude");
    expect(claude?.available).toBe(true);
    expect(claude?.version).toBeNull();
  });

  it("extracts only the semver and drops any surrounding path in the --version output", async () => {
    const detector = createAgentCliDetector({
      resolve: (command) => (command === "claude" ? { bin: "/usr/local/bin/claude", prefixArgs: [] } : undefined),
      runVersion: async () => "claude 1.2.3 (/Users/alice/.local/bin/claude)",
    });
    const result = await detector.detect();
    expect(result.find((cli) => cli.id === "claude")?.version).toBe("1.2.3");
  });

  it("keeps a binary available with a null version when the version probe throws", async () => {
    const detector = createAgentCliDetector({
      resolve: (command) => (command === "codex" ? { bin: "/usr/local/bin/codex", prefixArgs: [] } : undefined),
      runVersion: async () => {
        throw new Error("spawn failed");
      },
    });
    const result = await detector.detect();
    const codex = result.find((cli) => cli.id === "codex");
    expect(codex?.available).toBe(true);
    expect(codex?.version).toBeNull();
  });

  it("threads Windows shim prefixArgs through to the version probe", async () => {
    const calls: VersionCall[] = [];
    const detector = createAgentCliDetector({
      resolve: (command) =>
        command === "claude"
          ? { bin: "C:\\Windows\\System32\\cmd.exe", prefixArgs: ["/d", "/s", "/c", "call", "C:\\npm\\claude.cmd "] }
          : undefined,
      runVersion: async (bin, args) => {
        calls.push({ bin, args });
        return "1.0.0";
      },
    });
    await detector.detect();
    expect(calls).toEqual([
      {
        bin: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", "call", "C:\\npm\\claude.cmd ", "--version"],
      },
    ]);
  });

  it("keeps Cursor Agent in the distinct binary catalog", async () => {
    const detector = createAgentCliDetector({
      resolve: (command) => (command === "cursor-agent" ? { bin: "/usr/local/bin/cursor-agent", prefixArgs: [] } : undefined),
      runVersion: async () => "2026.07.01-41b2de7",
    });
    const result = await detector.detect();
    expect(result.find((cli) => cli.id === "cursor-agent")).toEqual({
      id: "cursor-agent",
      displayName: "Cursor Agent",
      available: true,
      version: "2026.07.01",
    });
  });
});
