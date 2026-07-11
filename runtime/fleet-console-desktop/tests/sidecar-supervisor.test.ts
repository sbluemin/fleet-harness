import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SidecarSupervisor } from "../src/sidecar-supervisor.js";

const lockFile = "/tmp/fleet-desktop-test.lock";

function supervisor(log = { info: vi.fn(), error: vi.fn() }) {
  return new SidecarSupervisor({ nodePath: "/sidecar/node", cliPath: "/sidecar/fleet-console/dist/cli.mjs", serviceRoot: "/sidecar/fleet-console", serviceVersion: "1.23.0", env: {}, lockFile, ownerId: "owner-1", log });
}

describe("sidecar supervisor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("adopts only a healthy matching desktop owner", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    await expect(supervisor().startOrAdopt()).resolves.toBe("http://127.0.0.1:4310/console/");
  });

  it("compares the lock with the Console service version rather than the shell version", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const instance = new SidecarSupervisor({ nodePath: "/sidecar/node", cliPath: "/sidecar/fleet-console/dist/cli.mjs", serviceRoot: "/sidecar/fleet-console", serviceVersion: "2.0.0", env: {}, lockFile, ownerId: "owner-1", log: { info: vi.fn(), error: vi.fn() } });
    await expect(instance.startOrAdopt()).rejects.toThrow("cli_daemon_requires_confirmation");
  });

  it("does not resolve a runtime while adopting a healthy owned sidecar", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const resolveRuntime = vi.fn(async () => ({ nodePath: "/runtime/node", cliPath: "/runtime/console/dist/cli.mjs", serviceRoot: "/runtime/console", serviceVersion: "1.23.0" }));
    const instance = new SidecarSupervisor({ resolveRuntime, env: {}, lockFile, ownerId: "owner-1", serviceVersion: "1.23.0", log: { info: vi.fn(), error: vi.fn() } });
    await expect(instance.startOrAdopt()).resolves.toBe("http://127.0.0.1:4310/console/");
    expect(resolveRuntime).not.toHaveBeenCalled();
  });

  it("rejects a healthy CLI-owned daemon rather than signaling it", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "cli", id: "other", protocolVersion: 1 } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const kill = vi.spyOn(process, "kill");
    await expect(supervisor().startOrAdopt()).rejects.toThrow("cli_daemon_requires_confirmation");
    expect(kill).not.toHaveBeenCalled();
  });

  it("hard-stops a live unhealthy lock that this desktop does not own", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "cli", id: "other", protocolVersion: 1 } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect(supervisor().startOrAdopt()).rejects.toThrow("console_lock_process_unhealthy");
    expect(kill).not.toHaveBeenCalledWith(4321, "SIGTERM");
  });

  it("recovers an owned unhealthy sidecar by terminating it before relaunch", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } }));
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    // SIGTERM 이후에만 죽은 것으로 보고해 회수 경로(생존→종료→잠금 정리→재스폰)를 재현한다.
    let terminated = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") { terminated = true; return true; }
      if (terminated) { const dead = new Error("dead") as NodeJS.ErrnoException; dead.code = "ESRCH"; throw dead; }
      return true;
    });
    // 잠금 회수를 통과해 스폰 단계까지 도달하면 존재하지 않는 sidecar 바이너리로 실패한다 —
    // console_lock_process_unhealthy가 아니라 spawn 실패로 끝나는 것이 회수 성공의 증거다.
    await expect(supervisor().startOrAdopt()).rejects.toThrow("sidecar_spawn_failed");
    expect(kill).toHaveBeenCalledWith(4321, "SIGTERM");
  }, 10_000);

  it("accepts a lock the owned sidecar removed itself while shutting down", async () => {
    // SIGTERM을 정상 처리한 sidecar가 자기 잠금을 지운 지형 — 회수는 성공으로 이어져야 한다.
    let terminated = false;
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      if (terminated) { const gone = new Error("gone") as NodeJS.ErrnoException; gone.code = "ENOENT"; throw gone; }
      return JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } });
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") { terminated = true; return true; }
      if (terminated) { const dead = new Error("dead") as NodeJS.ErrnoException; dead.code = "ESRCH"; throw dead; }
      return true;
    });
    await expect(supervisor().startOrAdopt()).rejects.toThrow("sidecar_spawn_failed");
    expect(kill).toHaveBeenCalledWith(4321, "SIGTERM");
  }, 10_000);

  it("terminates an owned unhealthy sidecar on quit instead of leaving it running", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    let terminated = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") { terminated = true; return true; }
      if (terminated) { const dead = new Error("dead") as NodeJS.ErrnoException; dead.code = "ESRCH"; throw dead; }
      return true;
    });
    await supervisor().stop();
    expect(kill).toHaveBeenCalledWith(4321, "SIGTERM");
  }, 10_000);

  it("does not signal an unowned unhealthy lock on quit", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "cli", id: "other", protocolVersion: 1 } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await supervisor().stop();
    expect(kill).not.toHaveBeenCalled();
  });

  it("stops only the verified owned pid and falls back after the cleanup deadline", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } }));
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    // SIGTERM은 버티고 SIGKILL에서만 죽는 프로세스 — 승격 경로가 완주되어야 한다.
    let killed = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") { killed = true; return true; }
      if (signal === 0 && killed) { const dead = new Error("dead") as NodeJS.ErrnoException; dead.code = "ESRCH"; throw dead; }
      return true;
    });
    await supervisor().stop();
    expect(kill).toHaveBeenCalledWith(4321, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(4321, "SIGKILL");
  }, 10_000);

  it("keeps escalating on quit when health drops before the owned pid exits", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "desktop", id: "owner-1", protocolVersion: 1 } }));
    // 첫 probe만 healthy — SIGTERM 이후 health가 먼저 내려가는 정리 지연 지형.
    let probed = false;
    vi.stubGlobal("fetch", vi.fn(async () => { const status = probed ? 500 : 200; probed = true; return new Response("x", { status }); }));
    let killed = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") { killed = true; return true; }
      if (signal === 0 && killed) { const dead = new Error("dead") as NodeJS.ErrnoException; dead.code = "ESRCH"; throw dead; }
      return true;
    });
    await supervisor().stop();
    expect(kill).toHaveBeenCalledWith(4321, "SIGKILL");
  }, 10_000);
});
