import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGatewayLock } from "../src/lock.js";
import { createGatewayServer } from "../src/server.js";

const CONSOLE_ROOT = fileURLToPath(new URL("../dist/client/", import.meta.url));
const CONSOLE_INDEX_PATH = path.join(CONSOLE_ROOT, "index.html");
const FIXTURE_INDEX_HTML = "<!doctype html><html><body>Fleet Console fixture</body></html>";

const tempDirs: string[] = [];
let createdConsoleRoot = false;
let backupIndexHtml: Buffer | null = null;

// dist/client는 fleet-console 빌드 산출물의 embed 위치이므로,
// 테스트는 fixture index.html을 설치하고 종료 시 원상 복구한다.
beforeEach(() => {
  createdConsoleRoot = !fs.existsSync(CONSOLE_ROOT);
  if (createdConsoleRoot) fs.mkdirSync(CONSOLE_ROOT, { recursive: true });
  backupIndexHtml = fs.existsSync(CONSOLE_INDEX_PATH) ? fs.readFileSync(CONSOLE_INDEX_PATH) : null;
  fs.writeFileSync(CONSOLE_INDEX_PATH, FIXTURE_INDEX_HTML);
});

afterEach(() => {
  if (backupIndexHtml) {
    fs.writeFileSync(CONSOLE_INDEX_PATH, backupIndexHtml);
  } else {
    fs.rmSync(CONSOLE_INDEX_PATH, { force: true });
  }
  if (createdConsoleRoot) fs.rmSync(CONSOLE_ROOT, { recursive: true, force: true });
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("gateway static console", () => {
  it("serves console index and rejects host mismatch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-static-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;

    const consoleResponse = await fetch(lock.endpoint.replace("/mcp", "/console/"));
    const mismatch = await requestWithHost(lock.endpoint.replace("/mcp", "/health"), "localhost:37283", lock.token);

    expect(consoleResponse.ok).toBe(true);
    expect(await consoleResponse.text()).toContain("Fleet Console fixture");
    expect(mismatch.statusCode).toBe(403);
    await server.stop();
  });

  it("falls back to index.html for extensionless SPA routes and 404s missing assets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-static-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;

    const spaRoute = await fetch(lock.endpoint.replace("/mcp", "/console/jobs/active"));
    const missingAsset = await fetch(lock.endpoint.replace("/mcp", "/console/missing-asset.css"));

    expect(spaRoute.ok).toBe(true);
    expect(await spaRoute.text()).toContain("Fleet Console fixture");
    expect(missingAsset.status).toBe(404);
    await server.stop();
  });

  it("absorbs malformed percent-encoding and NUL paths as secured 404 without crashing the daemon", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-static-"));
    tempDirs.push(dir);
    const server = createGatewayServer({ port: 0, version: "test" });
    await server.start({ dir, lockFile: path.join(dir, "gateway.lock") });
    const lock = createGatewayLock().readLock(path.join(dir, "gateway.lock"))!;

    const malformedEncoding = await fetch(lock.endpoint.replace("/mcp", "/console/%zz.css"));
    const nulPath = await fetch(lock.endpoint.replace("/mcp", "/console/%00.css"));
    const stillAlive = await fetch(lock.endpoint.replace("/mcp", "/console/"));

    expect(malformedEncoding.status).toBe(404);
    expect(malformedEncoding.headers.get("cache-control")).toBe("no-store");
    expect(nulPath.status).toBe(404);
    expect(nulPath.headers.get("cache-control")).toBe("no-store");
    expect(stillAlive.ok).toBe(true);
    await server.stop();
  });
});

async function requestWithHost(url: string, host: string, token: string): Promise<{ readonly statusCode: number }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Host: host },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0 }));
    });
    request.on("error", reject);
    request.end();
  });
}
