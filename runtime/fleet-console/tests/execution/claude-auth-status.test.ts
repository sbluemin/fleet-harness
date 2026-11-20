import { describe, expect, it, vi } from "vitest";

import { authProbeEnv, probeClaudeAuth } from "../../features/execution/host/agent/claude-auth-status.js";

/** 실제 CLI를 띄우지 않는다 — 실행 함수와 config dir를 갈아 끼워 판정 규칙만 검증한다. */
const deps = (run: (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ readonly stdout: string }>, env: NodeJS.ProcessEnv = {}) => ({
  env,
  run,
  createConfigDir: async () => "/virtual/claude-config",
  removeConfigDir: async () => undefined,
});

describe("probeClaudeAuth", () => {
  it("reads loggedIn from auth status JSON instead of the exit code", async () => {
    const signedOut = vi.fn(async () => ({ stdout: '{"loggedIn":false,"authMethod":"none"}' }));
    expect(await probeClaudeAuth("/bin/claude", deps(signedOut))).toBe("signedout");
    expect(signedOut).toHaveBeenCalledWith("/bin/claude", ["auth", "status", "--json"], expect.any(Object));

    const signedIn = vi.fn(async () => ({ stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }));
    expect(await probeClaudeAuth("/bin/claude", deps(signedIn))).toBe("ready");
  });

  it("fails open when the probe cannot be read", async () => {
    const broken = vi.fn(async () => ({ stdout: "not json" }));
    expect(await probeClaudeAuth("/bin/claude", deps(broken))).toBe("ready");
    const crashed = vi.fn(async () => { throw new Error("ENOENT"); });
    expect(await probeClaudeAuth("/bin/claude", deps(crashed))).toBe("ready");
    expect(await probeClaudeAuth("/bin/claude", deps(async () => ({ stdout: "   " })))).toBe("ready");
  });

  it("runs in the chat child environment with an isolated config dir and the default keychain", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const run = vi.fn(async (_bin: string, _args: readonly string[], env: NodeJS.ProcessEnv) => { seen.push(env); return { stdout: '{"loggedIn":true}' }; });
    const inherited = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-test", FLEET_CONSOLE_SESSION_ID: "s-1", CLAUDE_CONFIG_DIR: "/real" };
    expect(await probeClaudeAuth("/bin/claude", deps(run, inherited))).toBe("ready");
    const env = seen[0]!;
    expect(env.CLAUDE_CONFIG_DIR).toBe("/virtual/claude-config");
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.FLEET_CONSOLE_SESSION_ID).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("builds the probe env from the chat child env without inherited credentials", () => {
    const env = authProbeEnv({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_MODEL: "m", KEEP: "yes" }, "/cfg");
    expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_SECURESTORAGE_CONFIG_DIR: "", KEEP: "yes" });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });
});
