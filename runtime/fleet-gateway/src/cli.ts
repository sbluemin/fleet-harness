import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import type { GatewayLockPayload } from "./api-types.js";
import { createGatewayHealthClient } from "./health.js";
import { createGatewayLock } from "./lock.js";
import { createGatewayPaths } from "./paths.js";
import { createGatewayServer } from "./server.js";
import { createGatewayStalePolicy } from "./stale.js";

export interface GatewayDaemonLifecycleDeps {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly serverModulePath?: string;
  readonly spawnDetached?: (execPath: string, args: readonly string[], options: { readonly detached: true; readonly env: NodeJS.ProcessEnv; readonly stdio: "ignore" }) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly health?: ReturnType<typeof createGatewayHealthClient>;
}

const FIXED_HOST = "127.0.0.1";
const FIXED_PORT = 37283;
const FIXED_ENDPOINT_PATH = "/mcp";

export function createGatewayDaemonLifecycle(deps: GatewayDaemonLifecycleDeps = {}) {
  const argv = deps.argv ?? process.argv;
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const serverModulePath = deps.serverModulePath ?? resolveDefaultServerModulePath();
  const spawnDetached = deps.spawnDetached ?? ((bin, args, options) => { spawn(bin, [...args], options).unref(); });
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const paths = createGatewayPaths({ env });
  const lock = createGatewayLock();
  const health = deps.health ?? createGatewayHealthClient();
  const stale = createGatewayStalePolicy();

  async function runServer(): Promise<void> {
    const server = createGatewayServer();
    await server.start(paths);
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", () => { void server.stop().finally(resolve); });
      process.once("SIGINT", () => { void server.stop().finally(resolve); });
    });
  }

  async function probe() {
    const payload = readTrustedLock();
    const probeResult = await health.probe(payload);
    return { ...probeResult, buildStale: payload ? stale.isBuildStale(payload, serverModulePath) : false };
  }

  async function stop(): Promise<void> {
    const payload = readTrustedLock();
    if (!payload) return;
    try {
      process.kill(payload.pid, "SIGTERM");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    await sleep(200);
    try {
      process.kill(payload.pid, 0);
      process.kill(payload.pid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    lock.removeLock(paths.lockFile, payload.pid);
  }

  async function ensureDaemon(): Promise<string> {
    const current = readTrustedLock({ cleanUntrusted: true });
    const probeResult = await health.probe(current);
    const isBuildStale = current ? stale.isBuildStale(current, serverModulePath) : false;
    if (probeResult.healthy && current) {
      if (!isBuildStale) return current.endpoint;
      if (typeof probeResult.health?.tenantCount === "number" && probeResult.health.tenantCount > 0) return current.endpoint;
    }
    if (current) await stop();
    spawnDetached(execPath, [serverModulePath, "serve"], { detached: true, env, stdio: "ignore" });
    for (let i = 0; i < 30; i += 1) {
      await sleep(100);
      const next = await probe();
      if (next.healthy && next.lock) return next.lock.endpoint;
    }
    throw new Error("Gateway daemon did not become healthy");
  }

  return { ensureDaemon, probe, runServer, stop, argv };

  function readTrustedLock(options: { readonly cleanUntrusted?: boolean } = {}): GatewayLockPayload | null {
    try {
      const payload = lock.readLock(paths.lockFile);
      if (!payload) return null;
      lock.assertTrustedLock({
        dir: paths.dir,
        lockFile: paths.lockFile,
        payload,
        host: FIXED_HOST,
        port: FIXED_PORT,
        endpointPath: FIXED_ENDPOINT_PATH,
      });
      return payload;
    } catch (err) {
      if (!options.cleanUntrusted) throw err;
      // 신뢰할 수 없는 잠금은 프로세스를 종료하지 않고 파일만 폐기한다.
      lock.removeLock(paths.lockFile);
      return null;
    }
  }
}

function resolveDefaultServerModulePath(): string {
  const builtPath = new URL("./cli-bin.mjs", import.meta.url).pathname;
  if (fs.existsSync(builtPath)) return builtPath;
  return new URL("../dist/cli-bin.mjs", import.meta.url).pathname;
}

export async function main(): Promise<void> {
  const lifecycle = createGatewayDaemonLifecycle();
  const command = process.argv[2] ?? "ensure";
  if (command === "serve") {
    await lifecycle.runServer();
    return;
  }
  if (command === "stop") {
    await lifecycle.stop();
    return;
  }
  if (command === "probe") {
    process.stdout.write(`${JSON.stringify(await lifecycle.probe())}\n`);
    return;
  }
  process.stdout.write(`${await lifecycle.ensureDaemon()}\n`);
}

export function findLocalCliMjs(cwd: string): string | null {
  let currentDir = path.resolve(cwd);
  while (true) {
    const cliBinCandidate = path.join(currentDir, "runtime", "fleet-gateway", "dist", "cli-bin.mjs");
    if (fs.existsSync(cliBinCandidate)) {
      return cliBinCandidate;
    }
    const legacyCliCandidate = path.join(currentDir, "runtime", "fleet-gateway", "dist", "cli.mjs");
    if (fs.existsSync(legacyCliCandidate)) {
      return legacyCliCandidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}
