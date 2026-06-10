import { spawn } from "node:child_process";
import process from "node:process";

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
}

export function createGatewayDaemonLifecycle(deps: GatewayDaemonLifecycleDeps = {}) {
  const argv = deps.argv ?? process.argv;
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const serverModulePath = deps.serverModulePath ?? new URL("./cli.mjs", import.meta.url).pathname;
  const paths = createGatewayPaths({ env });
  const lock = createGatewayLock();
  const health = createGatewayHealthClient();
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
    return health.probe(lock.readLock(paths.lockFile));
  }

  async function stop(): Promise<void> {
    const payload = lock.readLock(paths.lockFile);
    if (!payload) return;
    try {
      process.kill(payload.pid, "SIGTERM");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      process.kill(payload.pid, 0);
      process.kill(payload.pid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    lock.removeLock(paths.lockFile, payload.pid);
  }

  async function ensureDaemon(): Promise<string> {
    const current = lock.readLock(paths.lockFile);
    const probeResult = await health.probe(current);
    if (probeResult.healthy && current && !stale.isBuildStale(current, serverModulePath)) return current.endpoint;
    if (current) await stop();
    spawn(execPath, [serverModulePath, "serve"], { detached: true, env, stdio: "ignore" }).unref();
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const next = await probe();
      if (next.healthy && next.lock) return next.lock.endpoint;
    }
    throw new Error("Gateway daemon did not become healthy");
  }

  return { ensureDaemon, probe, runServer, stop, argv };
}

async function main(): Promise<void> {
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

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  void main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
