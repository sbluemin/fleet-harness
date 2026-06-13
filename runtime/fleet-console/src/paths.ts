import os from "node:os";
import path from "node:path";

export interface ConsolePaths {
  readonly dir: string;
  readonly lockFile: string;
}

export interface CreateConsolePathsDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly uid?: number;
}

const LOCK_DIR_NAME = "fleet-console";
const LOCK_FILE_NAME = "console.lock";

export function createConsolePaths(deps: CreateConsolePathsDeps = {}): ConsolePaths {
  const env = deps.env ?? process.env;
  const base = env.FLEET_CONSOLE_DIR ?? defaultConsoleBaseDir(deps);
  return { dir: base, lockFile: path.join(base, LOCK_FILE_NAME) };
}

function defaultConsoleBaseDir(deps: CreateConsolePathsDeps): string {
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  return path.join(os.tmpdir(), `${LOCK_DIR_NAME}-${uid}`);
}
