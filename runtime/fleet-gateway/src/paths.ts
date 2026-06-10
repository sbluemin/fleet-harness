import os from "node:os";
import path from "node:path";

export interface GatewayPaths {
  readonly dir: string;
  readonly lockFile: string;
}

export interface CreateGatewayPathsDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
}

const LOCK_DIR_NAME = "fleet-gateway";
const LOCK_FILE_NAME = "gateway.lock";

export function createGatewayPaths(deps: CreateGatewayPathsDeps = {}): GatewayPaths {
  const env = deps.env ?? process.env;
  const base = env.FLEET_GATEWAY_DIR ?? defaultGatewayBaseDir(deps);
  return { dir: base, lockFile: path.join(base, LOCK_FILE_NAME) };
}

function defaultGatewayBaseDir(deps: CreateGatewayPathsDeps): string {
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  return path.join(os.tmpdir(), `${LOCK_DIR_NAME}-${uid}`);
}
