import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGatewayLock } from "../src/lock.js";
import { createGatewayServer } from "../src/server.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("gateway MCP invalid request bodies", () => {
  it("returns 4xx JSON for malformed and oversized bodies without stopping later requests", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-invalid-body-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;
    const registration = await postJson(lock.endpoint.replace("/mcp", "/admin/register"), lock.token, {
      tenantLabel: "tenant",
      cwd: "/tmp",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });

    const malformed = await postRaw(lock.endpoint, registration.sessionToken, "{");
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(malformed.status).toBeLessThan(500);
    await expect(malformed.json()).resolves.toMatchObject({ error: "Invalid JSON-RPC payload" });
    await expect(postMcp(lock.endpoint, registration.sessionToken)).resolves.toMatchObject({
      result: { tools: [{ name: "ping" }] },
    });

    const oversized = await postRaw(lock.endpoint, registration.sessionToken, "x".repeat(1024 * 1024 + 1));
    expect(oversized.status).toBeGreaterThanOrEqual(400);
    expect(oversized.status).toBeLessThan(500);
    await expect(oversized.json()).resolves.toMatchObject({ error: "Invalid JSON-RPC payload" });
    await expect(postMcp(lock.endpoint, registration.sessionToken)).resolves.toMatchObject({
      result: { tools: [{ name: "ping" }] },
    });

    await server.stop();
  });
});

async function postJson(url: string, token: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}

async function postMcp(url: string, token: string): Promise<any> {
  return postJson(url, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
}

async function postRaw(url: string, token: string, body: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
}
