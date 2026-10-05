import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listLocalConsoles } from "../core/host/bootstrap/local-consoles.js";

/**
 * The local Console list feeds two consumers: the switcher, and Desktop's gate that opens a local Console only when this
 * same list names it. A Console that is merely slow (past PUBLIC_STATUS_TIMEOUT_MS) or that is stopping must stay listed
 * with its contract state; dropping it would hide a stuck Console and make a slow, healthy one unopenable from Desktop.
 */
describe("local Console list", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it.skipIf(process.platform === "win32")("lists ready, slow, and stopping Consoles with their public state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-local-consoles-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const ready = await statusServer(0);
    const slow = await statusServer(1_000);
    // A live pid behind a closed listener is the contract's "stopping": take a port, then close it.
    const closed = await statusServer(0);
    await closed.close();

    const lockFiles = [
      writeLock(root, "ready", ready.port),
      writeLock(root, "slow", slow.port),
      writeLock(root, "stopping", closed.port),
    ];
    const entries = await listLocalConsoles({ lockFiles, platform: "darwin" });

    expect(entries.map(({ origin, state }) => ({ origin, state }))).toEqual([
      { origin: `http://127.0.0.1:${ready.port}`, state: "ready" },
      { origin: `http://127.0.0.1:${slow.port}`, state: "unresponsive" },
      { origin: `http://127.0.0.1:${closed.port}`, state: "stopping" },
    ].sort((left, right) => left.origin.localeCompare(right.origin)));
  });

  async function statusServer(delayMs: number): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
    const timers = new Set<NodeJS.Timeout>();
    const server = http.createServer((_req, res) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      }, delayMs);
      timers.add(timer);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    cleanups.push(close);
    return { port: (server.address() as AddressInfo).port, close };
  }
});

/** A trusted lock (0700/0600, this user, loopback endpoint) whose pid is this live test process. */
function writeLock(root: string, name: string, port: number): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  const lockFile = path.join(dir, "console.lock");
  const payload = {
    pid: process.pid,
    host: "127.0.0.1",
    port,
    endpoint: `http://127.0.0.1:${port}/`,
    startedAt: Date.now(),
    token: `token-${name}`,
    version: "0.0.0-test",
    owner: { kind: "cli" },
  };
  fs.writeFileSync(lockFile, JSON.stringify(payload), { mode: 0o600 });
  return lockFile;
}
