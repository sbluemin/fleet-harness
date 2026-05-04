import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    await mkdir(wikiDir, { recursive: true });
    await mkdir(rawDir, { recursive: true });
    await mkdir(path.join(queueDir, VALID_PATCH_ID), { recursive: true });
    await mkdir(path.join(archiveDir, VALID_PATCH_ID), { recursive: true });
    await writeEntry(wikiDir, "valid-id", "Valid Entry", "Body");
    await writeFile(path.join(rawDir, "sample.md"), "raw content body", "utf8");
    // pending 패치 픽스처
    await writePatch(queueDir, VALID_PATCH_ID, "valid-id", "테스트 요약", "pending");
    // archive 패치 픽스처
    await writePatch(archiveDir, VALID_PATCH_ID, "valid-id", "테스트 요약", "accepted");
    const lockPath = path.join(tempDir, "server.lock");
    server = await startFleetWikiServer({ cwd: tempDir, lockPath, port: 0 });
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
