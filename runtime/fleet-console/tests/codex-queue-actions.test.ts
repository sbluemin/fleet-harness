import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceDirectory } from "@fleet-console/infra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startCodexTestServer } from "./codex-test-server.js";
import type { CodexTestServer } from "./codex-test-server.js";

let server: CodexTestServer | null = null;
let baseUrl = "";
let serverPort = 0;
let tempDir = "";
let fleetDataDir = "";

const PENDING_PATCH_ID = "2026-05-04T10-00-00-000Z-aabbccdd";
const ARCHIVE_PATCH_ID = "2026-05-04T09-00-00-000Z-11223344";

describe("queue POST actions", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-console-codex-actions-"));
    const wikiDir = path.join(tempDir, ".fleet", "knowledge", "wiki");
    const queueDir = path.join(tempDir, ".fleet", "knowledge", "queue");
    const archiveDir = path.join(tempDir, ".fleet", "knowledge", "archive");
    const patchSetsDir = path.join(queueDir, "_sets");
    await mkdir(wikiDir, { recursive: true });
    await mkdir(path.join(queueDir, PENDING_PATCH_ID), { recursive: true });
    await mkdir(path.join(archiveDir, ARCHIVE_PATCH_ID), { recursive: true });
    await mkdir(path.join(patchSetsDir, "set-alpha"), { recursive: true });
    await writeEntry(wikiDir, "test-entry", "테스트 문서", "본문");
    await writePatch(queueDir, PENDING_PATCH_ID, "test-entry", "테스트 패치", "pending", "update_wiki");
    await writePatch(archiveDir, ARCHIVE_PATCH_ID, "test-entry", "아카이브 패치", "accepted", "update_wiki");
    await writeFile(path.join(queueDir, PENDING_PATCH_ID, "meta.json"), JSON.stringify({
      id: PENDING_PATCH_ID,
      status: "pending",
      createdAt: "2026-05-04T00:00:00.000Z",
      patch_set_id: "set-alpha",
    }), "utf8");
    await writeFile(path.join(patchSetsDir, "set-alpha", "meta.json"), JSON.stringify({
      id: "set-alpha",
      sourceRef: "raw/2026-05-04-sample-aabbccdd.md",
      createdAt: "2026-05-04T00:00:00.000Z",
      patchIds: [PENDING_PATCH_ID],
    }), "utf8");
    const lockPath = path.join(tempDir, "server.lock");
    fleetDataDir = path.join(path.dirname(lockPath), "fleet-data");
    server = await startCodexTestServer({ cwd: tempDir, lockPath, port: 0, host: "127.0.0.1" });
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { port: number };
    serverPort = lock.port;
    baseUrl = `http://127.0.0.1:${serverPort}/console/codex`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects approve with missing Origin header → 403", async () => {
    const response = await fetch(`${baseUrl}/api/drydock/${encodeURIComponent(PENDING_PATCH_ID)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "origin_mismatch" });
    const batch = await fetch(`${baseUrl}/api/drydock/batch-decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve", patchIds: [PENDING_PATCH_ID] }) });
    expect(batch.status).toBe(403);
    await expect(batch.json()).resolves.toMatchObject({ error: "origin_mismatch" });
  });

  it("approves a valid pending patch → 200 and moves to archive", async () => {
    const response = await fetch(`${baseUrl}/api/drydock/${encodeURIComponent(PENDING_PATCH_ID)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(response.status).toBe(200);
    const data = await response.json() as { ok: boolean; meta: { status: string } };
    expect(data.ok).toBe(true);
    expect(data.meta.status).toBe("accepted");
    // patch should now be in archive
    const archivePath = durableArchiveMetaPath(PENDING_PATCH_ID);
    await expect(access(archivePath)).resolves.not.toThrow();

    // 일괄 결정도 같은 승인 경계를 사용하고, 낡음·실패를 항목별로 숨기지 않는다.
    const knowledge = path.join(resolveWorkspaceDirectory(path.join(fleetDataDir, "console"), tempDir).path, "knowledge");
    const queue = path.join(knowledge, "queue");
    const fresh = "2026-05-04T11-00-00-000Z-aabbcc01", stale = "2026-05-04T11-00-00-000Z-aabbcc02", failed = "2026-05-04T11-00-00-000Z-aabbcc03";
    await writePatch(queue, fresh, "batch-entry", "Batch entry", "pending", "create_wiki");
    await writePatch(queue, stale, "test-entry", "Stale", "pending", "update_wiki");
    await writeFile(path.join(queue, stale, "meta.json"), JSON.stringify({ id: stale, status: "pending", createdAt: "2026-05-04", baseVersion: 1 }));
    const currentFile = path.join(knowledge, "wiki", "test-entry.md");
    await writeFile(currentFile, (await readFile(currentFile, "utf8")).replace("version: 1", "version: 2"));
    await writePatch(queue, failed, "test-entry", "Collision", "pending", "create_wiki");
    const batchRequest = (action: string, patchIds: string[], reason?: string) => fetch(`${baseUrl}/api/drydock/batch-decision`, { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ action, patchIds, reason }) });
    const approved = await batchRequest("approve", [stale, fresh, failed, PENDING_PATCH_ID]);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ results: [{ id: stale, outcome: "skipped", error: "stale_base" }, { id: fresh, outcome: "approved" }, { id: failed, outcome: "failed", error: "create_target_exists" }, { id: PENDING_PATCH_ID, outcome: "skipped", error: "patch_not_pending" }] });
    expect(await readFile(path.join(knowledge, "wiki", "batch-entry.md"), "utf8")).toContain("테스트 본문");
    expect(JSON.parse(await readFile(path.join(queue, stale, "meta.json"), "utf8"))).not.toHaveProperty("conflictId");
    expect((await batchRequest("reject", [stale, failed])).status).toBe(400);
    const rejected = await batchRequest("reject", [stale, failed], "Not needed");
    expect(await rejected.json()).toMatchObject({ results: [{ id: stale, outcome: "rejected" }, { id: failed, outcome: "rejected" }] });
    for (const id of [stale, failed]) expect(JSON.parse(await readFile(durableArchiveMetaPath(id), "utf8"))).toMatchObject({ status: "rejected", reason: "Not needed" });
    const log = await readFile(path.join(knowledge, "log.md"), "utf8");
    expect(log).toContain(fresh);
    expect(log).toContain(stale);
    expect(log).toContain("patch rejected");
  });

  it("rejects POST with oversized body → 413", async () => {
    const hugeBody = JSON.stringify({ action: "reject", reason: "a".repeat(1500) });
    const response = await fetch(`${baseUrl}/api/drydock/${encodeURIComponent(PENDING_PATCH_ID)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: hugeBody,
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "payload_too_large" });
  });

  it("concurrent approve and approve — exactly one succeeds, one gets 409 patch_busy", async () => {
    // 같은 patchId에 대해 두 요청을 동시에 발사
    const makeRequest = () => fetch(`${baseUrl}/api/drydock/${encodeURIComponent(PENDING_PATCH_ID)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ action: "approve" }),
    });
    const [r1, r2] = await Promise.all([makeRequest(), makeRequest()]);
    const statuses = [r1.status, r2.status].sort();
    // 하나는 200, 하나는 409 (patch_busy 또는 patch_not_pending)
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(409);
    // archive에 정확히 한 개만 이동
    const archivePath = durableArchiveMetaPath(PENDING_PATCH_ID);
    await expect(access(archivePath)).resolves.not.toThrow();
  });
});

function durableArchiveMetaPath(patchId: string): string {
  // 워크스페이스 지식은 Console 슬롯 아래 산다 — 인스턴스마다 자기 것을 갖는다.
  const workspace = resolveWorkspaceDirectory(path.join(fleetDataDir, "console"), tempDir);
  return path.join(workspace.path, "knowledge", "archive", patchId, "meta.json");
}

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
  op: "create_wiki" | "update_wiki" = "create_wiki",
): Promise<void> {
  const dir = path.join(baseDir, patchId);
  await mkdir(dir, { recursive: true });
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
    `op: "${op}"`,
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
