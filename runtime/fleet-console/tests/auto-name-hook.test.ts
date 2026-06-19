import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runAutoNameHook } from "../src/auto-name-hook.js";
import { createConsoleLock } from "../src/lock.js";
import { createConsolePaths } from "../src/paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lockedDir(port: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-console-autoname-hook-"));
  tempDirs.push(dir);
  const paths = createConsolePaths({ env: { FLEET_CONSOLE_DIR: dir } });
  createConsoleLock().writeLock({
    dir: paths.dir,
    lockFile: paths.lockFile,
    pid: process.pid,
    port,
    endpoint: `http://127.0.0.1:${port}/`,
    version: "test",
  });
  return dir;
}

describe("runAutoNameHook", () => {
  it("no-ops without fetching when the session id is absent", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(runAutoNameHook({}, { fetchImpl, input: JSON.stringify({ prompt: "Fix the parser" }) })).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it("no-ops without fetching when the prompt is missing or blank", async () => {
    const dir = lockedDir(51330);
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(runAutoNameHook({ FLEET_CONSOLE_SESSION_ID: "s1", FLEET_CONSOLE_DIR: dir }, { fetchImpl, input: JSON.stringify({ prompt: "   " }) })).resolves.toBeUndefined();
    await expect(runAutoNameHook({ FLEET_CONSOLE_SESSION_ID: "s1", FLEET_CONSOLE_DIR: dir }, { fetchImpl, input: "{}" })).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it("no-ops without fetching when no console lock is present", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-console-autoname-nolock-"));
    tempDirs.push(dir);
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(runAutoNameHook({ FLEET_CONSOLE_SESSION_ID: "s1", FLEET_CONSOLE_DIR: dir }, { fetchImpl, input: JSON.stringify({ prompt: "Fix the parser" }) })).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it("posts the prompt to the locked auto-name endpoint with the lock bearer token", async () => {
    const dir = lockedDir(51331);
    const paths = createConsolePaths({ env: { FLEET_CONSOLE_DIR: dir } });
    const lock = createConsoleLock().readLock(paths.lockFile);
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {} as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(runAutoNameHook({ FLEET_CONSOLE_SESSION_ID: "session-x", FLEET_CONSOLE_DIR: dir }, { fetchImpl, input: JSON.stringify({ prompt: "Fix the login redirect bug" }) })).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:51331/terminal/sessions/session-x/auto-name");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${lock?.token}`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ prompt: "Fix the login redirect bug" });
  });

  it("truncates an oversized prompt payload before sending", async () => {
    const dir = lockedDir(51332);
    const calls: Array<{ readonly init: RequestInit | undefined }> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init });
      return {} as unknown as Response;
    }) as unknown as typeof fetch;
    const huge = "x".repeat(5000);

    await runAutoNameHook({ FLEET_CONSOLE_SESSION_ID: "session-x", FLEET_CONSOLE_DIR: dir }, { fetchImpl, input: JSON.stringify({ prompt: huge }) });

    const sent = JSON.parse(String(calls[0]?.init?.body)) as { prompt: string };
    expect(sent.prompt.length).toBe(2000);
  });

  it("swallows fetch failures so the provider turn is never blocked", async () => {
    const dir = lockedDir(51333);
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await expect(runAutoNameHook({ FLEET_CONSOLE_SESSION_ID: "session-y", FLEET_CONSOLE_DIR: dir }, { fetchImpl, input: JSON.stringify({ prompt: "Fix the parser" }) })).resolves.toBeUndefined();
    expect(called).toBe(true);
  });
});
