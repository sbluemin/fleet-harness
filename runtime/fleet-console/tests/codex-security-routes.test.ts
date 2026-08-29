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

// 테스트 픽스처용 유효한 patchId
const VALID_PATCH_ID = "2026-05-04T03-15-55-143Z-51756575";

describe("security routes", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-console-codex-routes-"));
    const wikiDir = path.join(tempDir, ".fleet", "knowledge", "wiki");
    const rawDir = path.join(tempDir, ".fleet", "knowledge", "raw");
    const queueDir = path.join(tempDir, ".fleet", "knowledge", "queue");
    const archiveDir = path.join(tempDir, ".fleet", "knowledge", "archive");
    const conflictsDir = path.join(tempDir, ".fleet", "knowledge", "conflicts");
    await mkdir(wikiDir, { recursive: true });
    await mkdir(rawDir, { recursive: true });
    await mkdir(path.join(queueDir, VALID_PATCH_ID), { recursive: true });
    await mkdir(path.join(archiveDir, VALID_PATCH_ID), { recursive: true });
    await mkdir(path.join(conflictsDir, "conflict-alpha"), { recursive: true });
    await writeEntry(wikiDir, "valid-id", "Valid Entry", "Body", "raw/sample.md");
    await writeEntry(
      wikiDir,
      "search-excerpt",
      "Search Excerpt",
      `${"introductory context ".repeat(12)}Drydock approval keeps proposed changes behind a human review gate.`,
    );
    await writeFile(path.join(rawDir, "sample.md"), "raw content body", "utf8");
    await writeFile(path.join(conflictsDir, "conflict-alpha", "meta.json"), JSON.stringify({
      id: "conflict-alpha",
      status: "unresolved",
      createdAt: "2026-05-05T00:00:00.000Z",
      wikiId: "valid-id",
      target: "wiki/valid-id.md",
    }), "utf8");
    await writeFile(path.join(conflictsDir, "conflict-alpha", "proposed.md"), "# proposed", "utf8");
    // pending 패치 픽스처
    await writePatch(queueDir, VALID_PATCH_ID, "valid-id", "테스트 요약", "pending");
    // archive 패치 픽스처
    await writePatch(archiveDir, VALID_PATCH_ID, "valid-id", "테스트 요약", "accepted");
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

  it("rejects entry ids containing slashes", async () => {
    const response = await fetch(`${baseUrl}/api/entry/with/slash`);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid entry id" });
    expect(response.status).toBe(400);
  });

  it("allows syntactically valid missing ids to reach 404", async () => {
    const response = await fetch(`${baseUrl}/api/entry/missing-id`);
    await expect(response.json()).resolves.toMatchObject({ error: "not_found" });
    expect(response.status).toBe(404);
  });

  it("bounds search query length and tag count", async () => {
    const longQuery = "a".repeat(257);
    const tooManyTags = Array.from({ length: 17 }, (_, index) => `tag-${index}`).join(",");
    const queryResponse = await fetch(`${baseUrl}/api/search?q=${longQuery}`);
    const tagsResponse = await fetch(`${baseUrl}/api/search?tags=${tooManyTags}`);
    expect(queryResponse.status).toBe(400);
    expect(tagsResponse.status).toBe(400);
  });

  it("returns a query-centered search excerpt without Fleet Wiki scaffolding", async () => {
    const response = await fetch(`${baseUrl}/api/search?q=drydock`);
    expect(response.status).toBe(200);
    const data = await response.json() as { entries: Array<{ id: string; excerpt?: string }> };
    const excerpt = data.entries.find((entry) => entry.id === "search-excerpt")?.excerpt;

    expect(excerpt?.toLowerCase()).toContain("drydock");
    expect(excerpt).not.toContain("<<<FLEET_WIKI_ENTRY_BEGIN");
    expect(excerpt).not.toContain("<<<FLEET_WIKI_ENTRY_END>>>");
    expect(excerpt).not.toMatch(/^---/);
  });

  it("rejects non-GET and non-HEAD methods at the server boundary", async () => {
    const response = await fetch(`${baseUrl}/api/index`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("rejects requests with a Host header outside the allowlist", async () => {
    const response = await requestWithHost("/api/search", "attacker.example:3737");
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("host_mismatch");
  });

  it("rejects absolute-form request targets before routing", async () => {
    const response = await rawHttpRequest([
      "GET http://attacker.example/console/codex/api/search HTTP/1.1",
      `Host: 127.0.0.1:${new URL(baseUrl).port}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"));
    expect(response).toContain("403");
    expect(response).toContain("host_mismatch");
  });

  it("rejects duplicate Host headers", async () => {
    const response = await rawHttpRequest([
      "GET /console/codex/api/search HTTP/1.1",
      `Host: 127.0.0.1:${new URL(baseUrl).port}`,
      `Host: localhost:${new URL(baseUrl).port}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"));
    expect(response).toContain("403");
    expect(response).toContain("host_mismatch");
  });

  it("rejects IPv4-mapped Host headers", async () => {
    const response = await rawHttpRequest([
      "GET /console/codex/api/search HTTP/1.1",
      `Host: [::ffff:127.0.0.1]:${new URL(baseUrl).port}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"));
    expect(response).toContain("403");
    expect(response).toContain("host_mismatch");
  });

  it("converts malformed static URLs to 400", async () => {
    const response = await fetch(`${baseUrl}/%E0%A4%A`);
    await expect(response.json()).resolves.toMatchObject({ error: "bad request" });
    expect(response.status).toBe(400);
  });

  it("embeds raw source content in entry response via ?include=raw", async () => {
    const response = await fetch(`${baseUrl}/api/entry/valid-id?include=raw`);
    expect(response.status).toBe(200);
    const data = await response.json() as { frontmatter: { id: string }; raw?: Array<{ ref: string; content: string }> };
    expect(data.frontmatter.id).toBe("valid-id");
    expect(Array.isArray(data.raw)).toBe(true);
    expect(data.raw?.[0]).toMatchObject({ ref: "raw/sample.md", content: "raw content body" });
  });

  it("deprecated /api/raw endpoint returns 404", async () => {
    const valid = await fetch(`${baseUrl}/api/raw?ref=${encodeURIComponent("raw/sample.md")}`);
    const invalid = await fetch(`${baseUrl}/api/raw?ref=${encodeURIComponent("etc/passwd")}`);
    expect(valid.status).toBe(404);
    expect(invalid.status).toBe(404);
  });

  it("rejects drydock patchId that does not match SAFE_PATCH_ID", async () => {
    const response = await fetch(`${baseUrl}/api/drydock/..%2Fwiki%2Fvalid-id`);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_patch_id" });
    expect(response.status).toBe(400);
  });

  it("rejects drydock patchId with directory traversal", async () => {
    const response = await fetch(`${baseUrl}/api/drydock/${encodeURIComponent("2026-05-04T03-15-55-143Z-51756575/../../../etc/passwd")}`);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_patch_id" });
    expect(response.status).toBe(400);
  });

  it("returns 404 for non-existent patchId with valid format", async () => {
    const missingId = "2099-01-01T00-00-00-000Z-00000000";
    const response = await fetch(`${baseUrl}/api/drydock/${encodeURIComponent(missingId)}`);
    await expect(response.json()).resolves.toMatchObject({ error: "patch_not_found" });
    expect(response.status).toBe(404);
  });

  it("returns 200 for a pending patch in queueDir", async () => {
    const response = await fetch(`${baseUrl}/api/drydock/${encodeURIComponent(VALID_PATCH_ID)}`);
    expect(response.status).toBe(200);
    const data = await response.json() as { source: string; meta: { status: string } };
    expect(data.source).toBe("queue");
    expect(data.meta.status).toBe("pending");
  });

  it("returns patch detail with raw body preview when patch body is not JSON", async () => {
    const malformedBodyPatchId = "2026-05-04T04-00-00-000Z-bad0cafe";
    const queueDir = path.join(tempDir, ".fleet", "knowledge", "queue");
    const patchDir = path.join(queueDir, malformedBodyPatchId);
    await mkdir(patchDir, { recursive: true });
    await writeFile(path.join(patchDir, "patch.md"), [
      "---",
      `op: "update_wiki"`,
      `target: "wiki/valid-id.md"`,
      `summary: "Raw body patch"`,
      `proposer: "test"`,
      `created: "2026-05-04T04:00:00.000Z"`,
      "---",
      "This is not a JSON WikiEntry body.",
    ].join("\n"), "utf8");
    await writeFile(path.join(patchDir, "meta.json"), JSON.stringify({
      id: malformedBodyPatchId,
      status: "pending",
      createdAt: "2026-05-04T04:00:00.000Z",
    }), "utf8");

    const response = await fetch(`${baseUrl}/api/drydock/${encodeURIComponent(malformedBodyPatchId)}`);

    expect(response.status).toBe(200);
    const data = await response.json() as { wikiEntry: { id: string; body: string }; targetExists: boolean };
    expect(data.wikiEntry.id).toBe("valid-id");
    expect(data.wikiEntry.body).toBe("This is not a JSON WikiEntry body.");
    expect(data.targetExists).toBe(true);
  });

  it("returns raw body preview when patch body is valid JSON but not WikiEntry-shaped", async () => {
    const malformedJsonPatchId = "2026-05-04T05-00-00-000Z-bad1face";
    const queueDir = path.join(tempDir, ".fleet", "knowledge", "queue");
    const patchDir = path.join(queueDir, malformedJsonPatchId);
    await mkdir(patchDir, { recursive: true });
    await writeFile(path.join(patchDir, "patch.md"), [
      "---",
      `op: "update_wiki"`,
      `target: "wiki/valid-id.md"`,
      `summary: "JSON-shaped patch"`,
      `proposer: "test"`,
      `created: "2026-05-04T05:00:00.000Z"`,
      "---",
      `[1, 2, 3]`,
    ].join("\n"), "utf8");
    await writeFile(path.join(patchDir, "meta.json"), JSON.stringify({
      id: malformedJsonPatchId,
      status: "pending",
      createdAt: "2026-05-04T05:00:00.000Z",
    }), "utf8");

    const response = await fetch(`${baseUrl}/api/drydock/${encodeURIComponent(malformedJsonPatchId)}`);

    expect(response.status).toBe(200);
    const data = await response.json() as { wikiEntry: { id: string; body: string }; targetExists: boolean };
    expect(data.wikiEntry.id).toBe("valid-id");
    expect(data.wikiEntry.body).toBe("[1, 2, 3]");
    expect(data.targetExists).toBe(true);
  });

  it("returns raw body preview when patch body is a JSON null", async () => {
    const nullBodyPatchId = "2026-05-04T06-00-00-000Z-bad2face";
    const queueDir = path.join(tempDir, ".fleet", "knowledge", "queue");
    const patchDir = path.join(queueDir, nullBodyPatchId);
    await mkdir(patchDir, { recursive: true });
    await writeFile(path.join(patchDir, "patch.md"), [
      "---",
      `op: "update_wiki"`,
      `target: "wiki/valid-id.md"`,
      `summary: "Null JSON patch"`,
      `proposer: "test"`,
      `created: "2026-05-04T06:00:00.000Z"`,
      "---",
      `null`,
    ].join("\n"), "utf8");
    await writeFile(path.join(patchDir, "meta.json"), JSON.stringify({
      id: nullBodyPatchId,
      status: "pending",
      createdAt: "2026-05-04T06:00:00.000Z",
    }), "utf8");

    const response = await fetch(`${baseUrl}/api/drydock/${encodeURIComponent(nullBodyPatchId)}`);

    expect(response.status).toBe(200);
    const data = await response.json() as { wikiEntry: { id: string; body: string } };
    expect(data.wikiEntry.id).toBe("valid-id");
    expect(data.wikiEntry.body).toBe("null");
  });

  it("returns raw body preview when patch body is a JSON object missing id and body", async () => {
    const partialBodyPatchId = "2026-05-04T07-00-00-000Z-bad3face";
    const queueDir = path.join(tempDir, ".fleet", "knowledge", "queue");
    const patchDir = path.join(queueDir, partialBodyPatchId);
    await mkdir(patchDir, { recursive: true });
    await writeFile(path.join(patchDir, "patch.md"), [
      "---",
      `op: "update_wiki"`,
      `target: "wiki/valid-id.md"`,
      `summary: "Partial JSON patch"`,
      `proposer: "test"`,
      `created: "2026-05-04T07:00:00.000Z"`,
      "---",
      `{"title": "no id or body"}`,
    ].join("\n"), "utf8");
    await writeFile(path.join(patchDir, "meta.json"), JSON.stringify({
      id: partialBodyPatchId,
      status: "pending",
      createdAt: "2026-05-04T07:00:00.000Z",
    }), "utf8");

    const response = await fetch(`${baseUrl}/api/drydock/${encodeURIComponent(partialBodyPatchId)}`);

    expect(response.status).toBe(200);
    const data = await response.json() as { wikiEntry: { id: string; body: string } };
    expect(data.wikiEntry.id).toBe("valid-id");
    expect(data.wikiEntry.body).toBe(`{"title": "no id or body"}`);
  });

  it("returns drydock list with correct pendingCount", async () => {
    const response = await fetch(`${baseUrl}/api/drydock?status=pending`);
    expect(response.status).toBe(200);
    const data = await response.json() as { items: unknown[]; pendingCount: number };
    expect(data.pendingCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(data.items)).toBe(true);
  });

  it("always returns archivedCount even when status=pending", async () => {
    const response = await fetch(`${baseUrl}/api/drydock?status=pending`);
    expect(response.status).toBe(200);
    const data = await response.json() as { items: unknown[]; pendingCount: number; archivedCount: number };
    expect(data.pendingCount).toBeGreaterThanOrEqual(1);
    expect(data.archivedCount).toBeGreaterThanOrEqual(1);
  });

  it("always returns pendingCount even when status=archived", async () => {
    const response = await fetch(`${baseUrl}/api/drydock?status=archived`);
    expect(response.status).toBe(200);
    const data = await response.json() as { items: unknown[]; pendingCount: number; archivedCount: number };
    expect(data.archivedCount).toBeGreaterThanOrEqual(1);
    expect(data.pendingCount).toBeGreaterThanOrEqual(1);
  });

  it("deprecated index-md and log endpoints return 404", async () => {
    const indexResponse = await fetch(`${baseUrl}/api/index-md`);
    const logResponse = await fetch(`${baseUrl}/api/log?limit=1`);
    expect(indexResponse.status).toBe(404);
    expect(logResponse.status).toBe(404);
  });

  it("rejects traversal-like conflict ids and returns detail for valid ids", async () => {
    const bad = await fetch(`${baseUrl}/api/conflicts/${encodeURIComponent("../etc/passwd")}`);
    const encodedSlash = await fetch(`${baseUrl}/api/conflicts/${encodeURIComponent("alpha/beta")}`);
    const good = await fetch(`${baseUrl}/api/conflicts/conflict-alpha`);

    expect(bad.status).toBe(400);
    expect(encodedSlash.status).toBe(400);
    expect(good.status).toBe(200);
    await expect(good.json()).resolves.toMatchObject({ id: "conflict-alpha" });
  });

  it("lists conflicts", async () => {
    const conflictsResponse = await fetch(`${baseUrl}/api/conflicts`);

    expect(conflictsResponse.status).toBe(200);
    await expect(conflictsResponse.json()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "conflict-alpha", status: "open" }),
    ]));
  });
});

describe("loopback-only origin check", () => {
  let loopbackServer: CodexTestServer | null = null;
  let loopbackTempDir = "";
  let loopbackPort = 0;

  function postWithOrigin(origin: string | undefined, patchId: string): Promise<{ statusCode: number }> {
    return new Promise((resolve, reject) => {
      const requestBody = JSON.stringify({ action: "approve" });
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(requestBody)),
      };
      if (origin !== undefined) headers["Origin"] = origin;
      const req = http.request(
        { hostname: "127.0.0.1", port: loopbackPort, path: codexPath(`/api/drydock/${patchId}/decision`), method: "POST", headers },
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

  it("rejects POST with LAN IP origin", async () => {
    const queueDir = path.join(loopbackTempDir, ".fleet", "knowledge", "queue");
    const pid = "2026-05-06T10-00-00-000Z-00cafe01";
    await mkdir(path.join(queueDir, pid), { recursive: true });
    await writePatch(queueDir, pid, "wc-entry", "패치", "pending");
    const { statusCode } = await postWithOrigin(`http://192.168.1.100:${loopbackPort}`, pid);
    expect(statusCode).toBe(403);
  });

  it("rejects POST with localhost origin", async () => {
    const queueDir = path.join(loopbackTempDir, ".fleet", "knowledge", "queue");
    const pid = "2026-05-06T10-01-00-000Z-00cafe02";
    await mkdir(path.join(queueDir, pid), { recursive: true });
    await writePatch(queueDir, pid, "wc-entry", "패치", "pending");
    const { statusCode } = await postWithOrigin(`http://localhost:${loopbackPort}`, pid);
    expect(statusCode).toBe(403);
  });

  it("allows POST with exact 127.0.0.1 origin", async () => {
    const queueDir = path.join(loopbackTempDir, ".fleet", "knowledge", "queue");
    const pid = "2026-05-06T10-02-00-000Z-00cafe03";
    await mkdir(path.join(queueDir, pid), { recursive: true });
    await writePatch(queueDir, pid, "wc-entry", "패치", "pending");
    const { statusCode } = await postWithOrigin(`http://127.0.0.1:${loopbackPort}`, pid);
    expect(statusCode).not.toBe(403);
  });

  it("rejects POST with wrong port origin", async () => {
    const queueDir = path.join(loopbackTempDir, ".fleet", "knowledge", "queue");
    const pid = "2026-05-06T10-02-00-000Z-00cafe03";
    await mkdir(path.join(queueDir, pid), { recursive: true });
    await writePatch(queueDir, pid, "wc-entry", "패치", "pending");
    const { statusCode } = await postWithOrigin(`http://127.0.0.1:${loopbackPort + 1}`, pid);
    expect(statusCode).toBe(403);
  });

  it("rejects POST with https origin", async () => {
    const queueDir = path.join(loopbackTempDir, ".fleet", "knowledge", "queue");
    const pid = "2026-05-06T10-03-00-000Z-00cafe04";
    await mkdir(path.join(queueDir, pid), { recursive: true });
    await writePatch(queueDir, pid, "wc-entry", "패치", "pending");
    const { statusCode } = await postWithOrigin(`https://127.0.0.1:${loopbackPort}`, pid);
    expect(statusCode).toBe(403);
  });

  it("rejects POST with no Origin header", async () => {
    const queueDir = path.join(loopbackTempDir, ".fleet", "knowledge", "queue");
    const pid = "2026-05-06T10-04-00-000Z-00cafe05";
    await mkdir(path.join(queueDir, pid), { recursive: true });
    await writePatch(queueDir, pid, "wc-entry", "패치", "pending");
    const { statusCode } = await postWithOrigin(undefined, pid);
    expect(statusCode).toBe(403);
  });

  it("allows external host configuration", async () => {
    const external = await startCodexTestServer({
      cwd: loopbackTempDir,
      lockPath: path.join(loopbackTempDir, "wildcard.lock"),
      port: 0,
      host: "0.0.0.0",
    });
    try {
      const address = external.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}${codexPath("/api/search")}`);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ entries: expect.any(Array) });
    } finally {
      await new Promise<void>((resolve) => external.close(() => resolve()));
    }
  });

  it("dual-listens explicit non-wildcard hosts with loopback on the same port", async () => {
    const explicitHost = findNonLoopbackIpv4();
    if (!explicitHost) return;
    const external = await startCodexTestServer({
      cwd: loopbackTempDir,
      lockPath: path.join(loopbackTempDir, "explicit-ip.lock"),
      port: 0,
      host: explicitHost,
    });
    try {
      const address = external.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const primary = await fetch(`http://${explicitHost}:${port}${codexPath("/api/search")}`);
      const loopback = await fetch(`http://127.0.0.1:${port}${codexPath("/api/search")}`);
      const mismatchedHost = await requestRawHost(port, "203.0.113.10");

      // Codex는 자기 Host 게이트를 따로 갖고 있었고, 그 게이트만 명시 바인드 호스트를
      // 넓게 받아들였다. 플러그인이 된 지금은 콘솔 게이트 하나를 지난다 — 그래서 이
      // 주소에서 콘솔 자신의 라우트(`/api/v1/health`)가 답하는 것과 똑같이 답한다.
      // 문 하나가 닫힌 것이지 기능이 사라진 것이 아니다.
      const coreOnExplicit = await fetch(`http://${explicitHost}:${port}/api/v1/health`);
      expect(primary.status).toBe(coreOnExplicit.status);
      expect(loopback.status).toBe(200);
      expect(mismatchedHost.statusCode).toBe(403);
      expect(mismatchedHost.body).toContain("host_mismatch");
    } finally {
      await new Promise<void>((resolve) => external.close(() => resolve()));
    }
  });

  it("enumerates loopback and NIC hosts for wildcard binds", () => {
    const access = buildAllowedAccessSets("0.0.0.0", 4242, {
      en0: [
        { address: "192.168.1.20", family: "IPv4", internal: false },
        { address: "fe80::abcd", family: "IPv6", internal: false },
        { address: "127.0.0.1", family: "IPv4", internal: true },
      ],
    } as never);
    expect(access.allowedHosts).toEqual(new Set(["127.0.0.1", "::1", "192.168.1.20", "fe80::abcd"]));
    expect(access.allowedOrigins.has("http://127.0.0.1:4242")).toBe(true);
    expect(access.allowedOrigins.has("http://[::1]:4242")).toBe(true);
    expect(access.allowedOrigins.has("http://192.168.1.20:4242")).toBe(true);
    expect(access.allowedOrigins.has("http://[fe80::abcd]:4242")).toBe(true);
    expect(access.externalMode).toBe(true);
  });

  it("treats expanded IPv6 wildcard as wildcard for access allowlists", () => {
    const access = buildAllowedAccessSets("0:0:0:0:0:0:0:0", 4242, {
      en0: [
        { address: "192.168.1.20", family: "IPv4", internal: false },
      ],
    } as never);
    expect(access.allowedOrigins.has("http://[::1]:4242")).toBe(true);
    expect(access.allowedOrigins.has("http://192.168.1.20:4242")).toBe(true);
    expect(access.allowedOrigins.has("http://[0:0:0:0:0:0:0:0]:4242")).toBe(false);
  });

  it("adds loopback to explicit non-wildcard access allowlists", () => {
    const access = buildAllowedAccessSets("192.168.1.50", 4242);
    expect(access.allowedHosts).toEqual(new Set(["192.168.1.50", "127.0.0.1"]));
    expect(access.allowedOrigins.has("http://192.168.1.50:4242")).toBe(true);
    expect(access.allowedOrigins.has("http://127.0.0.1:4242")).toBe(true);
  });

  it("rejects drydock writes the listener did not admit, before Origin validation", async () => {
    const response = createResponseRecorder();
    await handleApiRequest(
      createRouteRequest(`/api/drydock/${VALID_PATCH_ID}/decision`, "POST", "192.168.1.10"),
      response.response,
      createMinimalRouteContext({ admitted: false }),
    );
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("write_loopback_only");
  });

  // 원격 리스너를 통과한 요청은 피어 주소가 루프백이 아니어도 쓰기 자격을 갖는다 — 세션 게이트가
  // 라우팅 이전에 이미 판정했고, 여기서 피어를 다시 보면 원격은 영원히 읽기 전용이 된다.
  it("admits drydock writes from a remote listener with its own https Origin", async () => {
    const request = createRouteRequest(`/api/drydock/${VALID_PATCH_ID}/decision`, "POST", "192.168.1.10");
    request.headers.origin = "https://desk.local:3737";
    const response = createResponseRecorder();
    await handleApiRequest(request, response.response, createMinimalRouteContext({
      allowedOrigins: new Set(["https://desk.local:3737"]),
    }));
    expect(response.statusCode).toBe(415);
    expect(response.body).toContain("unsupported_media_type");
  });

  it("still rejects an Origin the listener does not allow", async () => {
    const request = createRouteRequest(`/api/drydock/${VALID_PATCH_ID}/decision`, "POST", "192.168.1.10");
    request.headers.origin = "https://evil.example:3737";
    const response = createResponseRecorder();
    await handleApiRequest(request, response.response, createMinimalRouteContext({
      allowedOrigins: new Set(["https://desk.local:3737"]),
    }));
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("origin_mismatch");
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
      queueDir: "",
      archiveDir: "",
      conflictsDir: "",
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

async function writePatch(
  baseDir: string,
  patchId: string,
  targetId: string,
  summary: string,
  status: "pending" | "accepted" | "rejected",
): Promise<void> {
  const dir = path.join(baseDir, patchId);
  await mkdir(dir, { recursive: true });
  // WikiEntry body JSON
  const wikiEntry = JSON.stringify({
    id: targetId,
    title: summary,
    tags: [],
    created: "2026-05-04T00:00:00.000Z",
    updated: "2026-05-04T00:00:00.000Z",
    version: 1,
    body: "테스트 본문",
  });
  const patchMd = [
    "---",
    `op: "create_wiki"`,
    `target: "wiki/${targetId}.md"`,
    `summary: "${summary}"`,
    `proposer: "test"`,
    `created: "2026-05-04T00:00:00.000Z"`,
    "---",
    wikiEntry,
  ].join("\n");
  const metaJson = JSON.stringify({
    id: patchId,
    status,
    createdAt: "2026-05-04T00:00:00.000Z",
  });
  await writeFile(path.join(dir, "patch.md"), patchMd, "utf8");
  await writeFile(path.join(dir, "meta.json"), metaJson, "utf8");
}
