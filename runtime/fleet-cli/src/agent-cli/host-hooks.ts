import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import type {
  CodexCommandResult,
  CodexPluginRegistrationCommand,
} from "@dotobokuri/fleet-admiral";
import { withDirectoryLock } from "@dotobokuri/fleet-infra";

const MARKETPLACE_LOCK_DIR_SUFFIX = ".lock";

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
