import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CodexCommandResult,
  CodexPluginRegistrationCommand,
  FleetHookExec,
} from "@dotobokuri/fleet-admiral";
import { createSessionCaptureHookExec, type AgentCliId } from "@dotobokuri/fleet-admiral";
import { withDirectoryLock } from "@dotobokuri/fleet-infra";

export interface ConsoleHookCommandEntry {
  readonly entryPath: string;
  readonly execPath: string;
  readonly tsxLoaderPath?: string;
}

export type ConsoleCaptureProvider = "claude" | "codex";

export type ConsoleTurnPhase = "start" | "end";

const JAVASCRIPT_ENTRY_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const TYPESCRIPT_ENTRY_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);
const MARKETPLACE_LOCK_DIR_SUFFIX = ".lock";

export function buildConsoleHookCommand(entry: ConsoleHookCommandEntry | undefined): FleetHookExec {
  if (entry === undefined) {
    throw new Error("Fleet Console session hook command requires the current console entry path");
  }
  return buildConsoleCliHookExec(entry, ["hook", "subagents-context"]);
}

export function buildConsoleTurnHookCommand(entry: ConsoleHookCommandEntry, phase: ConsoleTurnPhase): FleetHookExec {
  return buildConsoleCliHookExec(entry, ["hook", phase === "start" ? "turn-start" : "turn-end"]);
}

export function buildConsoleAttentionHookCommand(entry: ConsoleHookCommandEntry): FleetHookExec {
  return buildConsoleCliHookExec(entry, ["hook", "attention"]);
}

export function buildConsoleAutoNameHookCommand(entry: ConsoleHookCommandEntry): FleetHookExec {
  return buildConsoleCliHookExec(entry, ["hook", "auto-name"]);
}

export function buildConsoleCaptureHookCommand(entry: ConsoleHookCommandEntry, cliId: AgentCliId): FleetHookExec {
  const extension = path.extname(entry.entryPath);
  if (JAVASCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    return createSessionCaptureHookExec({
      entryPath: entry.entryPath,
      execPath: entry.execPath,
      provider: toCaptureProvider(cliId),
    });
  }
  if (TYPESCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    if (!entry.tsxLoaderPath) {
      throw new Error("Fleet Console capture session hook requires a tsx loader path");
    }
    return createSessionCaptureHookExec({
      entryPath: entry.entryPath,
      execPath: entry.execPath,
      provider: toCaptureProvider(cliId),
      tsxLoader: entry.tsxLoaderPath,
    });
  }
  throw new Error(`Unsupported Fleet Console session hook entry extension: ${extension}`);
}

export function toCaptureProvider(cliId: AgentCliId): ConsoleCaptureProvider {
  return cliId === "codex" ? "codex" : "claude";
}

export function runCodexCommand(command: CodexPluginRegistrationCommand): CodexCommandResult {
  const result = spawnSync(command.bin, command.args, {
    cwd: command.cwd,
    encoding: "utf8",
    env: command.env,
    // 콘솔 없는 fleet-console 백엔드에서 codex 등록 명령 실행 시 콘솔 창이 깜빡이는 것을 방지한다.
    windowsHide: true,
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

function buildConsoleCliHookExec(entry: ConsoleHookCommandEntry, trailingArgs: readonly string[]): FleetHookExec {
  const extension = path.extname(entry.entryPath);
  if (JAVASCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    return {
      command: entry.execPath,
      args: [entry.entryPath, ...trailingArgs],
    };
  }
  if (TYPESCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    if (!entry.tsxLoaderPath) {
      throw new Error("Fleet Console session hook command for TypeScript entries requires a tsx loader path");
    }
    return {
      command: entry.execPath,
      args: ["--import", pathToFileURL(entry.tsxLoaderPath).href, entry.entryPath, ...trailingArgs],
    };
  }
  throw new Error(`Unsupported Fleet Console session hook entry extension: ${extension}`);
}
