import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONSOLE_STOP_DEADLINE_MS } from "@fleet-console/protocol/lifecycle";

import { createDesktopEnvironment } from "../src/environment.js";
import { SidecarSupervisor, type SidecarRuntime } from "../src/sidecar-supervisor.js";

let lockFile = "";

function supervisor(log = { info: vi.fn(), error: vi.fn() }) {
  return new SidecarSupervisor({ nodePath: "/sidecar/node", cliPath: "/sidecar/fleet-console/dist/cli.mjs", serviceRoot: "/sidecar/fleet-console", serviceVersion: "1.23.0", env: {}, lockFile, ownerId: "owner-1", log });
}

function writeLock(payload: unknown): void {
  fs.writeFileSync(lockFile, JSON.stringify(payload), { mode: 0o600 });
}

/** A pid that has exited and been reaped: the leftover of a crashed Console. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return child.pid!;
}

describe("sidecar supervisor", () => {
  const children: ChildProcess[] = [];
  let lockDir = "";
  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-lock-"));
    lockFile = path.join(lockDir, "console.lock");
  });
  afterEach(async () => {
    fs.rmSync(lockDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }));
  });

  it("waits for a starting matching desktop owner and adopts it only when healthy", async () => {
    writeLock({ pid: process.pid, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } });
    const before = fs.readFileSync(lockFile, "utf8");
    const fetchHealth = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "console_starting", pid: process.pid }), { status: 503 }))
      .mockResolvedValue(new Response(JSON.stringify({ pid: process.pid }), { status: 200 }));
    vi.stubGlobal("fetch", fetchHealth);
    const kill = vi.spyOn(process, "kill");
    await expect(supervisor().startOrAdopt()).resolves.toBe("http://127.0.0.1:4310/console/");
    expect(fs.readFileSync(lockFile, "utf8")).toBe(before);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("rejects a healthy CLI-owned daemon without resolving, pairing, or signaling it", async () => {
    writeLock({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "cli", id: "other", protocolVersion: 1 } });
    const fetchFor = vi.fn(async (_url: string | URL) => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchFor);
    const kill = vi.spyOn(process, "kill");
    const resolveRuntime = vi.fn(async () => ({ nodePath: "/runtime/node", cliPath: "/runtime/console/dist/cli.mjs", serviceRoot: "/runtime/console", serviceVersion: "1.23.0" }));
    const instance = new SidecarSupervisor({ resolveRuntime, serviceVersion: "1.23.0", env: {}, lockFile, ownerId: "owner-1", log: { info: vi.fn(), error: vi.fn() } });
    await expect(instance.startOrAdopt()).rejects.toThrow("cli_daemon_requires_confirmation");
    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(fetchFor).toHaveBeenCalledOnce();
    expect(String(fetchFor.mock.calls[0]![0])).toBe("http://127.0.0.1:4310/api/v1/health");
    expect(kill).not.toHaveBeenCalled();
  });

  it("reports a live unhealthy foreign lock without signaling it", async () => {
    writeLock({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "cli", id: "other", protocolVersion: 1 } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect(supervisor().startOrAdopt()).rejects.toThrow("console_lock_foreign_process_unhealthy");
    expect(kill).not.toHaveBeenCalledWith(4321, "SIGTERM");
  });

  it("never signals a live process that a reused lock pid names", async () => {
    // Console이 owner 일치 lock을 남기고 죽은 뒤 OS가 그 pid를 무관한 프로세스에 재할당한 상황이다.
    // bystander는 SIGTERM을 기록만 하고 버티므로, 받은 SIGTERM은 셀 수 있고 SIGKILL만이 그것을 끝낸다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-reused-pid-"));
    const reusedLock = path.join(dir, "console.lock");
    const bystander = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => process.stdout.write('term\\n')); process.stdout.write('ready\\n'); setInterval(() => {}, 60_000)"], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(bystander);
    let bystanderSignal: NodeJS.Signals | null = null;
    let sigterms = 0;
    bystander.once("exit", (_code, signal) => { bystanderSignal = signal ?? "SIGHUP"; });
    await new Promise<void>((resolve) => bystander.stdout!.once("data", () => resolve()));
    bystander.stdout!.on("data", (chunk: Buffer) => { sigterms += chunk.toString().split("term").length - 1; });
    // lock 주소의 무언가가 token health에 200으로 답하지만 다른 pid를 댄다 — 정체 증명이 아니다.
    let answer: "other-pid" | "unauthorized" | "lock-pid-once" = "other-pid";
    const impostor = http.createServer((_request, response) => {
      if (answer === "unauthorized") { response.writeHead(401).end(); return; }
      const pid = answer === "lock-pid-once" ? bystander.pid : process.pid;
      if (answer === "lock-pid-once") answer = "other-pid";
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, pid }));
    });
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", resolve));
    const port = (impostor.address() as AddressInfo).port;
    const lockContents = JSON.stringify({ pid: bystander.pid, endpoint: `http://127.0.0.1:${port}/`, token: "secret", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } });
    fs.writeFileSync(reusedLock, lockContents);
    const resolveRuntime = vi.fn(async (): Promise<SidecarRuntime> => { throw new Error("reached_spawn"); });
    const instance = new SidecarSupervisor({ resolveRuntime, serviceVersion: "1.23.0", env: {}, lockFile: reusedLock, ownerId: "owner-1", shutdownSettleMs: 200, log: { info: vi.fn(), error: vi.fn() } });
    try {
      // Quit은 막히지 않지만 증명하지 못한 pid에는 신호도, lock 삭제도 하지 않는다.
      await expect(instance.stop()).resolves.toBeUndefined();
      expect(fs.existsSync(reusedLock)).toBe(true);
      answer = "unauthorized";
      await expect(instance.startOrAdopt()).rejects.toThrow("console_lock_process_unverified");
      expect(fs.existsSync(reusedLock)).toBe(true);
      expect(sigterms).toBe(0);
      // 증명된 Console이 SIGTERM 뒤 lock을 남긴 채 죽고 그 pid가 재할당된 경쟁: lock 파일은 그대로지만 정체를 다시
      // 증명하지 못하므로 SIGKILL로 승격하지 않는다.
      answer = "lock-pid-once";
      await expect(instance.stop()).resolves.toBeUndefined();
      expect(sigterms).toBe(1);
      expect(fs.readFileSync(reusedLock, "utf8")).toBe(lockContents);
      // lock 주소가 연결을 거절해도 pid가 살아 있으면 종료 정리 중인 Console일 수 있다 — 그동안 새 Console을 띄우지 않고
      // 기다린다. 새 Console은 lock을 쥐기 전에 공유 상태를 만지기 때문이다. pid가 끝나면 신호 없이 시작을 이어 간다.
      await new Promise<void>((resolve) => impostor.close(() => resolve()));
      await expect(instance.stop()).resolves.toBeUndefined();
      expect(fs.readFileSync(reusedLock, "utf8")).toBe(lockContents);
      const starting = instance.startOrAdopt();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.readFileSync(reusedLock, "utf8")).toBe(lockContents);
      expect(resolveRuntime).not.toHaveBeenCalled();
      expect(sigterms).toBe(1);
      expect(bystanderSignal).toBeNull();
      expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
      bystander.kill("SIGKILL");
      await expect(starting).rejects.toThrow("reached_spawn");
      // Desktop은 lock을 지우지 않는다 — 끝난 pid의 lock은 새로 뜨는 Console이 회수한다. Quit도 그대로 둔다.
      expect(fs.readFileSync(reusedLock, "utf8")).toBe(lockContents);
      await expect(instance.stop()).resolves.toBeUndefined();
      expect(fs.readFileSync(reusedLock, "utf8")).toBe(lockContents);
    } finally {
      impostor.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("leaves an exited Console's lock for the Console it starts to reclaim, and keeps a lock without an owner", async () => {
    const cliPath = path.join(lockDir, "console", "dist", "cli.mjs");
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    // Stands in for a serve that reclaims under Console's protocol: it takes over only the exact dead lock it was told about.
    fs.writeFileSync(cliPath, `
      import fs from "node:fs"; import http from "node:http";
      if (fs.readFileSync(process.env.LOCK_FILE, "utf8") !== process.env.DEAD_LOCK) process.exit(73);
      fs.unlinkSync(process.env.LOCK_FILE);
      const server = http.createServer((request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, pid: process.pid })));
      server.listen(0, "127.0.0.1", () => fs.writeFileSync(process.env.LOCK_FILE, JSON.stringify({ pid: process.pid, endpoint: "http://127.0.0.1:" + server.address().port + "/", token: "secret", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } }), { flag: "wx", mode: 0o600 }));
      process.on("SIGTERM", () => process.exit(0));
    `);
    const deadLock = JSON.stringify({ pid: await exitedPid(), endpoint: "http://127.0.0.1:9/", token: "old", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } });
    const runtime: SidecarRuntime = { nodePath: process.execPath, cliPath, serviceRoot: path.dirname(path.dirname(cliPath)), serviceVersion: "1.23.0" };
    const resolveRuntime = vi.fn(async () => runtime);
    const instance = new SidecarSupervisor({ resolveRuntime, serviceVersion: "1.23.0", env: { LOCK_FILE: lockFile, DEAD_LOCK: deadLock }, lockFile, ownerId: "owner-1", log: { info: vi.fn(), error: vi.fn() } });
    try {
      // A lock with no readable owner may belong to a running Console: it stays, and no Console is started next to it.
      fs.writeFileSync(lockFile, "", { mode: 0o600 });
      await expect(instance.startOrAdopt()).rejects.toThrow("console_lock_ownerless");
      expect(fs.readFileSync(lockFile, "utf8")).toBe("");
      expect(resolveRuntime).not.toHaveBeenCalled();
      // A lock whose pid exited reaches the started Console untouched, and the Console that took it over is adopted.
      fs.writeFileSync(lockFile, deadLock, { mode: 0o600 });
      await expect(instance.startOrAdopt()).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+\/console\/$/);
      expect(JSON.parse(fs.readFileSync(lockFile, "utf8")).token).toBe("secret");
    } finally {
      await instance.stop();
    }
  }, 15_000);

  it.each(["held", "released"] as const)("escalates a stuck sidecar only while its lock remains held (%s)", async (lockState) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-stuck-sidecar-"));
    const ownLock = path.join(dir, "console.lock");
    const cliPath = path.join(dir, "console", "dist", "cli.mjs");
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    // 기존 정지 계약에 lock 해제 뒤 SDK 자식 수거로 잔존하는 경계를 더한다. pid 생존만으로 승격하면 후자가 죽는다.
    fs.writeFileSync(cliPath, `
      import fs from "node:fs"; import http from "node:http";
      let answered = false;
      process.on("SIGTERM", () => {
        if (process.env.LOCK_STATE === "released") fs.unlinkSync(process.env.LOCK_FILE);
      });
      const server = http.createServer((request, response) => {
        if (answered) return;
        answered = true;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, pid: process.pid }));
      });
      server.listen(0, "127.0.0.1", () => fs.writeFileSync(process.env.LOCK_FILE, JSON.stringify({ pid: process.pid, endpoint: "http://127.0.0.1:" + server.address().port + "/", token: "secret", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } })));
    `);
    const runtime: SidecarRuntime = { nodePath: process.execPath, cliPath, serviceRoot: path.dirname(path.dirname(cliPath)), serviceVersion: "1.23.0" };
    const instance = new SidecarSupervisor({ resolveRuntime: async () => runtime, serviceVersion: "1.23.0", env: { LOCK_FILE: ownLock, LOCK_STATE: lockState }, lockFile: ownLock, ownerId: "owner-1", shutdownSettleMs: 200, log: { info: vi.fn(), error: vi.fn() } });
    let sidecarPid: number | undefined;
    try {
      await expect(instance.startOrAdopt()).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+\/console\/$/);
      sidecarPid = (JSON.parse(fs.readFileSync(ownLock, "utf8")) as { pid: number }).pid;
      const kill = vi.spyOn(process, "kill");
      await expect(instance.stop()).resolves.toBeUndefined();
      expect(kill.mock.calls.filter(([, signal]) => signal === "SIGTERM")).toEqual([[sidecarPid, "SIGTERM"]]);
      if (lockState === "held") {
        expect(kill).toHaveBeenCalledWith(sidecarPid, "SIGKILL");
        expect(() => process.kill(sidecarPid!, 0)).toThrow();
        expect(fs.existsSync(ownLock)).toBe(true);
      } else {
        // 정리 예산을 넘겨 살아도 lock을 놓았으면 신호 없이 반환하며, 재차 Quit해도 SIGTERM을 보내지 않는다.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await instance.stop();
        expect(() => process.kill(sidecarPid!, 0)).not.toThrow();
        expect(fs.existsSync(ownLock)).toBe(false);
        expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[sidecarPid, "SIGTERM"]]);
      }
    } finally {
      if (sidecarPid) try { process.kill(sidecarPid, "SIGKILL"); } catch { /* 이미 종료됨 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

// Process lifecycle over a real built Console: the real SidecarSupervisor quits it and nothing is mocked. The invariants, the
// Console half of the suite and the known-defect ratchet are explained in runtime/fleet-console/tests/built/fleet-built-smoke.test.ts.
const requireFromTest = createRequire(import.meta.url);
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../../..");
// Test fixtures of the Console half, shared as files: the agent stand-in runs as CLAUDE_BIN and the ratchet list is read.
const consoleFixtures = path.resolve(testsDir, "../../fleet-console/tests/fixtures");
const FAKE_AGENT = path.join(consoleFixtures, "lifecycle-fake-agent.mjs");
const LIFECYCLE_KNOWN_DEFECTS = JSON.parse(fs.readFileSync(path.join(consoleFixtures, "lifecycle-known-defects.json"), "utf8")) as ReadonlyArray<{ readonly case: string; readonly followup: string; readonly releasedBy: string }>;
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const AGENT_ROLES = new Set(["chat", "chat-mcp", "terminal", "terminal-mcp"]);
// Long enough for anything that reaps after the Console is gone (a containment helper's own grace included).
const SETTLE_MS = 10_000;

// Needs the built Console (pnpm --filter @dotobokuri/fleet-console build); POSIX signal semantics only.
const runLifecycle = process.env.FLEET_BUILT_SMOKE === "1" && process.platform !== "win32";
const LIFECYCLE_DIRS: string[] = [];
/** Every process the case started or observed, by pid, with the start time that proves it is still that process. */
const OWNED = new Map<number, string>();

