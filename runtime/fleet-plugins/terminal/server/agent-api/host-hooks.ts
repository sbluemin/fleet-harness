import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { FleetHookExec } from "@dotobokuri/fleet-admiral";
import { createSessionCaptureHookExec, type AgentCliId } from "@dotobokuri/fleet-admiral";
import { withDirectoryLock } from "@dotobokuri/core-infra";

export interface ConsoleHookCommandEntry {
  readonly entryPath: string;
  readonly execPath: string;
  readonly tsxLoaderPath?: string;
}

export type ConsoleCaptureProvider = "claude";

export type ConsoleTurnPhase = "start" | "end";

const JAVASCRIPT_ENTRY_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const TYPESCRIPT_ENTRY_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);
const PLUGIN_STORE_LOCK_DIR_SUFFIX = ".lock";

export function buildConsoleTurnHookCommand(entry: ConsoleHookCommandEntry, phase: ConsoleTurnPhase): FleetHookExec {
  return buildConsoleCliHookExec(entry, ["hook", phase === "start" ? "turn-start" : "turn-end"]);
}

export function buildConsoleBackgroundHookCommand(entry: ConsoleHookCommandEntry): FleetHookExec {
  return buildConsoleCliHookExec(entry, ["hook", "background-report"]);
}

export function buildConsoleAttentionHookCommand(entry: ConsoleHookCommandEntry): FleetHookExec {
  return buildConsoleCliHookExec(entry, ["hook", "attention"]);
}

export function buildConsoleAutoNameHookCommand(entry: ConsoleHookCommandEntry): FleetHookExec {
  return buildConsoleCliHookExec(entry, ["hook", "auto-name"]);
}

export function buildConsoleCaptureHookCommand(
  entry: ConsoleHookCommandEntry,
  cliId: AgentCliId,
  createCaptureHook: typeof createSessionCaptureHookExec = createSessionCaptureHookExec,
): FleetHookExec {
  const extension = path.extname(entry.entryPath);
  if (JAVASCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    return createCaptureHook({
      entryPath: entry.entryPath,
      execPath: entry.execPath,
      provider: toCaptureProvider(cliId),
    });
  }
  if (TYPESCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    if (!entry.tsxLoaderPath) {
      throw new Error("Fleet Console capture session hook requires a tsx loader path");
    }
    return createCaptureHook({
      entryPath: entry.entryPath,
      execPath: entry.execPath,
      provider: toCaptureProvider(cliId),
      tsxLoader: entry.tsxLoaderPath,
    });
  }
  throw new Error(`Unsupported Fleet Console session hook entry extension: ${extension}`);
}

export function toCaptureProvider(cliId: AgentCliId): ConsoleCaptureProvider {
  return "claude";
}

export function withConsolePluginStoreLock<T>(target: string, fn: () => T): T {
  const lockDir = `${target}${PLUGIN_STORE_LOCK_DIR_SUFFIX}`;
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
