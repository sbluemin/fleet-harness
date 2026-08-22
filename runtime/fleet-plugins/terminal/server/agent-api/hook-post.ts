import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ConsoleHookPostOptions {
  readonly body: Record<string, unknown>;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly path: string;
  readonly timeoutMs: number;
}

interface ConsoleLockPayload {
  readonly endpoint: string;
  readonly token: string;
}

const LOCK_FILE_NAME = "console.lock";
const LOCK_DIR_NAME = "fleet-console";

export async function postConsoleAgentHook(options: ConsoleHookPostOptions): Promise<void> {
  const lock = readConsoleLock(options.env);
  if (!lock) return;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    await fetchImpl(`${lock.endpoint}plugins/terminal/agent${options.path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lock.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function readConsoleLock(env: NodeJS.ProcessEnv): ConsoleLockPayload | null {
  const lockFile = path.join(resolveConsoleRuntimeDir(env), LOCK_FILE_NAME);
  try {
    const stat = fs.lstatSync(lockFile);
    if (stat.isSymbolicLink()) return null;
    const payload = JSON.parse(fs.readFileSync(lockFile, "utf8")) as Partial<ConsoleLockPayload>;
    return typeof payload.endpoint === "string" && typeof payload.token === "string"
      ? { endpoint: payload.endpoint, token: payload.token }
      : null;
  } catch {
    return null;
  }
}

function resolveConsoleRuntimeDir(env: NodeJS.ProcessEnv): string {
  if (env.FLEET_CONSOLE_DIR) return env.FLEET_CONSOLE_DIR;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(os.tmpdir(), `${LOCK_DIR_NAME}-${uid}-stable`);
}
