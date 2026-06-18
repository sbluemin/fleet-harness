import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runAttentionHook } from "../src/attention-hook.js";
import { createConsoleLock } from "../src/lock.js";
import { createConsolePaths } from "../src/paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runAttentionHook", () => {
  it("no-ops without fetching or throwing when the session id is absent", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(runAttentionHook({}, { fetchImpl })).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it("no-ops without fetching when no console lock is present", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-console-attn-nolock-"));
    tempDirs.push(dir);
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(runAttentionHook({ FLEET_CONSOLE_SESSION_ID: "s1", FLEET_CONSOLE_DIR: dir }, { fetchImpl })).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it("posts attention to the locked endpoint with the lock bearer token", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-console-attn-post-"));
    tempDirs.push(dir);
    const paths = createConsolePaths({ env: { FLEET_CONSOLE_DIR: dir } });
    const handle = createConsoleLock().writeLock({
      dir: paths.dir,
      lockFile: paths.lockFile,
      pid: process.pid,
      port: 51234,
      endpoint: "http://127.0.0.1:51234/",
      version: "test",
    });
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {} as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(runAttentionHook({ FLEET_CONSOLE_SESSION_ID: "session-x", FLEET_CONSOLE_DIR: dir }, { fetchImpl })).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:51234/terminal/sessions/session-x/attention");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${handle.payload.token}`);
  });

  it("swallows fetch failures so the provider turn is never blocked", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-console-attn-reject-"));
    tempDirs.push(dir);
    const paths = createConsolePaths({ env: { FLEET_CONSOLE_DIR: dir } });
    createConsoleLock().writeLock({
      dir: paths.dir,
      lockFile: paths.lockFile,
      pid: process.pid,
      port: 51235,
      endpoint: "http://127.0.0.1:51235/",
      version: "test",
    });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await expect(runAttentionHook({ FLEET_CONSOLE_SESSION_ID: "session-y", FLEET_CONSOLE_DIR: dir }, { fetchImpl })).resolves.toBeUndefined();
    expect(called).toBe(true);
  });
});
