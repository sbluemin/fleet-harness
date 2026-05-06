import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { startFleetWikiServer } from "../src/server.js";

let server: Server | null = null;
let baseUrl = "";
let tempDir = "";

// 테스트 픽스처용 유효한 patchId
const VALID_PATCH_ID = "2026-05-04T03-15-55-143Z-51756575";

describe("security routes", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-web-routes-"));
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
    await writeEntry(wikiDir, "valid-id", "Valid Entry", "Body");
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
    server = await startFleetWikiServer({ cwd: tempDir, lockPath, port: 0, host: "127.0.0.1" });
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { port: number };
    baseUrl = `http://127.0.0.1:${lock.port}`;
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

  it("rejects non-GET and non-HEAD methods at the server boundary", async () => {
    const response = await fetch(`${baseUrl}/api/index`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("converts malformed static URLs to 400", async () => {
    const response = await fetch(`${baseUrl}/%E0%A4%A`);
    await expect(response.json()).resolves.toMatchObject({ error: "bad request" });
    expect(response.status).toBe(400);
  });

  it("serves raw source content when ref is contained inside the raw dir", async () => {
    const response = await fetch(`${baseUrl}/api/raw?ref=${encodeURIComponent("raw/sample.md")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/markdown/);
    await expect(response.text()).resolves.toBe("raw content body");
  });

  it("returns 404 for missing raw source ref", async () => {
    const response = await fetch(`${baseUrl}/api/raw?ref=${encodeURIComponent("raw/missing.md")}`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "raw_not_found" });
  });

  it("rejects raw refs without raw/ prefix", async () => {
    const response = await fetch(`${baseUrl}/api/raw?ref=${encodeURIComponent("etc/passwd")}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_raw_ref" });
  });

  it("rejects raw refs that escape the raw dir", async () => {
    const response = await fetch(`${baseUrl}/api/raw?ref=${encodeURIComponent("raw/../wiki/valid-id.md")}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_raw_ref" });
  });

  it("rejects empty and oversized raw refs", async () => {
    const empty = await fetch(`${baseUrl}/api/raw?ref=`);
    expect(empty.status).toBe(400);
    const oversized = await fetch(`${baseUrl}/api/raw?ref=${encodeURIComponent("raw/" + "a".repeat(300) + ".md")}`);
    expect(oversized.status).toBe(400);
  });

  it("rejects queue patchId that does not match SAFE_PATCH_ID", async () => {
    const response = await fetch(`${baseUrl}/api/queue/..%2Fwiki%2Fvalid-id`);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_patch_id" });
    expect(response.status).toBe(400);
  });

  it("rejects queue patchId with directory traversal", async () => {
    const response = await fetch(`${baseUrl}/api/queue/${encodeURIComponent("2026-05-04T03-15-55-143Z-51756575/../../../etc/passwd")}`);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_patch_id" });
    expect(response.status).toBe(400);
  });

  it("returns 404 for non-existent patchId with valid format", async () => {
    const missingId = "2099-01-01T00-00-00-000Z-00000000";
    const response = await fetch(`${baseUrl}/api/queue/${encodeURIComponent(missingId)}`);
    await expect(response.json()).resolves.toMatchObject({ error: "patch_not_found" });
    expect(response.status).toBe(404);
  });

  it("returns 200 for a pending patch in queueDir", async () => {
    const response = await fetch(`${baseUrl}/api/queue/${encodeURIComponent(VALID_PATCH_ID)}`);
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

    const response = await fetch(`${baseUrl}/api/queue/${encodeURIComponent(malformedBodyPatchId)}`);

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

    const response = await fetch(`${baseUrl}/api/queue/${encodeURIComponent(malformedJsonPatchId)}`);

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

    const response = await fetch(`${baseUrl}/api/queue/${encodeURIComponent(nullBodyPatchId)}`);

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

    const response = await fetch(`${baseUrl}/api/queue/${encodeURIComponent(partialBodyPatchId)}`);

    expect(response.status).toBe(200);
    const data = await response.json() as { wikiEntry: { id: string; body: string } };
    expect(data.wikiEntry.id).toBe("valid-id");
    expect(data.wikiEntry.body).toBe(`{"title": "no id or body"}`);
  });

  it("returns queue list with correct pendingCount", async () => {
    const response = await fetch(`${baseUrl}/api/queue?status=pending`);
    expect(response.status).toBe(200);
    const data = await response.json() as { items: unknown[]; pendingCount: number };
    expect(data.pendingCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(data.items)).toBe(true);
  });

  it("always returns archivedCount even when status=pending", async () => {
    const response = await fetch(`${baseUrl}/api/queue?status=pending`);
    expect(response.status).toBe(200);
    const data = await response.json() as { items: unknown[]; pendingCount: number; archivedCount: number };
    expect(data.pendingCount).toBeGreaterThanOrEqual(1);
    expect(data.archivedCount).toBeGreaterThanOrEqual(1);
  });

  it("always returns pendingCount even when status=archived", async () => {
    const response = await fetch(`${baseUrl}/api/queue?status=archived`);
    expect(response.status).toBe(200);
    const data = await response.json() as { items: unknown[]; pendingCount: number; archivedCount: number };
    expect(data.archivedCount).toBeGreaterThanOrEqual(1);
    expect(data.pendingCount).toBeGreaterThanOrEqual(1);
  });

  it("serves index.md and log routes safely", async () => {
    const indexPath = path.join(tempDir, ".fleet", "knowledge", "wiki", "index.md");
    const logPath = path.join(tempDir, ".fleet", "knowledge", "log.md");
    await writeFile(indexPath, "# Fleet Wiki Index\n", "utf8");
    await writeFile(logPath, "## 2026-05-05T00:00:00.000Z — drydock run\n- ok: `true`\n", "utf8");

    const indexResponse = await fetch(`${baseUrl}/api/index-md`);
    const logResponse = await fetch(`${baseUrl}/api/log?limit=1`);

    expect(indexResponse.status).toBe(200);
    expect(await indexResponse.text()).toContain("# Fleet Wiki Index");
    expect(logResponse.status).toBe(200);
    await expect(logResponse.json()).resolves.toMatchObject({ limit: 1, totalEntries: 1, truncated: false });
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

  it("lists conflicts and returns empty log when missing", async () => {
    const conflictsResponse = await fetch(`${baseUrl}/api/conflicts`);
    const logResponse = await fetch(`${baseUrl}/api/log?limit=200`);

    expect(conflictsResponse.status).toBe(200);
    await expect(conflictsResponse.json()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "conflict-alpha", status: "open" }),
    ]));
    expect(logResponse.status).toBe(200);
    await expect(logResponse.json()).resolves.toMatchObject({ limit: 100 });
  });
});

describe("wildcard host origin check", () => {
  let wildcardServer: Server | null = null;
  let wildcardTempDir = "";
  let wildcardPort = 0;

  function postWithOrigin(origin: string | undefined, patchId: string): Promise<{ statusCode: number }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { "Content-Type": "application/json", "Content-Length": "2" };
      if (origin !== undefined) headers["Origin"] = origin;
      const req = http.request(
        { hostname: "127.0.0.1", port: wildcardPort, path: `/api/queue/${patchId}/approve`, method: "POST", headers },
        (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ statusCode: res.statusCode ?? 0 }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.write("{}");
      req.end();
    });
  }

  beforeEach(async () => {
    wildcardTempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-web-wildcard-"));
    const wikiDir = path.join(wildcardTempDir, ".fleet", "knowledge", "wiki");
    await mkdir(wikiDir, { recursive: true });
    await writeEntry(wikiDir, "wc-entry", "Wildcard Entry", "Body");
    const lockPath = path.join(wildcardTempDir, "server.lock");
    wildcardServer = await startFleetWikiServer({ cwd: wildcardTempDir, lockPath, port: 0, host: "0.0.0.0" });
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { port: number };
    wildcardPort = lock.port;
  });

  afterEach(async () => {
    if (wildcardServer) await new Promise<void>((resolve) => wildcardServer?.close(() => resolve()));
    wildcardServer = null;
    if (wildcardTempDir) await rm(wildcardTempDir, { recursive: true, force: true });
  });

  it("allows POST with LAN IP origin when bound to 0.0.0.0", async () => {
    const queueDir = path.join(wildcardTempDir, ".fleet", "knowledge", "queue");
    const pid = "2026-05-06T10-00-00-000Z-00cafe01";
    await mkdir(path.join(queueDir, pid), { recursive: true });
    await writePatch(queueDir, pid, "wc-entry", "패치", "pending");
    const { statusCode } = await postWithOrigin(`http://192.168.1.100:${wildcardPort}`, pid);
    expect(statusCode).not.toBe(403);
  });

  it("allows POST with localhost origin when bound to 0.0.0.0", async () => {
    const queueDir = path.join(wildcardTempDir, ".fleet", "knowledge", "queue");
    const pid = "2026-05-06T10-01-00-000Z-00cafe02";
    await mkdir(path.join(queueDir, pid), { recursive: true });
    await writePatch(queueDir, pid, "wc-entry", "패치", "pending");
    const { statusCode } = await postWithOrigin(`http://localhost:${wildcardPort}`, pid);
    expect(statusCode).not.toBe(403);
  });

  it("rejects POST with wrong port origin when bound to 0.0.0.0", async () => {
    const queueDir = path.join(wildcardTempDir, ".fleet", "knowledge", "queue");
    const pid = "2026-05-06T10-02-00-000Z-00cafe03";
    await mkdir(path.join(queueDir, pid), { recursive: true });
    await writePatch(queueDir, pid, "wc-entry", "패치", "pending");
    const { statusCode } = await postWithOrigin(`http://192.168.1.100:${wildcardPort + 1}`, pid);
    expect(statusCode).toBe(403);
  });

  it("rejects POST with https origin when bound to 0.0.0.0", async () => {
    const queueDir = path.join(wildcardTempDir, ".fleet", "knowledge", "queue");
    const pid = "2026-05-06T10-03-00-000Z-00cafe04";
    await mkdir(path.join(queueDir, pid), { recursive: true });
    await writePatch(queueDir, pid, "wc-entry", "패치", "pending");
    const { statusCode } = await postWithOrigin(`https://192.168.1.100:${wildcardPort}`, pid);
    expect(statusCode).toBe(403);
  });

  it("rejects POST with no Origin header when bound to 0.0.0.0", async () => {
    const queueDir = path.join(wildcardTempDir, ".fleet", "knowledge", "queue");
    const pid = "2026-05-06T10-04-00-000Z-00cafe05";
    await mkdir(path.join(queueDir, pid), { recursive: true });
    await writePatch(queueDir, pid, "wc-entry", "패치", "pending");
    const { statusCode } = await postWithOrigin(undefined, pid);
    expect(statusCode).toBe(403);
  });
});

async function writeEntry(wikiDir: string, id: string, title: string, body: string): Promise<void> {
  await writeFile(
    path.join(wikiDir, `${id}.md`),
    [
      "---",
      `id: "${id}"`,
      `title: "${title}"`,
      "tags: []",
      "created: \"2026-05-04T00:00:00.000Z\"",
      "updated: \"2026-05-04T00:00:00.000Z\"",
      "version: 1",
      "---",
      body,
    ].join("\n"),
    "utf8",
  );
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
