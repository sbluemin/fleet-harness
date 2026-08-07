import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentCliDetector } from "../../fleet-plugins/terminal/server/agent-api/agent-cli-detect.js";
import { sessionCookieName } from "../core/host/auth.js";
import type { ConsoleLockPayload } from "../core/host/console-contract-types.js";
import { createConsoleLock } from "../core/host/lock.js";
import { createConsoleServer, type ConsoleServer } from "../core/host/server.js";

interface Fixture {
  readonly endpoint: string;
  readonly lock: ConsoleLockPayload;
}

const servers: ConsoleServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.stop();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { force: true, recursive: true });
});

describe("access grant and join routes", () => {
  it("refuses to issue a grant without the lock token", async () => {
    const fixture = await startFixture();

    const response = await fetch(`${fixture.endpoint}api/v1/access-grants`, { method: "POST" });

    expect(response.status).toBe(401);
  });

  it("issues a local grant to a lock-token holder and opens a session with it", async () => {
    const fixture = await startFixture();

    const issued = await fetch(`${fixture.endpoint}api/v1/access-grants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.lock.token}` },
    });
    expect(issued.status).toBe(201);
    const grant = await issued.json() as { token: string; audience: string; expiresAt: number };
    expect(grant.audience).toBe("local");
    expect(grant.token).toBeTruthy();

    const joined = await fetch(`${fixture.endpoint}api/v1/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: grant.token }),
    });

    expect(joined.status).toBe(204);
    const cookie = joined.headers.get("set-cookie") ?? "";
    // 이름에 포트가 새겨져야 같은 기계의 두 콘솔이 서로의 세션을 덮어쓰지 않는다.
    expect(cookie).toContain(`${sessionCookieName(fixture.lock.port)}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // 루프백 리스너는 평문 http라 Secure를 붙이면 브라우저가 쿠키를 버린다.
    expect(cookie).not.toContain("Secure");
  });

  it("spends a grant on its first exchange", async () => {
    const fixture = await startFixture();
    const grant = await issueGrant(fixture);

    const first = await joinWith(fixture, grant);
    const second = await joinWith(fixture, grant);

    expect(first.status).toBe(204);
    expect(second.status).toBe(401);
  });

  it("rejects a join that carries no usable grant", async () => {
    const fixture = await startFixture();

    await expect(joinWith(fixture, "never-issued").then((r) => r.status)).resolves.toBe(401);
    const empty = await fetch(`${fixture.endpoint}api/v1/join`, { method: "POST" });
    expect(empty.status).toBe(401);
  });

  it("answers a non-POST join or grant request with 405", async () => {
    const fixture = await startFixture();

    await expect(fetch(`${fixture.endpoint}api/v1/join`).then((r) => r.status)).resolves.toBe(405);
    await expect(fetch(`${fixture.endpoint}api/v1/access-grants`).then((r) => r.status)).resolves.toBe(405);
  });

  it("never leaks the lock token through the grant response", async () => {
    const fixture = await startFixture();

    const response = await fetch(`${fixture.endpoint}api/v1/access-grants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.lock.token}` },
    });

    expect(await response.text()).not.toContain(fixture.lock.token);
  });
});

async function issueGrant(fixture: Fixture): Promise<string> {
  const response = await fetch(`${fixture.endpoint}api/v1/access-grants`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.lock.token}` },
  });
  return (await response.json() as { token: string }).token;
}

function joinWith(fixture: Fixture, token: string): Promise<Response> {
  return fetch(`${fixture.endpoint}api/v1/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

async function startFixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-access-"));
  const dataRoot = path.join(dir, "fleet-home");
  tempDirs.push(dir);
  const server = createConsoleServer({
    port: 0,
    version: "test",
    agentRuntime: createFakeConsoleRuntime() as never,
    agentCliDetector: createStubAgentCliDetector(),
    dataDir: dataRoot,
    systemFonts: { getFonts: async () => [] },
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile: path.join(dir, "console.lock") });
  const lock = createConsoleLock().readLock(path.join(dir, "console.lock"))!;
  return { endpoint, lock };
}

function createStubAgentCliDetector(): AgentCliDetector {
  return { detect: async () => [] };
}

function createFakeConsoleRuntime(): unknown {
  const handlers = new Set<(event: unknown) => void>();
  return {
    carrierRuntime: {
      jobs: {
        streaming: {
          register(callback: (event: unknown) => void) {
            handlers.add(callback);
            return () => handlers.delete(callback);
          },
        },
      },
    },
    cleanup: vi.fn(async () => undefined),
  };
}
