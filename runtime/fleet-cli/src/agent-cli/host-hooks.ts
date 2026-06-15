import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CodexCommandResult,
  CodexPluginRegistrationCommand,
  FleetHookExec,
} from "@dotobokuri/fleet-admiral";
import { withDirectoryLock } from "@dotobokuri/fleet-infra";

export interface FleetHookCommandEntry {
  readonly entryPath: string;
  readonly execPath: string;
  readonly tsxLoaderPath?: string;
}

const JAVASCRIPT_ENTRY_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const TYPESCRIPT_ENTRY_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);
const MARKETPLACE_LOCK_DIR_SUFFIX = ".lock";

export function buildFleetHookCommand(entry: FleetHookCommandEntry | undefined): FleetHookExec {
  if (entry === undefined) {
    throw new Error("Fleet session hook command requires the current Fleet entry path");
  }
  const extension = path.extname(entry.entryPath);
  if (JAVASCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    // exec form: 셸 인용이 없으므로 공백 포함 경로(예: C:\Program Files\nodejs\node.exe)도 그대로 안전하다.
    return {
      command: entry.execPath,
      args: [entry.entryPath, "hook", "subagents-context"],
    };
  }
  if (TYPESCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    if (!entry.tsxLoaderPath) {
      throw new Error("Fleet session hook command for TypeScript entries requires a tsx loader path");
    }
    // node --import는 Windows에서 절대경로(C:\...)를 c: URL scheme으로 오인하므로 file:// URL로 변환한다.
    return {
      command: entry.execPath,
      args: ["--import", pathToFileURL(entry.tsxLoaderPath).href, entry.entryPath, "hook", "subagents-context"],
    };
  }
  throw new Error(`Unsupported Fleet session hook entry extension: ${extension}`);
}

export function runCodexCommand(command: CodexPluginRegistrationCommand): CodexCommandResult {
  const result = spawnSync(command.bin, command.args, {
    cwd: command.cwd,
    encoding: "utf8",
    env: command.env,
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

export function withFleetMarketplaceLock<T>(target: string, fn: () => T): T {
  const lockDir = `${target}${MARKETPLACE_LOCK_DIR_SUFFIX}`;
  mkdirSync(path.dirname(lockDir), { recursive: true });
  return withDirectoryLock({ lockDir }, fn);
}
