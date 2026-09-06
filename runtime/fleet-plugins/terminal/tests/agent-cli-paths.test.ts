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

describe("Agent CLI configured path validation", () => {
  it("returns path_not_absolute for relative paths, tilde paths, and NUL input", async () => {
    for (const candidate of ["bin/claude", "~/bin/claude", "/tmp/claude\0suffix"]) {
      expect((await validateAgentCliPathForSave(candidate)).error).toBe("path_not_absolute");
    }
  });

  it("returns path_not_executable", async () => {
    if (process.platform === "win32") return;
    const executable = createFile("claude", 0o600);
    expect((await validateAgentCliPathForSave(executable)).error).toBe("path_not_executable");
  });
});

describe("resolveAgentCliBinary", () => {

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
