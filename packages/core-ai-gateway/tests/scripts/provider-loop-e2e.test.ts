import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

const packageRoot = path.resolve(import.meta.dirname, "../..");
const sourceScript = path.join(packageRoot, "scripts/provider-loop-e2e.mjs");

function runScript(scriptPath: string, ...args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FLEET_GATEWAY_WIRE_LOG: path.join(packageRoot, "never-write-wire.jsonl"),
    },
  });
}

function copyScriptWithoutDist() {
  const directory = mkdtempSync(path.join(tmpdir(), "provider-loop-e2e-"));
  temporaryDirectories.push(directory);
  const scriptPath = path.join(directory, "provider-loop-e2e.mjs");
  copyFileSync(sourceScript, scriptPath);
  return { directory, scriptPath };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("provider loop runner", () => {
  it("shows help before loading build, credentials, or network", () => {
    const fixture = copyScriptWithoutDist();
    try {
      const result = runScript(fixture.scriptPath, "--help");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("pnpm --filter @dotobokuri/core-ai-gateway build");
      expect(result.stdout).toContain("real provider quota");
      expect(result.stdout).toContain("FLEET_GATEWAY_WIRE_LOG");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("requires confirmation before importing a missing dist or reading credentials", () => {
    const fixture = copyScriptWithoutDist();
    try {
      const result = runScript(
        fixture.scriptPath,
        "--model",
        "claude-gateway--cursor--auto",
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--confirm-live-provider");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects an exact-id mismatch before credentials or network", () => {
    const result = runScript(
      sourceScript,
      "--model",
      "claude-gateway--opencode--deepseek-v4-flash",
      "--confirm-live-provider",
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("exact discovery id");
    expect(result.stdout).toBe("");
  });

  it("rejects unknown input as a usage error", () => {
    const result = runScript(
      sourceScript,
      "--model",
      "claude-gateway--cursor--auto",
      "--bogus",
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown argument");
    expect(result.stdout).toBe("");
  });
});
