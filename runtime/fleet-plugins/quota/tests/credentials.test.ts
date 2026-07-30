import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  defaultCredentialDeps,
  readBoundedFile,
  resolveClaudeCredentials,
  resolveCodexCredentials,
  type CredentialResolverDeps,
} from "../server/credentials.js";

function deps(overrides: Partial<CredentialResolverDeps> = {}): CredentialResolverDeps {
  return {
    platform: "linux",
    homedir: () => "/users/operator",
    env: {},
    readBounded: vi.fn(async () => JSON.stringify({ claudeAiOauth: { accessToken: "claude-token" } })),
    execFile: vi.fn(async () => ""),
    ...overrides,
  };
}

describe("credential resolvers", () => {
  it("uses the macOS keychain first and passes an argv array without a shell", async () => {
    const execFile = vi.fn(async () => JSON.stringify({
      claudeAiOauth: { accessToken: "secret", expiresAt: 9_000, subscriptionType: "max" },
    }));
    const readBounded = vi.fn(async () => "");
    const result = await resolveClaudeCredentials(deps({ platform: "darwin", execFile, readBounded }));
    expect(execFile).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 5_000 },
    );
    expect(readBounded).not.toHaveBeenCalled();
    expect(result).toEqual({ accessToken: "secret", expiresAt: 9_000, subscriptionType: "max", method: "keychain" });
  });

  it("falls back to CLAUDE_CONFIG_DIR on macOS when keychain lookup fails", async () => {
    const readBounded = vi.fn(async () => JSON.stringify({ accessToken: "fallback" }));
    const result = await resolveClaudeCredentials(deps({
      platform: "darwin",
      env: { CLAUDE_CONFIG_DIR: "/custom/claude" },
      execFile: vi.fn(async () => { throw new Error("denied"); }),
      readBounded,
    }));
    expect(readBounded).toHaveBeenCalledWith(path.join("/custom/claude", ".credentials.json"), 65_536);
    expect(result?.method).toBe("file");
  });

  it("never spawns security on win32 and uses path.join with the home directory", async () => {
    const execFile = vi.fn(async () => "");
    const readBounded = vi.fn(async () => JSON.stringify({ claudeAiOauth: { accessToken: "win-token" } }));
    await resolveClaudeCredentials(deps({
      platform: "win32",
      homedir: () => "C:\\Users\\operator",
      execFile,
      readBounded,
    }));
    expect(execFile).not.toHaveBeenCalled();
    expect(readBounded).toHaveBeenCalledWith(path.join("C:\\Users\\operator", ".claude", ".credentials.json"), 65_536);
  });

  it("reads Codex auth from CODEX_HOME and extracts only the required fields", async () => {
    const readBounded = vi.fn(async () => JSON.stringify({
      tokens: { access_token: "codex-token", account_id: "account" },
    }));
    const result = await resolveCodexCredentials(deps({ env: { CODEX_HOME: "/custom/codex" }, readBounded }));
    expect(readBounded).toHaveBeenCalledWith(path.join("/custom/codex", "auth.json"), 65_536);
    expect(result).toEqual({ accessToken: "codex-token", accountId: "account" });
  });

  it("treats missing and malformed files as signed-out inputs", async () => {
    await expect(resolveClaudeCredentials(deps({ readBounded: vi.fn(async () => { throw new Error("missing"); }) }))).resolves.toBeNull();
    await expect(resolveCodexCredentials(deps({ readBounded: vi.fn(async () => "{") }))).resolves.toBeNull();
  });

  it("treats a bounded reader's oversized-file result as signed out", async () => {
    const readBounded = vi.fn(async () => null);
    const result = await resolveClaudeCredentials(deps({ readBounded }));
    expect(result).toBeNull();
    expect(readBounded).toHaveBeenCalledWith(
      path.join("/users/operator", ".claude", ".credentials.json"),
      65_536,
    );
  });

  it("bounds injected results and macOS keychain output", async () => {
    const oversized = "x".repeat(65_537);
    await expect(resolveCodexCredentials(deps({ readBounded: vi.fn(async () => oversized) }))).resolves.toBeNull();
    const fileFallback = vi.fn(async () => JSON.stringify({ accessToken: "fallback" }));
    await expect(resolveClaudeCredentials(deps({
      platform: "darwin",
      execFile: vi.fn(async () => oversized),
      readBounded: fileFallback,
    }))).resolves.toMatchObject({ accessToken: "fallback", method: "file" });
    expect(fileFallback).toHaveBeenCalledOnce();
  });

  it("uses only injected bounded I/O in resolver tests", async () => {
    const defaultRead = vi.spyOn(defaultCredentialDeps, "readBounded");
    try {
      await resolveClaudeCredentials(deps());
      expect(defaultRead).not.toHaveBeenCalled();
    } finally {
      defaultRead.mockRestore();
    }
  });
});

describe.skipIf(process.platform === "win32")("bounded credential reads on POSIX paths", () => {
  it("rejects a writer-less FIFO instead of blocking on open", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quota-fifo-"));
    const fifoPath = path.join(dir, "auth.json");
    try {
      await promisify(nodeExecFile)("mkfifo", [fifoPath]);
      const result = await Promise.race([
        readBoundedFile(fifoPath, 65_536),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
      ]);
      expect(result).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a regular credential file through the default bounded reader", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quota-file-"));
    const filePath = path.join(dir, "auth.json");
    try {
      await fs.writeFile(filePath, JSON.stringify({ tokens: { access_token: "value" } }), "utf8");
      await expect(readBoundedFile(filePath, 65_536))
        .resolves.toBe(JSON.stringify({ tokens: { access_token: "value" } }));
      await expect(readBoundedFile(filePath, 4)).resolves.toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
