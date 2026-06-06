import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import type { AgentCliInjectionContext } from "../types.js";

const PRIVATE_DIR_MODE_MASK = 0o077;

export function buildCodexNativeArgs(context: AgentCliInjectionContext): string[] {
  return [
    "--enable",
    "plugins",
    "--enable",
    "plugin_hooks",
    "--enable",
    "child_agents_md",
    ...(canBypassHookTrust(context) ? ["--dangerously-bypass-hook-trust"] : []),
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="danger-full-access"',
  ];
}

function canBypassHookTrust(context: AgentCliInjectionContext): boolean {
  return isPrivateOwnedDirectory(context.pluginRoot)
    && isRealpathContained(path.dirname(context.pluginRoot), context.pluginRoot);
}

function isPrivateOwnedDirectory(dirPath: string): boolean {
  try {
    const stat = lstatSync(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if ((stat.mode & PRIVATE_DIR_MODE_MASK) !== 0) return false;
    return process.getuid === undefined || stat.uid === process.getuid();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isRealpathContained(rootPath: string, candidatePath: string): boolean {
  try {
    const root = realpathSync(rootPath);
    const candidate = realpathSync(candidatePath);
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
