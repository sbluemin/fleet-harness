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
    expect(jobs.jobs[0].events[0].event).toMatchObject({ type: "track:text", text: "secret", textLength: 6 });
    expect(forbidden.status).toBe(401);
    await server.stop();
  });

  it("keeps observer and control tokens scoped to their tenant and role", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-observe-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;
    const first = await postJson(lock.endpoint.replace("/mcp", "/admin/register"), lock.token, {
      tenantLabel: "first",
      cwd: "/tmp/first",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });
    const second = await postJson(lock.endpoint.replace("/mcp", "/admin/register"), lock.token, {
      tenantLabel: "second",
      cwd: "/tmp/second",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });

    await postJson(lock.endpoint.replace("/mcp", "/control/events"), first.controlToken, {
      event: { type: "track:text", jobId: "first-job", trackId: "track", text: "first-secret" },
    });
    await postJson(lock.endpoint.replace("/mcp", "/control/events"), second.controlToken, {
      event: { type: "track:text", jobId: "second-job", trackId: "track", text: "second-secret" },
    });
    const firstJobs = await getJson(lock.endpoint.replace("/mcp", "/observer/jobs"), first.observerToken);
    const observerMcp = await fetch(lock.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${first.observerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const controlMcp = await fetch(lock.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${first.controlToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const crossTenantResult = await fetch(lock.endpoint.replace("/mcp", "/control/results/missing"), {
      method: "POST",
      headers: { Authorization: `Bearer ${first.controlToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: second.sessionId, result: { content: [], isError: false } }),
    });

    expect(JSON.stringify(firstJobs)).toContain("first-job");
    expect(JSON.stringify(firstJobs)).not.toContain("second-job");
    expect(observerMcp.status).toBe(401);
    expect(controlMcp.status).toBe(401);
    expect(crossTenantResult.status).toBe(403);
    await server.stop();
  });

  it("allows aggregate observer token to list tenants and read tenant job snapshots", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-observe-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;
    const first = await postJson(lock.endpoint.replace("/mcp", "/admin/register"), lock.token, {
      tenantLabel: "first",
      cwd: "/tmp/first",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });
    const second = await postJson(lock.endpoint.replace("/mcp", "/admin/register"), lock.token, {
      tenantLabel: "second",
      cwd: "/tmp/second",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });

    await postJson(lock.endpoint.replace("/mcp", "/control/events"), first.controlToken, {
      event: { type: "job:registered", jobId: "first-job", tracks: [] },
    });
    await postJson(lock.endpoint.replace("/mcp", "/control/events"), second.controlToken, {
      event: { type: "job:registered", jobId: "second-job", tracks: [] },
    });
    const tenants = await getJson(lock.endpoint.replace("/mcp", "/observer/tenants"), lock.observerToken);
    const oneTenant = await getJson(`${lock.endpoint.replace("/mcp", "/observer/jobs")}?tenant=${first.tenantId}`, lock.observerToken);
    const allTenants = await getJson(lock.endpoint.replace("/mcp", "/observer/jobs"), lock.observerToken);
    const aggregateMcp = await fetch(lock.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${lock.observerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(tenants.tenants).toHaveLength(2);
    expect(JSON.stringify(tenants)).not.toContain(first.controlToken);
    expect(JSON.stringify(oneTenant)).toContain("first-job");
    expect(JSON.stringify(oneTenant)).not.toContain("second-job");
    expect(JSON.stringify(allTenants)).toContain("first-job");
    expect(JSON.stringify(allTenants)).toContain("second-job");
    expect(aggregateMcp.status).toBe(401);
    await server.stop();
  });

  it("rejects aggregate observer token on tenant status without hanging", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-observe-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;

    const response = await fetch(lock.endpoint.replace("/mcp", "/observer/status"), {
      headers: { Authorization: `Bearer ${lock.observerToken}` },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "Unauthorized" });
    await server.stop();
  });

  it("streams all-tenant observer events with tenant identity for aggregate token", async () => {
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
      event: { type: "job:registered", jobId: "job-1", tracks: [] },
    });
    const response = await fetch(lock.endpoint.replace("/mcp", "/observer/events"), {
      headers: { Authorization: `Bearer ${lock.observerToken}` },
    });
    const chunk = await readFirstSseChunk(response);

    expect(chunk).toContain("event: job:registered");
    expect(chunk).toContain(registration.tenantId);
    expect(chunk).toContain("job-1");
    await server.stop();
  });

  it("streams events for tenants registered after aggregate observer connection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-observe-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;
    const response = await fetch(lock.endpoint.replace("/mcp", "/observer/events"), {
      headers: { Authorization: `Bearer ${lock.observerToken}` },
    });
    const reader = response.body?.getReader();
    expect(response.ok).toBe(true);
    expect(reader).toBeTruthy();

    const registration = await postJson(lock.endpoint.replace("/mcp", "/admin/register"), lock.token, {
      tenantLabel: "late",
      cwd: "/tmp/late",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });
    await postJson(lock.endpoint.replace("/mcp", "/control/events"), registration.controlToken, {
      event: { type: "job:registered", jobId: "late-job", tracks: [] },
    });
    const chunk = await readUntil(reader!, "late-job");

    expect(chunk).toContain("event: job:registered");
    expect(chunk).toContain(registration.tenantId);
    expect(chunk).toContain("late-job");
    await reader!.cancel();
    await server.stop();
  });

  it("revokes released tenant tokens and clears observer state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-release-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;
    const registration = await postJson(lock.endpoint.replace("/mcp", "/admin/register"), lock.token, {
      tenantLabel: "tenant",
      cwd: "/tmp",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });

    await postJson(lock.endpoint.replace("/mcp", "/control/release"), registration.controlToken, {});
    const sessionAfterRelease = await fetch(lock.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${registration.sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const observerAfterRelease = await fetch(lock.endpoint.replace("/mcp", "/observer/status"), {
      headers: { Authorization: `Bearer ${registration.observerToken}` },
    });
    const controlAfterRelease = await fetch(lock.endpoint.replace("/mcp", "/control/events"), {
      method: "POST",
      headers: { Authorization: `Bearer ${registration.controlToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ event: { type: "job:registered" } }),
    });

    expect(sessionAfterRelease.status).toBe(401);
    expect(observerAfterRelease.status).toBe(401);
    expect(controlAfterRelease.status).toBe(401);
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

async function readFirstSseChunk(response: Response): Promise<string> {
  expect(response.ok).toBe(true);
  const reader = response.body?.getReader();
  expect(reader).toBeTruthy();
  const decoder = new TextDecoder();
  let text = "";
  for (let index = 0; index < 5; index += 1) {
    const result = await reader!.read();
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
    if (text.includes("\n\n")) break;
  }
  await reader!.cancel();
  return text;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (let index = 0; index < 10; index += 1) {
    const result = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 2_000);
      }),
    ]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
    if (text.includes(expected)) break;
  }
  return text;
}
