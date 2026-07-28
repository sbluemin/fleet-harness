import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FleetPluginStorageHost } from "@fleet-console/sdk/plugin";
import { afterEach, describe, expect, it } from "vitest";

import { validateAgentCliPathForSave } from "../server/agent-api/agent-cli-detect.js";
import {
  AGENT_CLI_PATHS_STORAGE_KEY,
  applyAgentCliPathEnvOverlay,
  createAgentCliPathStore,
  resolveAgentCliBinary,
} from "../server/agent-api/agent-cli-paths.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Agent CLI path storage", () => {
  it("round-trips the versioned cliCommand schema and deletes empty values", async () => {
    let stored: unknown = null;
    const writes: Array<{ readonly pluginId: string; readonly key: string; readonly value: unknown }> = [];
    const storage = {
      readJson: async () => stored,
      writeJson: async (pluginId: string, key: string, value: unknown) => {
        stored = value;
        writes.push({ pluginId, key, value });
      },
    } as FleetPluginStorageHost;
    const store = createAgentCliPathStore(storage, "terminal");

    await store.writePath("claude", "/opt/homebrew/bin/claude");
    expect(await store.read()).toEqual({
      version: 1,
      paths: { claude: "/opt/homebrew/bin/claude" },
    });
    await store.writePath("claude", "");
    expect(await store.read()).toEqual({ version: 1, paths: {} });
    expect(writes.at(-1)).toEqual({
      pluginId: "terminal",
      key: AGENT_CLI_PATHS_STORAGE_KEY,
      value: { version: 1, paths: {} },
    });
  });
});

describe("Agent CLI configured path validation", () => {
  it("returns path_not_absolute for relative paths, tilde paths, and NUL input", async () => {
    for (const candidate of ["bin/claude", "~/bin/claude", "/tmp/claude\0suffix"]) {
      expect((await validateAgentCliPathForSave(candidate)).error).toBe("path_not_absolute");
    }
  });

  it("returns path_not_found", async () => {
    expect((await validateAgentCliPathForSave("/definitely/missing/fleet-agent-cli")).error).toBe("path_not_found");
  });

  it("returns path_not_executable", async () => {
    if (process.platform === "win32") return;
    const executable = createFile("claude", 0o600);
    expect((await validateAgentCliPathForSave(executable)).error).toBe("path_not_executable");
  });

  it("returns path_not_file", async () => {
    const directory = createTemporaryDirectory();
    expect((await validateAgentCliPathForSave(directory)).error).toBe("path_not_file");
  });

  it("returns probe_failed without exposing raw output", async () => {
    const executable = createFile("claude", 0o700);
    const result = await validateAgentCliPathForSave(executable, process.env, async (bin, args) => {
      expect(bin).toBe(executable);
      expect(args).toEqual(["--version"]);
      return `unparseable output from ${executable}`;
    });
    expect(result).toEqual({ error: "probe_failed", version: null });
  });

  it("follows symlinks and returns only the parsed semver", async () => {
    if (process.platform === "win32") return;
    const executable = createFile("claude-real", 0o700);
    const symlink = path.join(path.dirname(executable), "claude");
    fs.symlinkSync(executable, symlink);
    const result = await validateAgentCliPathForSave(symlink, process.env, async () => "Claude Code 2.3.4 build /private/user");
    expect(result).toEqual({ error: null, version: "2.3.4" });
  });
});

describe("resolveAgentCliBinary", () => {
  it("uses env override before user path before PATH", () => {
    const directory = createTemporaryDirectory();
    const envBinary = createFileAt(directory, "env-claude");
    const userBinary = createFileAt(directory, "user-claude");
    createFileAt(directory, "claude");

    const envResult = resolveAgentCliBinary({
      cliCommand: "claude",
      env: { PATH: directory, CLAUDE_BIN: envBinary },
      userPaths: { claude: userBinary },
    });
    expect(envResult.resolved?.bin).toBe(envBinary);
    expect(envResult.source).toBe("env");

    const userResult = resolveAgentCliBinary({
      cliCommand: "claude",
      env: { PATH: directory },
      userPaths: { claude: userBinary },
    });
    expect(userResult.resolved?.bin).toBe(userBinary);
    expect(userResult.source).toBe("user");

    const pathResult = resolveAgentCliBinary({
      cliCommand: "claude",
      env: { PATH: directory },
      userPaths: {},
    });
    expect(pathResult.resolved?.bin).toBe(path.join(directory, "claude"));
    expect(pathResult.source).toBe("path");
    expect(pathResult.searchedPathEntries).toEqual([directory]);
  });

  it("does not fall back when a configured higher-priority source is invalid", () => {
    const directory = createTemporaryDirectory();
    const pathBinary = createFileAt(directory, "claude");
    const userBinary = createFileAt(directory, "user-claude");

    const invalidEnv = resolveAgentCliBinary({
      cliCommand: "claude",
      env: { PATH: directory, CLAUDE_BIN: path.join(directory, "missing") },
      userPaths: { claude: userBinary },
    });
    expect(invalidEnv).toMatchObject({ resolved: undefined, source: "env", error: "path_not_found" });

    const invalidUser = resolveAgentCliBinary({
      cliCommand: "claude",
      env: { PATH: directory },
      userPaths: { claude: path.join(directory, "missing") },
    });
    expect(invalidUser).toMatchObject({ resolved: undefined, source: "user", error: "path_not_found" });
    expect(pathBinary).toBe(path.join(directory, "claude"));
  });
});

describe("Agent CLI launch env overlay", () => {
  it("maps Claude variants to CLAUDE_BIN and does not overwrite existing env", () => {
    expect(applyAgentCliPathEnvOverlay({ PATH: "/usr/bin" }, "claude-kimi", { claude: "/custom/claude" })).toMatchObject({
      CLAUDE_BIN: "/custom/claude",
    });
    expect(applyAgentCliPathEnvOverlay({ CLAUDE_BIN: "/managed/claude" }, "claude", { claude: "/custom/claude" })).toEqual({
      CLAUDE_BIN: "/managed/claude",
    });
  });

  it("does not invent launch env variables for detection-only CLIs", () => {
    expect(applyAgentCliPathEnvOverlay({}, "opencode", { opencode: "/custom/opencode" })).toEqual({});
    expect(applyAgentCliPathEnvOverlay({}, "cursor-agent", { "cursor-agent": "/custom/cursor-agent" })).toEqual({});
  });
});

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-cli-path-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createFile(name: string, mode: number): string {
  return createFileAt(createTemporaryDirectory(), name, mode);
}

function createFileAt(directory: string, name: string, mode = 0o700): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, "#!/bin/sh\n");
  fs.chmodSync(file, mode);
  return file;
}