afterEach(async () => {
  // The suite keeps I1 itself: only a pid whose start time still matches is signalled, and nothing may be left behind.
  const left: string[] = [];
  // A Console's reaper reacts to its Console's end: take whatever the owned processes started (proved the same way) before
  // they are killed, so nothing still writes into a run directory while it is removed.
  for (const [pid, startedAt] of [...OWNED]) if (processStartTime(pid) === startedAt) for (const entry of descendantsOf(pid)) own(entry.pid);
  if (OWNED.size > 0) {
    for (const [pid, startedAt] of OWNED) {
      if (processStartTime(pid) === startedAt) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
    }
    const deadline = Date.now() + 3_000;
    for (const [pid, startedAt] of OWNED) {
      while (processStartTime(pid) === startedAt && Date.now() < deadline) await delay(25);
      if (processStartTime(pid) === startedAt) left.push(String(pid));
    }
    OWNED.clear();
  }
  for (const dir of LIFECYCLE_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  if (left.length > 0) throw new Error(`lifecycle processes survived SIGKILL: ${left.join(", ")}`);
});

(runLifecycle ? describe : describe.skip)("sidecar supervisor over a built Console", () => {
  // L4d, eca5f8c7 (I4, then I2). Quit while the Console's shutdown stalls with the lock held: only the Console's own 10s
  // deadline reaps the agent that ignores SIGTERM. The Console's event loop freezes for 800ms just before that deadline
  // (inside the escalation margin the contract allows a busy loop), which moves the reap to about 10.6s; Quit must still not
  // SIGKILL the Console first. The signature is the order: a reaper
  // would hide the orphan before Desktop's own fix lands.
  it("lets the Console's own shutdown deadline finish before Quit escalates", async () => {
    const cliPath = requireFromTest.resolve("@dotobokuri/fleet-console/cli");
    const serviceRoot = path.dirname(path.dirname(cliPath));
    const base = path.join(repoRoot, ".fleet", "isolated", "lifecycle");
    fs.mkdirSync(base, { recursive: true });
    // Fleet data in the checkout's isolated root; TMPDIR and the Theater outside the checkout.
    const dir = fs.mkdtempSync(path.join(base, "desktop-quit-"));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-lifecycle-desktop-"));
    LIFECYCLE_DIRS.push(dir, tmp);
    const outside = path.relative(fs.realpathSync(repoRoot), fs.realpathSync(tmp));
    if (!outside.startsWith("..") && !path.isAbsolute(outside)) throw new Error("TMPDIR must stay outside the checkout");
    const root = path.join(dir, "root");
    const slot = path.join(root, "console");
    const agentDir = path.join(dir, "agent");
    const theater = path.join(tmp, "theater");
    const pathbin = path.join(dir, "bin");
    for (const target of [root, agentDir, theater, pathbin, path.join(dir, "home")]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.symlinkSync(process.execPath, path.join(pathbin, "node"));
    const lockFile = path.join(slot, "console.lock");
    const stalled = path.join(dir, "stalled");
    const exited = path.join(dir, "exited");
    // {t0, start, end} in epoch ms: the first SIGTERM and the pre-deadline freeze, for the case's timeline.
    const freeze = path.join(dir, "freeze.jsonl");
    const preload = path.join(dir, "stall-close.mjs");
    // Test-only preload, active in the Console's `serve` process only (NODE_OPTIONS reaches every Node child it starts):
    // closing the main listener never completes, so shutdown stalls with the lock held, and the Console records reaching its
    // own exit, which a SIGKILL from outside never lets it do.
    fs.writeFileSync(preload, [
      "import fs from 'node:fs';",
      "import http from 'node:http';",
      `const lock = ${JSON.stringify(lockFile)}, stalled = ${JSON.stringify(stalled)}, exited = ${JSON.stringify(exited)}, freeze = ${JSON.stringify(freeze)};`,
      `if (process.argv[1] === ${JSON.stringify(cliPath)} && process.argv[2] === 'serve') {`,
      "  process.on('exit', (code) => fs.writeFileSync(exited, String(code)));",
      "  process.prependOnceListener('SIGTERM', () => {",
      "    const t0 = Date.now();",
      "    setTimeout(() => {",
      "      const start = Date.now();",
      "      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);",
      "      fs.appendFileSync(freeze, JSON.stringify({ t0, start, end: Date.now() }) + '\\n');",
      `    }, ${CONSOLE_STOP_DEADLINE_MS - 200}).unref();`,
      "  });",
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
    // Built from nothing, never inherited, so a Console that launched this suite cannot lend it its slot or session marker.
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
    const serviceEnv: NodeJS.ProcessEnv = { ...desktop.serviceEnv, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, PATH: [pathbin, ...SYSTEM_PATH].join(":") };
    expect(serviceEnv.HOME).toBe(baseEnv.HOME);
    const serviceVersion = (JSON.parse(fs.readFileSync(path.join(serviceRoot, "package.json"), "utf8")) as { version: string }).version;
    const supervisor = new SidecarSupervisor({
      nodePath: process.execPath,
      cliPath,
      serviceRoot,
      serviceVersion,
      env: serviceEnv,
      lockFile,
      ownerId: desktop.ownerId,
      log: { info: () => {}, error: () => {} },
    });

    const endpoint = await supervisor.startOrAdopt();
    const consolePid = (JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number }).pid;
    own(consolePid);
    const agentProcs = () => {
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
    await waitUntil(() => agentProcs().some((entry) => entry.role === "turn-open"), 20_000, "the chat turn did not open");
    const started = descendantsOf(consolePid);

    await supervisor.stop();
    await waitUntil(() => processStartTime(consolePid) === null, 30_000, "the Console outlived Quit");

    expect(fs.existsSync(stalled), "the injected stall must hold the shutdown with the lock held").toBe(true);
    const failureEntries = (() => {
      try {
        return fs.readFileSync(path.join(slot, "errors.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) as { kind?: unknown; ts?: unknown }; } catch { return { kind: "unreadable" }; } });
      } catch {
        return [];
      }
    })();
    const failureLog = failureEntries.map((entry) => String(entry.kind));
    // When, after the Console's first SIGTERM, the freeze ran and the deadline recorded its timeout (after its process-table
    // read): printed on every run so CI logs show how much of the escalation margin the deadline actually used.
    const timeline = (() => {
      try {
        const { t0, start, end } = JSON.parse(fs.readFileSync(freeze, "utf8").split("\n")[0]!) as { t0: number; start: number; end: number };
        const recorded = failureEntries.filter((entry) => entry.kind === "shutdown_timeout" && typeof entry.ts === "string").map((entry) => Date.parse(entry.ts as string) - t0).at(-1) ?? null;
        return { freezeStartMs: start - t0, freezeEndMs: end - t0, deadlineRecordedMs: recorded };
      } catch {
        return null;
      }
    })();
    console.info(`L4d timeline ${JSON.stringify(timeline)}`);
    lifecycleCheck("L4d", fs.existsSync(exited), "I4: Quit does not SIGKILL the Console before its own deadline ends it", { detail: { timeline } });
    const deadline = Date.now() + SETTLE_MS;
    let left = started.filter((entry) => processStartTime(entry.pid) === entry.startedAt);
    while (left.length > 0 && Date.now() < deadline) {
      await delay(100);
      left = left.filter((entry) => processStartTime(entry.pid) === entry.startedAt);
    }
    const roles = new Map(agentProcs().filter((entry) => AGENT_ROLES.has(entry.role)).map((entry) => [entry.pid, entry.role] as const));
    lifecycleCheck("L4d", left.length === 0, "I2: nothing the Console started outlives it", { detail: { survivors: left.map((entry) => roles.get(entry.pid) ?? entry.command), failureLog, timeline }, signature: false });
  }, 90_000);
});

/** Asserts one lifecycle invariant; a listed known defect asserts its signature instead (fleet-built-smoke.test.ts). */
function lifecycleCheck(caseId: string, holds: boolean, invariant: string, options: { readonly detail?: unknown; readonly signature?: boolean } = {}): void {
  const detail = options.detail === undefined ? "" : `: ${JSON.stringify(options.detail)}`;
  const known = LIFECYCLE_KNOWN_DEFECTS.find((entry) => entry.case === caseId);
  if (known && process.env.FLEET_LIFECYCLE_RATCHET !== "off") {
    if (options.signature === false) return;
    expect.soft(holds, `known defect ${known.followup} (${caseId}) no longer reproduces: "${invariant}" holds; ${known.releasedBy} removes its entry from lifecycle-known-defects.json${detail}`).toBe(false);
  } else {
    expect.soft(holds, `${caseId}${known ? ` (${known.followup})` : ""}: ${invariant}${detail}`).toBe(true);
  }
}

function own(pid: number): void {
  const startedAt = processStartTime(pid);
  if (startedAt !== null && !OWNED.has(pid)) OWNED.set(pid, startedAt);
}

function processStartTime(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

/** Every live descendant of `pid` now, whatever started it. */
function descendantsOf(pid: number): Array<{ readonly pid: number; readonly startedAt: string; readonly command: string }> {
  const table = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const [child, ppid] of table) {
      if (child !== undefined && ppid === parent && !found.includes(child)) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found.flatMap((child) => {
    const startedAt = processStartTime(child);
    if (startedAt === null) return [];
    own(child);
    const command = spawnSync("ps", ["-o", "command=", "-p", String(child)], { encoding: "utf8" }).stdout.trim();
    return [{ pid: child, startedAt, command: path.basename(command.split(/\s+/)[0] ?? "") }];
  });
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
