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

  it("rejects a healthy CLI-owned daemon without resolving, pairing, or signaling it", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "cli", id: "other", protocolVersion: 1 } }));
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
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ pid: 4321, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "1.23.0", owner: { kind: "cli", id: "other", protocolVersion: 1 } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect(supervisor().startOrAdopt()).rejects.toThrow("console_lock_foreign_process_unhealthy");
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
});
