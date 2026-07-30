import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  resolveClaudeCredentials,
  resolveCodexCredentials,
  type CredentialResolverDeps,
} from "../server/credentials.js";

function deps(overrides: Partial<CredentialResolverDeps> = {}): CredentialResolverDeps {
  return {
    platform: "linux",
    homedir: () => "/users/operator",
    env: {},
    readFile: vi.fn(async () => JSON.stringify({ claudeAiOauth: { accessToken: "claude-token" } })),
    execFile: vi.fn(async () => ""),
    ...overrides,
  };
}

describe("credential resolvers", () => {
  it("uses the macOS keychain first and passes an argv array without a shell", async () => {
    const execFile = vi.fn(async () => JSON.stringify({
      claudeAiOauth: { accessToken: "secret", expiresAt: 9_000, subscriptionType: "max" },
    }));
    const readFile = vi.fn(async () => "");
    const result = await resolveClaudeCredentials(deps({ platform: "darwin", execFile, readFile }));
    expect(execFile).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 5_000 },
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(result).toEqual({ accessToken: "secret", expiresAt: 9_000, subscriptionType: "max", method: "keychain" });
  });

  it("falls back to CLAUDE_CONFIG_DIR on macOS when keychain lookup fails", async () => {
    const readFile = vi.fn(async () => JSON.stringify({ accessToken: "fallback" }));
    const result = await resolveClaudeCredentials(deps({
      platform: "darwin",
      env: { CLAUDE_CONFIG_DIR: "/custom/claude" },
      execFile: vi.fn(async () => { throw new Error("denied"); }),
      readFile,
    }));
    expect(readFile).toHaveBeenCalledWith(path.join("/custom/claude", ".credentials.json"), "utf8");
    expect(result?.method).toBe("file");
  });

  it("never spawns security on win32 and uses path.join with the home directory", async () => {
    const execFile = vi.fn(async () => "");
    const readFile = vi.fn(async () => JSON.stringify({ claudeAiOauth: { accessToken: "win-token" } }));
    await resolveClaudeCredentials(deps({
      platform: "win32",
      homedir: () => "C:\\Users\\operator",
      execFile,
      readFile,
    }));
    expect(execFile).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith(path.join("C:\\Users\\operator", ".claude", ".credentials.json"), "utf8");
  });

  it("reads Codex auth from CODEX_HOME and extracts only the required fields", async () => {
    const readFile = vi.fn(async () => JSON.stringify({
      tokens: { access_token: "codex-token", account_id: "account" },
    }));
    const result = await resolveCodexCredentials(deps({ env: { CODEX_HOME: "/custom/codex" }, readFile }));
    expect(readFile).toHaveBeenCalledWith(path.join("/custom/codex", "auth.json"), "utf8");
    expect(result).toEqual({ accessToken: "codex-token", accountId: "account" });
  });

  it("treats missing and malformed files as signed-out inputs", async () => {
    await expect(resolveClaudeCredentials(deps({ readFile: vi.fn(async () => { throw new Error("missing"); }) }))).resolves.toBeNull();
    await expect(resolveCodexCredentials(deps({ readFile: vi.fn(async () => "{") }))).resolves.toBeNull();
  });

  it("rejects oversized credential files before reading them", async () => {
    const readFile = vi.fn(async () => JSON.stringify({ accessToken: "must-not-read" }));
    const result = await resolveClaudeCredentials(deps({
      stat: vi.fn(async () => ({ size: 1_000_000 })),
      readFile,
    }));
    expect(result).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("bounds injected file reads and macOS keychain output without stat", async () => {
    const oversized = "x".repeat(65_537);
    await expect(resolveCodexCredentials(deps({ readFile: vi.fn(async () => oversized) }))).resolves.toBeNull();
    const fileFallback = vi.fn(async () => JSON.stringify({ accessToken: "fallback" }));
    await expect(resolveClaudeCredentials(deps({
      platform: "darwin",
      execFile: vi.fn(async () => oversized),
      readFile: fileFallback,
    }))).resolves.toMatchObject({ accessToken: "fallback", method: "file" });
    expect(fileFallback).toHaveBeenCalledOnce();
  });
});
