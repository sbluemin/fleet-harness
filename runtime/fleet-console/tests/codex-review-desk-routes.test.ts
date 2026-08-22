// 리뷰 데스크가 추가한 세 가지 쓰기·읽기 계약을 고정한다.
//   1. 승인 화면 diff의 기준선(`currentBody` / `currentVersion`)
//   2. 패치 셋 일괄 승인(`approve_set`)
//   3. 충돌 해결(`resolveConflict`)
// 세 경로 모두 기존 결정 경로와 같은 쓰기 관문(admitted → Origin → content-type)을 지나야 한다.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startCodexTestServer } from "./codex-test-server.js";
import type { CodexTestServer } from "./codex-test-server.js";

let server: CodexTestServer | null = null;
let baseUrl = "";
let tempDir = "";

const SET_ID = "set-antigravity";
const SET_PATCH_A = "2026-08-21T11-40-55-220Z-e5f6a7b8";
const SET_PATCH_B = "2026-08-21T11-40-55-900Z-c9d0e1f2";
const UPDATE_PATCH = "2026-08-21T09-12-03-001Z-a1b2c3d4";
const CONFLICT_ID = "2026-08-20T18-02-11-stale-base";

describe("review desk routes", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-console-codex-review-"));
    const knowledge = path.join(tempDir, ".fleet", "knowledge");
    const wikiDir = path.join(knowledge, "wiki");
    const queueDir = path.join(knowledge, "queue");
    const conflictDir = path.join(knowledge, "conflicts", CONFLICT_ID);
    await mkdir(wikiDir, { recursive: true });
    await mkdir(path.join(queueDir, "_sets", SET_ID), { recursive: true });
    await mkdir(conflictDir, { recursive: true });

    await writeEntry(wikiDir, "routing-policy", "Routing policy", "line one\nline two\nline three", 3);

    await writePatch(queueDir, UPDATE_PATCH, {
      op: "update_wiki",
      target: "wiki/routing-policy.md",
      summary: "Add a line",
    }, {
      id: "routing-policy",
      title: "Routing policy",
      body: "line one\nline two CHANGED\nline three",
      version: 4,
    });
    await writePatch(queueDir, SET_PATCH_A, {
      op: "create_wiki",
      target: "wiki/alpha.md",
      summary: "Alpha",
    }, { id: "alpha", title: "Alpha", body: "alpha body", version: 1 }, SET_ID);
    await writePatch(queueDir, SET_PATCH_B, {
      op: "create_wiki",
      target: "wiki/beta.md",
      summary: "Beta",
    }, { id: "beta", title: "Beta", body: "beta body", version: 1 }, SET_ID);

    await writeFile(path.join(queueDir, "_sets", SET_ID, "meta.json"), JSON.stringify({
      id: SET_ID,
      sourceRef: "raw/2026-08-21-notes.md",
      createdAt: "2026-08-21T11:40:55.100Z",
      patchIds: [SET_PATCH_A, SET_PATCH_B],
    }), "utf8");

    await writeFile(path.join(conflictDir, "meta.json"), JSON.stringify({
      id: CONFLICT_ID,
      status: "unresolved",
      reason: "base_version_mismatch",
      createdAt: "2026-08-20T18:02:11.000Z",
      target: "wiki/routing-policy.md",
      wikiId: "routing-policy",
      baseVersion: 2,
      warnings: ["written against version 2; the entry is now version 3"],
    }), "utf8");
    await writeFile(path.join(conflictDir, "current.md"), "current text\n", "utf8");
    await writeFile(path.join(conflictDir, "proposed.md"), "proposed text\n", "utf8");
    await writeFile(path.join(conflictDir, "raw-source.md"), "upstream note\n", "utf8");

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

  // ── diff baseline ──────────────────────────────────────────────────────────

  it("carries the current body and version so the approval screen can render a diff", async () => {
    const response = await fetch(`${baseUrl}/api/drydock/${encodeURIComponent(UPDATE_PATCH)}`);
    expect(response.status).toBe(200);
    const detail = await response.json() as { currentBody: string | null; currentVersion: number | null; targetExists: boolean };
    expect(detail.targetExists).toBe(true);
    expect(detail.currentBody).toContain("line two");
    expect(detail.currentBody).not.toContain("CHANGED");
    expect(detail.currentVersion).toBe(3);
  });

  it("reports a null diff baseline for a create_wiki patch, so the UI falls back to the proposal view", async () => {
    const response = await fetch(`${baseUrl}/api/drydock/${encodeURIComponent(SET_PATCH_A)}`);
    const detail = await response.json() as { currentBody: string | null; targetExists: boolean };
    expect(detail.targetExists).toBe(false);
    expect(detail.currentBody).toBeNull();
  });

  // ── patch set batch approval ───────────────────────────────────────────────

  it("approves every member of a patch set in one call", async () => {
    const response = await fetch(`${baseUrl}/api/drydock/sets/${encodeURIComponent(SET_ID)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; acceptedIds: string[] };
    expect(body.status).toBe("accepted");
    expect(body.acceptedIds).toHaveLength(2);

    const remaining = await fetch(`${baseUrl}/api/drydock?status=pending`);
    const list = await remaining.json() as { pendingCount: number };
    expect(list.pendingCount).toBe(1); // only the standalone update patch is left
  });

  it("refuses batch rejection — a rejection reason is per patch", async () => {
    const response = await fetch(`${baseUrl}/api/drydock/sets/${encodeURIComponent(SET_ID)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ action: "reject" }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_action" });
  });

  it("applies the same write gate to set approval as to a single decision", async () => {
    const noOrigin = await fetch(`${baseUrl}/api/drydock/sets/${encodeURIComponent(SET_ID)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(noOrigin.status).toBe(403);

    const badType = await fetch(`${baseUrl}/api/drydock/sets/${encodeURIComponent(SET_ID)}/decision`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: baseUrl },
      body: "action=approve",
    });
    expect(badType.status).toBe(415);
  });

  it("404s an unknown patch set rather than reporting a partial success", async () => {
    const response = await fetch(`${baseUrl}/api/drydock/sets/set-does-not-exist/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(response.status).toBe(404);
  });

  // ── conflict resolution ────────────────────────────────────────────────────

  it("surfaces the reason, warnings and raw source the UI needs to explain a conflict", async () => {
    const response = await fetch(`${baseUrl}/api/conflicts/${encodeURIComponent(CONFLICT_ID)}`);
    expect(response.status).toBe(200);
    const detail = await response.json() as {
      meta: { reason?: string; warnings?: string[]; baseVersion?: number; wikiId?: string };
      rawSource: string | null;
    };
    expect(detail.meta.reason).toBe("base_version_mismatch");
    expect(detail.meta.warnings?.[0]).toContain("version 2");
    expect(detail.meta.baseVersion).toBe(2);
    expect(detail.meta.wikiId).toBe("routing-policy");
    expect(detail.rawSource).toContain("upstream note");
  });

  it("resolves a conflict and removes it from the open count", async () => {
    const before = await (await fetch(`${baseUrl}/api/health`)).json() as { conflictCount: number };
    expect(before.conflictCount).toBe(1);

    const response = await fetch(`${baseUrl}/api/conflicts/${encodeURIComponent(CONFLICT_ID)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ resolution: "rejected" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "resolved", resolution: "rejected" });

    const after = await (await fetch(`${baseUrl}/api/health`)).json() as { conflictCount: number };
    expect(after.conflictCount).toBe(0);
  });

  it("rejects a resolution value the UI cannot produce", async () => {
    const response = await fetch(`${baseUrl}/api/conflicts/${encodeURIComponent(CONFLICT_ID)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ resolution: "deleted" }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_resolution" });
  });

  it("refuses to resolve a conflict id that escapes the conflicts directory", async () => {
    const response = await fetch(`${baseUrl}/api/conflicts/${encodeURIComponent("../../wiki")}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ resolution: "rejected" }),
    });
    expect([400, 404]).toContain(response.status);
  });

  it("applies the write gate to conflict resolution", async () => {
    const response = await fetch(`${baseUrl}/api/conflicts/${encodeURIComponent(CONFLICT_ID)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution: "rejected" }),
    });
    expect(response.status).toBe(403);
  });

  // ── editing and creating ──────────────────────────────────────────────────

  it("saves a direct edit as an approved patch and bumps the version", async () => {
    const response = await fetch(`${baseUrl}/api/entry/routing-policy/edit`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ body: "line one\nedited\nline three", expectedVersion: 3 }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, entryId: "routing-policy" });

    const entry = await (await fetch(`${baseUrl}/api/entry/routing-policy`)).json() as {
      body: string; frontmatter: { version: number };
    };
    expect(entry.body).toContain("edited");
    expect(entry.frontmatter.version).toBe(4);
  });

  it("refuses an edit written against a stale version instead of overwriting", async () => {
    const response = await fetch(`${baseUrl}/api/entry/routing-policy/edit`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ body: "clobber", expectedVersion: 1 }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "entry_stale", currentVersion: 3 });
  });

  it("creates a new entry and refuses a duplicate id", async () => {
    const create = await fetch(`${baseUrl}/api/entry`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ id: "brand-new", title: "Brand new", body: "hello", type: "concept" }),
    });
    expect(create.status).toBe(200);

    const again = await fetch(`${baseUrl}/api/entry`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ id: "brand-new", title: "Brand new", body: "hello" }),
    });
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({ error: "entry_exists" });
  });

  it("applies the write gate to entry edits", async () => {
    const response = await fetch(`${baseUrl}/api/entry/routing-policy/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "x" }),
    });
    expect(response.status).toBe(403);
  });

  // ── drydock on demand ─────────────────────────────────────────────────────

  it("runs drydock on request instead of replaying a log entry", async () => {
    const response = await fetch(`${baseUrl}/api/drydock/run`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const report = await response.json() as {
      ranAt: string; issues: Array<{ code: string; severity: string }>;
      errorCount: number; warningCount: number; infoCount: number;
    };
    expect(Date.parse(report.ranAt)).not.toBeNaN();
    expect(Array.isArray(report.issues)).toBe(true);
    expect(report.errorCount + report.warningCount + report.infoCount).toBe(report.issues.length);
  });

  // ── the authored link graph ───────────────────────────────────────────────

  it("returns backlinks and link titles so the reader can show authored edges", async () => {
    // alpha links to routing-policy; routing-policy links back to nothing.
    await fetch(`${baseUrl}/api/entry`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ id: "linker", title: "Linker", body: "see [[wiki:routing-policy]]" }),
    });

    const target = await (await fetch(`${baseUrl}/api/entry/routing-policy`)).json() as {
      backlinks?: Array<{ id: string; title: string }>;
    };
    expect(target.backlinks).toEqual([{ id: "linker", title: "Linker" }]);

    const source = await (await fetch(`${baseUrl}/api/entry/linker`)).json() as {
      linkTitles?: Record<string, string>;
    };
    expect(source.linkTitles).toMatchObject({ "routing-policy": "Routing policy" });
  });

  // ── asking the corpus ─────────────────────────────────────────────────────

  it("answers a question with entries drawn from the corpus", async () => {
    const response = await fetch(`${baseUrl}/api/query?q=${encodeURIComponent("routing policy")}`);
    expect(response.status).toBe(200);
    const answer = await response.json() as { question: string; entries: Array<{ id: string }> };
    expect(answer.question).toBe("routing policy");
    expect(answer.entries.some((entry) => entry.id === "routing-policy")).toBe(true);
  });

  it("rejects an empty question rather than returning the whole corpus", async () => {
    const response = await fetch(`${baseUrl}/api/query?q=`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "question_required" });
  });

});

// ─── fixtures ─────────────────────────────────────────────────────────────────

async function writeEntry(
  wikiDir: string,
  id: string,
  title: string,
  body: string,
  version: number,
): Promise<void> {
  const frontmatter = [
    "---",
    `id: ${id}`,
    `title: "${title}"`,
    'tags: ["test"]',
    "created: 2026-06-01T09:00:00.000Z",
    "updated: 2026-08-20T10:00:00.000Z",
    `version: ${version}`,
    "---",
    "",
  ].join("\n");
  await writeFile(path.join(wikiDir, `${id}.md`), `${frontmatter}${body}\n`, "utf8");
}

/** 실제 패치 본문은 마크다운이 아니라 직렬화된 wiki entry JSON이다. */
async function writePatch(
  queueDir: string,
  patchId: string,
  frontmatter: { op: string; target: string; summary: string },
  entry: { id: string; title: string; body: string; version: number },
  patchSetId?: string,
): Promise<void> {
  const dir = path.join(queueDir, patchId);
  await mkdir(dir, { recursive: true });
  const head = [
    "---",
    `op: ${JSON.stringify(frontmatter.op)}`,
    `target: ${JSON.stringify(frontmatter.target)}`,
    `summary: ${JSON.stringify(frontmatter.summary)}`,
    'proposer: "wiki_ingest"',
    'created: "2026-08-21T09:12:03.001Z"',
    "---",
  ].join("\n");
  const payload = {
    ...entry,
    tags: ["test"],
    created: "2026-06-01T09:00:00.000Z",
    updated: "2026-08-21T09:12:03.001Z",
  };
  await writeFile(path.join(dir, "patch.md"), `${head}\n${JSON.stringify(payload)}`, "utf8");
  await writeFile(path.join(dir, "meta.json"), JSON.stringify({
    id: patchId,
    status: "pending",
    createdAt: "2026-08-21T09:12:03.001Z",
    ...(patchSetId ? { patch_set_id: patchSetId } : {}),
  }), "utf8");
}
