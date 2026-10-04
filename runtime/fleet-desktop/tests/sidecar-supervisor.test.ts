import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
