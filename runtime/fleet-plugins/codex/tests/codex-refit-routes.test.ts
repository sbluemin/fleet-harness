// Codex Refit 서버 계약 — 드라이독 목록 enrichment(proposer·diffstat),
// 결정 이력(archived) 노출, 엔트리 백링크, 검색 발췌 단어 경계.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { centerSearchExcerpt } from "../core/host/codex/routes.js";
import { startCodexTestServer } from "./codex-test-server.js";
import type { CodexTestServer } from "./codex-test-server.js";

let server: CodexTestServer | null = null;
let baseUrl = "";
let tempDir = "";

const PENDING_PATCH_ID = "2026-05-04T10-00-00-000Z-ab12cd34";
const ARCHIVE_PATCH_ID = "2026-05-04T09-00-00-000Z-ef56ab78";

describe("codex refit routes", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-console-codex-refit-"));
    const wikiDir = path.join(tempDir, ".fleet", "knowledge", "wiki");
    const queueDir = path.join(tempDir, ".fleet", "knowledge", "queue");
    const archiveDir = path.join(tempDir, ".fleet", "knowledge", "archive");
    await mkdir(wikiDir, { recursive: true });
    await mkdir(queueDir, { recursive: true });
    await mkdir(archiveDir, { recursive: true });

    await writeEntry(wikiDir, "target-entry", "Target entry", "Original paragraph.\n\nShared paragraph.");
    await writeEntry(
      wikiDir,
      "referrer-entry",
      "Referrer entry",
      "This document cites [[wiki:target-entry]] in its body.",
    );
    await writeEntry(wikiDir, "unrelated-entry", "Unrelated entry", "No links here.");

    await writePatch(queueDir, PENDING_PATCH_ID, {
      op: "update_wiki",
      target: "wiki/target-entry.md",
      summary: "Refresh the target entry",
      proposer: "harvest-agent",
      status: "pending",
      body: "Rewritten paragraph.\n\nShared paragraph.\n\nAppended paragraph.",
    });
    await writePatch(archiveDir, ARCHIVE_PATCH_ID, {
      op: "update_wiki",
      target: "wiki/target-entry.md",
      summary: "Previously decided patch",
      proposer: "session-agent",
      status: "accepted",
      body: "Decided body.",
    });

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

  it("enriches pending drydock rows with proposer and diffstat", async () => {
    const response = await fetch(`${baseUrl}/api/drydock?status=pending`);
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      items: Array<{ id: string; proposer?: string; diffstat?: { added: number; removed: number } }>;
      pendingCount: number;
      archivedCount: number;
    };
    expect(payload.pendingCount).toBe(1);
    expect(payload.archivedCount).toBe(1);
    const item = payload.items.find((candidate) => candidate.id === PENDING_PATCH_ID);
    expect(item).toBeDefined();
    expect(item?.proposer).toBe("harvest-agent");
    // "Original paragraph." → "Rewritten paragraph." 교체 + "Appended paragraph." 추가.
    expect(item?.diffstat).toEqual({ added: 2, removed: 1 });
  });

  it("lists decided patches without diffstat", async () => {
    const response = await fetch(`${baseUrl}/api/drydock?status=archived`);
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      items: Array<{ id: string; proposer?: string; diffstat?: unknown; meta: { status: string } }>;
    };
    const item = payload.items.find((candidate) => candidate.id === ARCHIVE_PATCH_ID);
    expect(item).toBeDefined();
    expect(item?.meta.status).toBe("accepted");
    expect(item?.proposer).toBe("session-agent");
    expect(item?.diffstat).toBeUndefined();
  });

  it("returns backlinks for entries referenced via [[wiki:...]]", async () => {
    const response = await fetch(`${baseUrl}/api/entry/target-entry`);
    expect(response.status).toBe(200);
    const payload = await response.json() as { backlinks?: Array<{ id: string; title: string }> };
    expect(payload.backlinks).toEqual([
      { id: "referrer-entry", title: "Referrer entry", updated: "2026-05-04T00:00:00.000Z" },
    ]);
  });

  it("omits backlinks when nothing references the entry", async () => {
    const response = await fetch(`${baseUrl}/api/entry/unrelated-entry`);
    expect(response.status).toBe(200);
    const payload = await response.json() as { backlinks?: unknown };
    expect(payload.backlinks).toBeUndefined();
  });
});

describe("centerSearchExcerpt", () => {
  it("keeps short excerpts untouched", () => {
    expect(centerSearchExcerpt("short body", "body")).toBe("short body");
  });

  it("does not start mid-word and flattens whitespace", () => {
    const prefix = "registration validation ".repeat(12);
    const value = `${prefix}\n\nLexical validation is followed by containment checks on resolved real paths and more trailing text to exceed the window comfortably.`;
    const excerpt = centerSearchExcerpt(value, "containment");
    expect(excerpt).toContain("containment");
    // 창이 본문 중간에서 시작하면 잘림을 말줄임으로 표시하고, 첫 토큰은 온전한 단어여야 한다.
    expect(excerpt.startsWith("…")).toBe(true);
    const firstWord = excerpt.slice(1).split(" ")[0] ?? "";
    expect(value.includes(` ${firstWord}`) || value.startsWith(firstWord)).toBe(true);
    expect(excerpt).not.toContain("\n");
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
      'created: "2026-05-04T00:00:00.000Z"',
      'updated: "2026-05-04T00:00:00.000Z"',
      "version: 1",
      "---",
      body,
    ].join("\n"),
    "utf8",
  );
}

interface PatchFixture {
  op: "create_wiki" | "update_wiki";
  target: string;
  summary: string;
  proposer: string;
  status: "pending" | "accepted" | "rejected";
  body: string;
}

async function writePatch(baseDir: string, patchId: string, fixture: PatchFixture): Promise<void> {
  const dir = path.join(baseDir, patchId);
  await mkdir(dir, { recursive: true });
  const wikiEntry = JSON.stringify({
    id: fixture.target.replace(/^wiki\//, "").replace(/\.md$/, ""),
    title: fixture.summary,
    tags: [],
    created: "2026-05-04T00:00:00.000Z",
    updated: "2026-05-04T00:00:00.000Z",
    version: 2,
    body: fixture.body,
  });
  const patchMd = [
    "---",
    `op: "${fixture.op}"`,
    `target: "${fixture.target}"`,
    `summary: "${fixture.summary}"`,
    `proposer: "${fixture.proposer}"`,
    'created: "2026-05-04T00:00:00.000Z"',
    "---",
    wikiEntry,
  ].join("\n");
  await writeFile(path.join(dir, "patch.md"), patchMd, "utf8");
  await writeFile(path.join(dir, "meta.json"), JSON.stringify({
    id: patchId,
    status: fixture.status,
    createdAt: "2026-05-04T00:00:00.000Z",
    ...(fixture.status === "pending" ? {} : { decidedAt: "2026-05-04T01:00:00.000Z" }),
  }), "utf8");
}
