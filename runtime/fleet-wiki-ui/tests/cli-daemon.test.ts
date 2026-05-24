import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgv = process.argv.slice();
const originalCwd = process.cwd();
const originalNoAutoRestart = process.env.FLEET_WIKI_NO_AUTO_RESTART;

afterEach(() => {
  process.argv = originalArgv.slice();
  process.chdir(originalCwd);
  if (originalNoAutoRestart === undefined) {
    delete process.env.FLEET_WIKI_NO_AUTO_RESTART;
  } else {
    process.env.FLEET_WIKI_NO_AUTO_RESTART = originalNoAutoRestart;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("cli daemon lifecycle", () => {
  it("spawns a daemon without putting the bearer token in argv", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-cli-daemon-spawn-"));
    await mkdir(path.join(cwd, ".fleet", "knowledge"), { recursive: true });
    process.chdir(cwd);
    process.argv = ["node", "fleet-wiki"];

    const spawnMock = vi.fn((..._args: unknown[]) => ({ unref: vi.fn() }));
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/api/admin/workspaces")) {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer server-made-token");
        return new Response(JSON.stringify({ workspace: { id: "def456abc123", urlPath: "/w/def456abc123/" } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const openBrowser = vi.fn(async () => undefined);
    vi.doMock("../src/browser.js", () => ({ openBrowser }));
    vi.doMock("../src/lock.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lock.js")>("../src/lock.js");
      let reads = 0;
      return {
        ...actual,
        readLockFile: vi.fn(async () => {
          reads += 1;
          if (reads === 1) return null;
          return {
            pid: process.pid,
            port: 3737,
            host: "127.0.0.1",
            startedAt: "2026-05-19T00:00:00.000Z",
            token: "server-made-token",
          };
        }),
        isProcessAlive: vi.fn(() => true),
        removeLockFile: vi.fn(),
      };
    });

    const { main } = await import("../src/cli.js");
    await main();

    const argv = spawnMock.mock.calls[0]?.[1];
    expect(Array.isArray(argv)).toBe(true);
    const childArgv = argv as string[];
    expect(childArgv).toContain("--cwd");
    expect(childArgv).toContain("--lock");
    expect(childArgv).toContain("--port");
    expect(childArgv).not.toContain("--token");
    expect(childArgv).not.toContain("server-made-token");
    expect(childArgv).not.toContain("--host");
    expect(openBrowser).toHaveBeenCalledWith("http://127.0.0.1:3737/w/def456abc123/");
    await rm(cwd, { recursive: true, force: true });
  });

  it("registers the current cwd with an existing healthy daemon and opens /w/:ws/", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-cli-daemon-"));
    await mkdir(path.join(cwd, ".fleet", "knowledge"), { recursive: true });
    process.chdir(cwd);
    process.argv = ["node", "fleet-wiki"];
    process.env.FLEET_WIKI_NO_AUTO_RESTART = "1";

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/health")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/api/admin/workspaces")) {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer daemon-token");
        const body = JSON.parse(String(init?.body)) as { cwd: string };
        expect(path.basename(body.cwd)).toBe(path.basename(cwd));
        return new Response(JSON.stringify({ workspace: { id: "abc123def456", urlPath: "/w/abc123def456/" } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const openBrowser = vi.fn(async () => undefined);
    vi.doMock("../src/browser.js", () => ({ openBrowser }));
    vi.doMock("../src/lock.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lock.js")>("../src/lock.js");
      return {
        ...actual,
        acquireLockFile: vi.fn(async () => { throw new actual.LockExistsError("/tmp/fleet-wiki-daemon.lock"); }),
        readLockFile: vi.fn(async () => ({
          pid: process.pid,
          port: 3737,
          host: "127.0.0.1",
          startedAt: "2026-05-19T00:00:00.000Z",
          token: "daemon-token",
        })),
        isProcessAlive: vi.fn(() => true),
        removeLockFile: vi.fn(),
      };
    });

    const { main } = await import("../src/cli.js");
    await main();

    expect(openBrowser).toHaveBeenCalledWith("http://127.0.0.1:3737/w/abc123def456/");
    await rm(cwd, { recursive: true, force: true });
  });
});
