import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGatewayLock } from "../src/lock.js";
import { createGatewayServer } from "../src/server.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("gateway call stream", () => {
  it("streams a queued MCP tool call to the tenant control connection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-stream-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"));
    expect(lock).not.toBeNull();

    const registration = await postJson(`${lock!.endpoint.replace("/mcp", "/admin/register")}`, lock!.token, {
      tenantLabel: "tenant",
      cwd: "/tmp",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });

    const stream = await fetch(lock!.endpoint.replace("/mcp", "/control/calls"), {
      headers: { Authorization: `Bearer ${registration.controlToken}` },
    });
    const reader = stream.body!.getReader();
    const mcpResponse = fetch(lock!.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${registration.sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } }),
    });
    const text = await readUntilData(reader);
    const payload = JSON.parse(text.match(/data: (.*)/)![1]!);

    await postJson(lock!.endpoint.replace("/mcp", `/control/results/${payload.callId}`), registration.controlToken, {
      sessionId: payload.sessionId,
      result: { content: [{ type: "text", text: "pong" }], isError: false },
    });
    await expect(mcpResponse.then((res) => res.json())).resolves.toMatchObject({
      result: { content: [{ text: "pong" }], isError: false },
    });
    reader.releaseLock();
    await server.stop();
  });

  it("writes JSON headers before a held tool call result is submitted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-stream-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;
    const registration = await postJson(`${lock.endpoint.replace("/mcp", "/admin/register")}`, lock.token, {
      tenantLabel: "tenant",
      cwd: "/tmp",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });
    const stream = await fetch(lock.endpoint.replace("/mcp", "/control/calls"), {
      headers: { Authorization: `Bearer ${registration.controlToken}` },
    });
    const reader = stream.body!.getReader();
    const held = postRawToolCall(lock.endpoint, registration.sessionToken);
    const response = await held.response;
    const text = await readUntilData(reader);
    const payload = JSON.parse(text.match(/data: (.*)/)![1]!);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    await postJson(lock.endpoint.replace("/mcp", `/control/results/${payload.callId}`), registration.controlToken, {
      sessionId: payload.sessionId,
      result: { content: [{ type: "text", text: "pong" }], isError: false },
    });
    await expect(held.body).resolves.toMatch(/"pong"/);
    reader.releaseLock();
    await server.stop();
  });

  it("writes JSON headers before a held batched tool call result is submitted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-stream-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;
    const registration = await postJson(`${lock.endpoint.replace("/mcp", "/admin/register")}`, lock.token, {
      tenantLabel: "tenant",
      cwd: "/tmp",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });
    const stream = await fetch(lock.endpoint.replace("/mcp", "/control/calls"), {
      headers: { Authorization: `Bearer ${registration.controlToken}` },
    });
    const reader = stream.body!.getReader();
    const held = postRawMcp(lock.endpoint, registration.sessionToken, [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } },
    ]);
    const response = await held.response;
    const text = await readUntilData(reader);
    const payload = JSON.parse(text.match(/data: (.*)/)![1]!);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    await postJson(lock.endpoint.replace("/mcp", `/control/results/${payload.callId}`), registration.controlToken, {
      sessionId: payload.sessionId,
      result: { content: [{ type: "text", text: "pong" }], isError: false },
    });
    await expect(held.body.then((body) => JSON.parse(body))).resolves.toMatchObject([
      { id: 1, result: { tools: [{ name: "ping" }] } },
      { id: 2, result: { content: [{ text: "pong" }], isError: false } },
    ]);
    reader.releaseLock();
    await server.stop();
  });

  it("redelivers an unresolved call when a new control stream subscribes after disconnect", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-stream-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;
    const registration = await postJson(`${lock.endpoint.replace("/mcp", "/admin/register")}`, lock.token, {
      tenantLabel: "tenant",
      cwd: "/tmp",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });
    const firstStream = await fetch(lock.endpoint.replace("/mcp", "/control/calls"), {
      headers: { Authorization: `Bearer ${registration.controlToken}` },
    });
    const firstReader = firstStream.body!.getReader();
    const mcpResponse = fetch(lock.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${registration.sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } }),
    });
    const firstText = await readUntilData(firstReader);
    const firstPayload = JSON.parse(firstText.match(/data: (.*)/)![1]!);
    await firstReader.cancel();
    await delay(10);

    const secondStream = await fetch(lock.endpoint.replace("/mcp", "/control/calls"), {
      headers: { Authorization: `Bearer ${registration.controlToken}` },
    });
    const secondReader = secondStream.body!.getReader();
    const secondText = await readUntilData(secondReader);
    const secondPayload = JSON.parse(secondText.match(/data: (.*)/)![1]!);

    expect(secondPayload.callId).toBe(firstPayload.callId);
    await postJson(lock.endpoint.replace("/mcp", `/control/results/${secondPayload.callId}`), registration.controlToken, {
      sessionId: secondPayload.sessionId,
      result: { content: [{ type: "text", text: "pong" }], isError: false },
    });
    await expect(mcpResponse.then((res) => res.json())).resolves.toMatchObject({
      result: { content: [{ text: "pong" }], isError: false },
    });
    await secondReader.cancel();
    await server.stop();
  });

  it("does not let a closed control stream consume newly queued calls", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-stream-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;
    const registration = await postJson(`${lock.endpoint.replace("/mcp", "/admin/register")}`, lock.token, {
      tenantLabel: "tenant",
      cwd: "/tmp",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });
    const deadStream = await fetch(lock.endpoint.replace("/mcp", "/control/calls"), {
      headers: { Authorization: `Bearer ${registration.controlToken}` },
    });
    const deadReader = deadStream.body!.getReader();
    await delay(10);
    await deadReader.cancel();
    await delay(10);
    const liveStream = await fetch(lock.endpoint.replace("/mcp", "/control/calls"), {
      headers: { Authorization: `Bearer ${registration.controlToken}` },
    });
    const liveReader = liveStream.body!.getReader();
    const mcpResponse = fetch(lock.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${registration.sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } }),
    });
    const text = await readUntilData(liveReader);
    const payload = JSON.parse(text.match(/data: (.*)/)![1]!);

    await postJson(lock.endpoint.replace("/mcp", `/control/results/${payload.callId}`), registration.controlToken, {
      sessionId: payload.sessionId,
      result: { content: [{ type: "text", text: "pong" }], isError: false },
    });
    await expect(mcpResponse.then((res) => res.json())).resolves.toMatchObject({
      result: { content: [{ text: "pong" }], isError: false },
    });
    await liveReader.cancel();
    await server.stop();
  });

  it("clears the held tool call keepalive timer when the MCP client disconnects", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-stream-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;
    const registration = await postJson(`${lock.endpoint.replace("/mcp", "/admin/register")}`, lock.token, {
      tenantLabel: "tenant",
      cwd: "/tmp",
      tools: [{ name: "ping", description: "Ping", inputSchema: {} }],
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const baselineTimers = vi.getTimerCount();
    const held = postRawToolCall(lock.endpoint, registration.sessionToken);
    void held.body.catch(() => undefined);
    const response = await held.response;
    expect(response.statusCode).toBe(200);
    const timersBeforeClose = vi.getTimerCount();
    expect(timersBeforeClose).toBeGreaterThan(baselineTimers);

    const closed = new Promise<void>((resolve) => {
      response.once("close", () => resolve());
    });
    held.request.destroy();
    response.destroy();
    await closed;
    await waitFor(() => vi.getTimerCount() < timersBeforeClose);

    expect(vi.getTimerCount()).toBeLessThan(timersBeforeClose);
    await server.stop();
    vi.useRealTimers();
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

async function readUntilData(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("data: ")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  return text;
}

function postRawToolCall(endpoint: string, token: string): { readonly request: http.ClientRequest; readonly response: Promise<http.IncomingMessage>; readonly body: Promise<string> } {
  return postRawMcp(endpoint, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } });
}

function postRawMcp(endpoint: string, token: string, payload: unknown): { readonly request: http.ClientRequest; readonly response: Promise<http.IncomingMessage>; readonly body: Promise<string> } {
  let bodyResolve!: (body: string) => void;
  let bodyReject!: (err: Error) => void;
  let request!: http.ClientRequest;
  const body = new Promise<string>((resolve, reject) => {
    bodyResolve = resolve;
    bodyReject = reject;
  });
  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    const url = new URL(endpoint);
    const req = http.request({
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }, (res) => {
      resolve(res);
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => bodyResolve(text));
    });
    req.on("error", (err) => {
      reject(err);
      bodyReject(err);
    });
    request = req;
    req.end(JSON.stringify(payload));
  });
  return { request, response, body };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) throw new Error("Timed out waiting for condition");
    await delay(5);
  }
}
