import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleServer, type ConsoleServer } from "../core/host/bootstrap/server.js";

interface Fixture {
  readonly endpoint: string;
}

const servers: ConsoleServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.stop();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { force: true, recursive: true });
});

describe("access join route", () => {
  it("rejects a join that carries no usable grant", async () => {
    const fixture = await startFixture();

    await expect(joinWith(fixture, "never-issued").then((r) => r.status)).resolves.toBe(401);
    const empty = await fetch(`${fixture.endpoint}api/v1/join`, { method: "POST" });
    expect(empty.status).toBe(401);
  });

  it("answers a non-POST join request with 405", async () => {
    const fixture = await startFixture();

    await expect(fetch(`${fixture.endpoint}api/v1/join`).then((r) => r.status)).resolves.toBe(405);
  });
});

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
    dataDir: dataRoot,
    systemFonts: { getFonts: async () => [] },
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile: path.join(dir, "console.lock") });
  return { endpoint };
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
