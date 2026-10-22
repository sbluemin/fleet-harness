import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startCodexTestServer } from "./codex-test-server.js";
import { buildAllowedAccessSets } from "../../fleet-plugins/codex/server/codex/gateway.js";
import { handleApiRequest } from "../../fleet-plugins/codex/server/codex/routes.js";
import type { CodexTestServer } from "./codex-test-server.js";

let server: CodexTestServer | null = null;
let baseUrl = "";
let tempDir = "";

describe("security routes", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-console-codex-routes-"));
    const wikiDir = path.join(tempDir, ".fleet", "knowledge", "wiki");
    const rawDir = path.join(tempDir, ".fleet", "knowledge", "raw");
    await mkdir(wikiDir, { recursive: true });
    await mkdir(rawDir, { recursive: true });
    await writeEntry(wikiDir, "valid-id", "Valid Entry", "Body", "raw/sample.md");
    await writeEntry(
      wikiDir,
      "search-excerpt",
      "Search Excerpt",
      `${"introductory context ".repeat(12)}Drydock approval keeps proposed changes behind a human review gate.`,
    );
    await writeFile(path.join(rawDir, "sample.md"), "raw content body", "utf8");
    const lockPath = path.join(tempDir, "server.lock");
    server = await startCodexTestServer({ cwd: tempDir, lockPath, port: 0, host: "127.0.0.1" });
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { port: number };
    baseUrl = `http://127.0.0.1:${lock.port}/console/codex`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects encoded path traversal entry ids", async () => {
    const response = await fetch(`${baseUrl}/api/entry/..%2Fraw%2Fxx`);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid entry id" });
    expect(response.status).toBe(400);
  });

  it("rejects requests with a Host header outside the allowlist", async () => {
    const response = await requestWithHost("/api/search", "attacker.example:3737");
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("host_mismatch");
  });
});

describe("loopback-only origin check", () => {
  let loopbackServer: CodexTestServer | null = null;
  let loopbackTempDir = "";
  let loopbackPort = 0;

  function postWithOrigin(origin: string | undefined, entryId: string): Promise<{ statusCode: number }> {
    return new Promise((resolve, reject) => {
      const requestBody = JSON.stringify({ expectedHash: "test" });
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(requestBody)),
      };
      if (origin !== undefined) headers["Origin"] = origin;
      const req = http.request(
        { hostname: "127.0.0.1", port: loopbackPort, path: codexPath(`/api/entry/${entryId}/delete`), method: "POST", headers },
        (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ statusCode: res.statusCode ?? 0 }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.write(requestBody);
      req.end();
    });
  }

  beforeEach(async () => {
    loopbackTempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-console-codex-loopback-"));
    const wikiDir = path.join(loopbackTempDir, ".fleet", "knowledge", "wiki");
    await mkdir(wikiDir, { recursive: true });
    await writeEntry(wikiDir, "wc-entry", "Wildcard Entry", "Body");
    const lockPath = path.join(loopbackTempDir, "server.lock");
    loopbackServer = await startCodexTestServer({ cwd: loopbackTempDir, lockPath, port: 0 });
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { port: number };
    loopbackPort = lock.port;
  });

  afterEach(async () => {
    if (loopbackServer) await new Promise<void>((resolve) => loopbackServer?.close(() => resolve()));
    loopbackServer = null;
    if (loopbackTempDir) await rm(loopbackTempDir, { recursive: true, force: true });
  });

  it("allows POST with exact 127.0.0.1 origin", async () => {
    const { statusCode } = await postWithOrigin(`http://127.0.0.1:${loopbackPort}`, "wc-entry");
    expect(statusCode).not.toBe(403);
  });

  it("rejects entry writes the listener did not admit, before Origin validation", async () => {
    const response = createResponseRecorder();
    await handleApiRequest(
      createRouteRequest(`/api/entry/valid-id/delete`, "POST", "192.168.1.10"),
      response.response,
      createMinimalRouteContext({ admitted: false }),
    );
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("write_loopback_only");
  });
});

async function writeEntry(wikiDir: string, id: string, title: string, body: string, rawSourceRef?: string): Promise<void> {
  const lines = [
    "---",
    `id: "${id}"`,
    `title: "${title}"`,
    "tags: []",
    "created: \"2026-05-04T00:00:00.000Z\"",
    "updated: \"2026-05-04T00:00:00.000Z\"",
    "version: 1",
  ];
  if (rawSourceRef) lines.push(`rawSourceRef: "${rawSourceRef}"`);
  lines.push("---", body);
  await writeFile(path.join(wikiDir, `${id}.md`), lines.join("\n"), "utf8");
}

function requestWithHost(requestPath: string, hostHeader: string): Promise<{ statusCode: number; body: string }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(url.port),
        path: codexPath(requestPath),
        method: "GET",
        headers: { Host: hostHeader },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function codexPath(pathname: string): string {
  return `/console/codex${pathname}`;
}

function rawHttpRequest(payload: string): Promise<string> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), "127.0.0.1", () => {
      socket.write(payload);
    });
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString("utf8"); });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

function requestRawHost(port: number, hostHeader: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: codexPath("/api/search"),
        method: "GET",
        headers: { Host: `${hostHeader}:${port}` },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function findNonLoopbackIpv4(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

function createMinimalRouteContext(
  overrides: { admitted?: boolean; allowedOrigins?: Set<string> } = {},
): Parameters<typeof handleApiRequest>[2] {
  return {
    cwd: tempDir || "/tmp/fleet-console-codex-test",
    knowledgeRoot: path.join(tempDir || "/tmp/fleet-console-codex-test", ".fleet", "knowledge"),
    paths: {
      root: "",
      wikiDir: "",
      rawDir: "",
      schemaDir: "",
      historyDir: "",
      indexFile: "",
    },
    port: 3737,
    host: "127.0.0.1",
    workspaceId: "test-workspace",
    allowedOrigins: overrides.allowedOrigins ?? new Set(["http://127.0.0.1:3737"]),
    externalMode: false,
    admitted: overrides.admitted ?? true,
  };
}

function createResponseRecorder(): { response: ServerResponse; statusCode: number; body: string } {
  const recorder = {
    statusCode: 0,
    body: "",
    response: {
      writeHead(statusCode: number) {
        recorder.statusCode = statusCode;
        return this;
      },
      end(chunk?: unknown) {
        recorder.body += chunk === undefined ? "" : String(chunk);
        return this;
      },
    } as unknown as ServerResponse,
  };
  return recorder;
}

function createRouteRequest(url: string, method: string, remoteAddress: string): Parameters<typeof handleApiRequest>[0] {
  return {
    headers: {},
    method,
    socket: { remoteAddress },
    url,
  } as Parameters<typeof handleApiRequest>[0];
}
