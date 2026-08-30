import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const packageRoot = path.resolve(import.meta.dirname, "../..");
const sourceScript = path.join(packageRoot, "scripts/probe-claude-codex-compact.mjs");

function runScript(scriptPath: string, ...args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: path.join(packageRoot, "credential-path-must-not-be-read"),
    },
  });
}

function copyScriptWithoutDist() {
  const directory = mkdtempSync(path.join(tmpdir(), "claude-codex-compact-probe-"));
  temporaryDirectories.push(directory);
  const scriptPath = path.join(directory, "probe-claude-codex-compact.mjs");
  copyFileSync(sourceScript, scriptPath);
  return { directory, scriptPath };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("Claude Code Codex compact probe", () => {
  it("shows help before loading dist, credentials, node-pty, or network code", () => {
    const fixture = copyScriptWithoutDist();
    const result = runScript(fixture.scriptPath, "--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("compaction_trigger");
    expect(result.stdout).toContain("real Luna quota");
    expect(result.stdout).toContain("Credentials, prompts, summaries, and opaque blobs are never written");
    const source = readFileSync(sourceScript, "utf8");
    expect(source).toContain('CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1"');
    expect(source).toContain("removeClaudeSessionArtifacts(sessionId)");
    expect(result.stderr).toBe("");
  });

  it("requires explicit live-provider consent before importing dist or reading credentials", () => {
    const fixture = copyScriptWithoutDist();
    const result = runScript(fixture.scriptPath, "--mode", "auto");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--confirm-live-provider");
    expect(result.stdout).toBe("");
  });

  it("rejects unsupported modes and non-Luna models as usage errors", () => {
    const unsupportedMode = runScript(sourceScript, "--mode", "fixture");
    expect(unsupportedMode.status).toBe(2);
    expect(unsupportedMode.stderr).toContain("auto, manual, or both");

    const wrongModel = runScript(
      sourceScript,
      "--model",
      "claude-gateway--codex--gpt-5.6-sol",
      "--confirm-live-provider",
    );
    expect(wrongModel.status).toBe(2);
    expect(wrongModel.stderr).toContain("gpt-5.6-luna");
  });
});
