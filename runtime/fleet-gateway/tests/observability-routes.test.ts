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

describe("gateway observability routes", () => {
  it("accepts control events and exposes observer read-only views", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-observe-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;
    const registration = await postJson(lock.endpoint.replace("/mcp", "/admin/register"), lock.token, {
      tenantLabel: "tenant",
      cwd: "/tmp",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });

    await postJson(lock.endpoint.replace("/mcp", "/control/events"), registration.controlToken, {
      event: { type: "track:text", jobId: "job-1", trackId: "track", text: "secret" },
    });
    const status = await getJson(lock.endpoint.replace("/mcp", "/observer/status"), registration.observerToken);
    const jobs = await getJson(lock.endpoint.replace("/mcp", "/observer/jobs"), registration.observerToken);
    const forbidden = await fetch(lock.endpoint.replace("/mcp", "/control/events"), {
      method: "POST",
      headers: { Authorization: `Bearer ${registration.observerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ event: { type: "job:registered" } }),
    });

    expect(status).toMatchObject({ tenantLabel: "tenant", jobs: 1, events: 1 });
    expect(jobs.jobs[0].events[0].event).toMatchObject({ type: "track:text", textLength: 6 });
    expect(JSON.stringify(jobs)).not.toContain("secret");
    expect(forbidden.status).toBe(401);
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

async function getJson(url: string, token: string): Promise<any> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok).toBe(true);
  return response.json();
}
