import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createDesktopEnvironment } from "../src/environment.js";
import { SidecarSupervisor } from "../src/sidecar-supervisor.js";

// Desktop half of the Console process lifecycle suite (runtime/fleet-console/tests/built/console-lifecycle-invariants.test.ts
// holds the invariants and the Console half). The real SidecarSupervisor quits a real built Console; nothing is mocked.

const requireFromTest = createRequire(import.meta.url);
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../../..");
// The same credential-free agent stand-in the Console half uses; it is executed as CLAUDE_BIN, never imported.
const FAKE_AGENT = path.resolve(testsDir, "../../fleet-console/tests/fixtures/lifecycle-fake-agent.mjs");
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const AGENT_ROLES = new Set(["chat", "chat-mcp", "terminal", "terminal-mcp"]);

const runSuite = process.env.FLEET_LIFECYCLE_SUITE === "1" && process.platform !== "win32";
const ROOTS: string[] = [];
const OWNED = new Map<number, string>();

afterEach(async () => {
  for (const [pid, marker] of OWNED) {
    if (alive(pid) && commandOf(pid).includes(marker)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
  OWNED.clear();
  await delay(200);
  for (const root of ROOTS.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

(runSuite ? describe : describe.skip)("Desktop Console lifecycle", () => {
  // eca5f8c7 (I4, I2). Quit while the Console's shutdown stalls with the lock held: only the Console's own 10s deadline
  // reaps the agent that ignores SIGTERM. A process-table read that takes 600ms (inside the Console's own 1s allowance)
  // moves that reap later; Desktop must still not SIGKILL the Console before it, or the agent is orphaned.
  it("lets the Console's own shutdown deadline finish before Quit escalates", async () => {
    const cliPath = requireFromTest.resolve("@dotobokuri/fleet-console/cli");
    const serviceRoot = path.dirname(path.dirname(cliPath));
    const base = path.join(repoRoot, ".fleet", "isolated", "lifecycle");
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, "desktop-quit-"));
    ROOTS.push(dir);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-lifecycle-desktop-"));
    ROOTS.push(tmp);
    const root = path.join(dir, "root");
    const slot = path.join(root, "console");
    const agentDir = path.join(dir, "agent");
    const theater = path.join(dir, "theater");
    const pathbin = path.join(dir, "bin");
    const slowPs = path.join(dir, "slow-ps");
    for (const target of [root, agentDir, theater, pathbin, slowPs, path.join(dir, "home")]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.symlinkSync(process.execPath, path.join(pathbin, "node"));
    const realPs = SYSTEM_PATH.map((entry) => path.join(entry, "ps")).find((candidate) => fs.existsSync(candidate))!;
    fs.writeFileSync(path.join(slowPs, "ps"), `#!/bin/sh\nsleep 0.6\nexec ${realPs} "$@"\n`, { mode: 0o755 });
    const lockFile = path.join(slot, "console.lock");
    const stalled = path.join(dir, "stalled");
    const exited = path.join(dir, "exited");
    const preload = path.join(dir, "stall-close.mjs");
    // Test-only preload, active in the Console's `serve` process only (NODE_OPTIONS reaches every Node child it starts):
    // closing the main listener never completes, so shutdown stalls with the lock held, and the Console records reaching its
    // own exit, which a SIGKILL from outside never lets it do.
    fs.writeFileSync(preload, [
      "import fs from 'node:fs';",
      "import http from 'node:http';",
      `const lock = ${JSON.stringify(lockFile)}, stalled = ${JSON.stringify(stalled)}, exited = ${JSON.stringify(exited)};`,
      `if (process.argv[1] === ${JSON.stringify(cliPath)} && process.argv[2] === 'serve') {`,
      "  process.on('exit', (code) => fs.writeFileSync(exited, String(code)));",
      "  const close = http.Server.prototype.close;",
      "  http.Server.prototype.close = function (callback) {",
      "    let port = null;",
      "    try { port = JSON.parse(fs.readFileSync(lock, 'utf8')).port; } catch {}",
      "    const address = this.address();",
      "    if (port !== null && address && typeof address === 'object' && address.port === port) { fs.writeFileSync(stalled, ''); return this; }",
      "    return close.call(this, callback);",
      "  };",
      "}",
    ].join("\n"));
    const user = os.userInfo().username;
    // Built from nothing, never inherited: the Fleet slot is in the checkout's isolated root, TMPDIR outside the checkout.
    const baseEnv: NodeJS.ProcessEnv = {
      HOME: path.join(dir, "home"),
      TMPDIR: tmp,
      PATH: [pathbin, ...SYSTEM_PATH].join(":"),
      USER: user,
      LOGNAME: user,
      LANG: "en_US.UTF-8",
      SHELL: "/bin/sh",
      FLEET_DATA_DIR: root,
      FLEET_CONSOLE_DATA_DIR: slot,
      FLEET_DESKTOP_DATA_DIR: path.join(dir, "desktop"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_BIN: FAKE_AGENT,
      FAKE_AGENT_DIR: agentDir,
    };
    const desktop = createDesktopEnvironment(path.join(dir, "userdata"), "0.0.0-lifecycle", serviceRoot, false, baseEnv);
    expect(path.join(desktop.consoleDir, "console.lock")).toBe(lockFile);
    const serviceEnv: NodeJS.ProcessEnv = { ...desktop.serviceEnv, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, PATH: [slowPs, pathbin, ...SYSTEM_PATH].join(":") };
    expect(serviceEnv.HOME).toBe(baseEnv.HOME);
    const serviceVersion = (JSON.parse(fs.readFileSync(path.join(serviceRoot, "package.json"), "utf8")) as { version: string }).version;
    const log: string[] = [];
    const supervisor = new SidecarSupervisor({
      nodePath: process.execPath,
      cliPath,
      serviceRoot,
      serviceVersion,
      env: serviceEnv,
      lockFile,
      ownerId: desktop.ownerId,
      log: { info: (line) => log.push(line), error: (line) => log.push(line) },
    });

    const endpoint = await supervisor.startOrAdopt();
    const consolePid = (JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number }).pid;
    OWNED.set(consolePid, cliPath);
    const procs = () => {
      try {
        return fs.readFileSync(path.join(agentDir, "procs.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { role: string; pid: number });
      } catch {
        return [];
      }
    };
    const origin = new URL(endpoint).origin;
    const api = async <T>(route: string, body: unknown): Promise<T> => {
      const response = await fetch(new URL(route, endpoint), { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await response.text();
      if (!response.ok) throw new Error(`${route}: ${response.status} ${text.slice(0, 200)}`);
      return JSON.parse(text) as T;
    };
    const grant = await api<{ folderGrantId?: string; id?: string; grant?: { id: string } }>("/api/v1/theaters/folder-grants", { path: theater });
    const created = await api<{ id?: string; theater?: { id: string } }>("/api/v1/theaters", { folderGrantId: grant.folderGrantId ?? grant.grant?.id ?? grant.id });
    await api("/api/v1/agent/sessions", { theaterId: created.id ?? created.theater?.id, cliId: "claude", viewMode: "chat", prompt: "lifecycle suite open turn" });
    await waitUntil(() => procs().some((entry) => entry.role === "turn-open"), 20_000, "the chat turn did not open");
    const agents = procs().filter((entry) => AGENT_ROLES.has(entry.role));
    for (const entry of agents) OWNED.set(entry.pid, entry.role.endsWith("-mcp") ? "process.stdin.resume" : FAKE_AGENT);

    await supervisor.stop();
    await waitUntil(() => !alive(consolePid), 20_000, "the Console outlived Quit");

    expect(fs.existsSync(stalled), "the injected stall must hold the shutdown with the lock held").toBe(true);
    expect.soft(fs.existsSync(exited), "I4: Quit SIGKILLed the Console before its own deadline reaped the agent").toBe(true);
    const deadline = Date.now() + 5_000;
    let survivors = agents.filter((entry) => alive(entry.pid));
    while (survivors.length > 0 && Date.now() < deadline) {
      await delay(100);
      survivors = survivors.filter((entry) => alive(entry.pid));
    }
    expect.soft(survivors.map((entry) => entry.role), "I2").toEqual([]);
  }, 90_000);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function commandOf(pid: number): string {
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

async function waitUntil(condition: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(25);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
