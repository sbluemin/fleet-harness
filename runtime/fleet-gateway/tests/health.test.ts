import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGatewayLock } from "../src/lock.js";
import { createGatewayServer } from "../src/server.js";
import { createGatewayHealthClient } from "../src/health.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("gateway health client", () => {
  it("returns unhealthy when the lock is missing", async () => {
    await expect(createGatewayHealthClient().probe(null)).resolves.toMatchObject({ healthy: false, lock: null });
  });

  it("reports the active tenant count", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-health-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;

    await postJson(lock.endpoint.replace("/mcp", "/admin/register"), lock.token, {
      tenantLabel: "tenant",
      cwd: "/tmp",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });

    await expect(createGatewayHealthClient().probe(lock)).resolves.toMatchObject({
      healthy: true,
      health: { tenantCount: 1 },
    });
    await server.stop();
  });
});

async function postJson(url: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}
