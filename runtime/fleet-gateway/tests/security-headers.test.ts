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

describe("gateway security headers", () => {
  it("attaches security headers to JSON, SSE, and static responses", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-security-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;
    const registration = await postJson(lock.endpoint.replace("/mcp", "/admin/register"), lock.token, {
      tenantLabel: "tenant",
      cwd: "/tmp",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });

    const json = await fetch(lock.endpoint.replace("/mcp", "/observer/jobs"), { headers: { Authorization: `Bearer ${registration.observerToken}` } });
    const sse = await fetch(lock.endpoint.replace("/mcp", "/observer/events"), { headers: { Authorization: `Bearer ${registration.observerToken}` } });
    const html = await fetch(lock.endpoint.replace("/mcp", "/console/"));

    for (const response of [json, sse, html]) {
      expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    await sse.body?.cancel();
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
