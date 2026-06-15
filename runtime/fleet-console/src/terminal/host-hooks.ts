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

export interface ConsoleHookCommandEntry {
  readonly entryPath: string;
  readonly execPath: string;
  readonly tsxLoaderPath?: string;
}

const JAVASCRIPT_ENTRY_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const TYPESCRIPT_ENTRY_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);
const MARKETPLACE_LOCK_DIR_SUFFIX = ".lock";

export function buildConsoleHookCommand(entry: ConsoleHookCommandEntry | undefined): FleetHookExec {
  if (entry === undefined) {
    throw new Error("Fleet Console session hook command requires the current console entry path");
  }
  const extension = path.extname(entry.entryPath);
  if (JAVASCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    return {
      command: entry.execPath,
      args: [entry.entryPath, "hook", "subagents-context"],
    };
  }
  if (TYPESCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    if (!entry.tsxLoaderPath) {
      throw new Error("Fleet Console session hook command for TypeScript entries requires a tsx loader path");
    }
    return {
      command: entry.execPath,
      args: ["--import", pathToFileURL(entry.tsxLoaderPath).href, entry.entryPath, "hook", "subagents-context"],
    };
  }
  throw new Error(`Unsupported Fleet Console session hook entry extension: ${extension}`);
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

export function withConsoleMarketplaceLock<T>(target: string, fn: () => T): T {
  const lockDir = `${target}${MARKETPLACE_LOCK_DIR_SUFFIX}`;
  mkdirSync(path.dirname(lockDir), { recursive: true });
  return withDirectoryLock({ lockDir }, fn);
}
