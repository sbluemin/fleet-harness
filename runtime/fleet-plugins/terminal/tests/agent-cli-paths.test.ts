import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FleetPluginStorageHost } from "@fleet-console/sdk/plugin";
import { afterEach, describe, expect, it } from "vitest";

import { validateAgentCliPathForSave } from "../server/agent-api/agent-cli-detect.js";
import {
  AGENT_CLI_COMMANDS,
  AGENT_CLI_PATHS_STORAGE_KEY,
  agentCliCommandForId,
  applyAgentCliPathEnvOverlay,
  createAgentCliPathStore,
  normalizeAgentCliPaths,
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

  it("retains a legacy Codex path without restoring it to the detection catalog", () => {
    expect(AGENT_CLI_COMMANDS).not.toContain("codex");
    expect(normalizeAgentCliPaths({
      version: 1,
      paths: {
        claude: "/custom/claude",
        codex: "/custom/codex",
        removed: "/custom/removed",
      },
    })).toEqual({
      version: 1,
      paths: {
        claude: "/custom/claude",
        codex: "/custom/codex",
      },
    });
  });

  it("preserves both paths when separate store adapters write concurrently", async () => {
    let stored: unknown = null;
    const storage = {
      readJson: async () => stored,
      writeJson: async (_pluginId: string, _key: string, value: unknown) => {
        stored = value;
      },
    } as FleetPluginStorageHost;
    const firstStore = createAgentCliPathStore(storage, "terminal");
    const secondStore = createAgentCliPathStore(storage, "terminal");

    const claudeWrite = firstStore.writePath("claude", "/custom/bin/claude");
    const codexWrite = secondStore.writePath("codex", "/custom/bin/codex");
    await Promise.all([claudeWrite, codexWrite]);

    expect(await firstStore.read()).toEqual({
      version: 1,
      paths: {
        claude: "/custom/bin/claude",
        codex: "/custom/bin/codex",
      },
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
  it("maps canonical Gateway and Analyst provider IDs to the Claude command only", () => {
    expect(agentCliCommandForId("claude-gateway")).toBe("claude");
    expect(agentCliCommandForId("claude")).toBe("claude");
    expect(agentCliCommandForId("claude-native")).toBeNull();
    expect(agentCliCommandForId("unknown")).toBeNull();
  });

  it("maps Claude boundaries to CLAUDE_BIN and does not overwrite existing env", () => {
    expect(applyAgentCliPathEnvOverlay({ PATH: "/usr/bin" }, "claude-gateway", { claude: "/custom/claude" })).toMatchObject({
      CLAUDE_BIN: "/custom/claude",
    });
    expect(applyAgentCliPathEnvOverlay({ PATH: "/usr/bin" }, "claude", { claude: "/custom/claude" })).toMatchObject({
      CLAUDE_BIN: "/custom/claude",
    });
    expect(applyAgentCliPathEnvOverlay({ CLAUDE_BIN: "/managed/claude" }, "claude", { claude: "/custom/claude" })).toEqual({
      CLAUDE_BIN: "/managed/claude",
    });
  });

  it("does not invent launch env variables for detection-only CLIs", () => {
    expect(applyAgentCliPathEnvOverlay({}, "cursor-agent", { "cursor-agent": "/custom/cursor-agent" })).toEqual({});
  });
});

describe("Agent CLI launch resolution", () => {




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
