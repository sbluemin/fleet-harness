import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { ClientRequest, Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFleetWikiServer } from "../src/server.js";

let server: Server | null = null;
let rootDir = "";
let workspaceA = "";
let workspaceB = "";
let baseUrl = "";
let wsA = "";
let wsB = "";
let lockToken = "";

const SHARED_PATCH_ID = "2026-05-19T00-00-00-000Z-0abc1234";
const SHARED_CONFLICT_ID = "conflict-shared";
const MARKER_A = "workspace-a-exclusive-marker";
const MARKER_B = "workspace-b-exclusive-marker";

describe("workspace-prefixed routes", () => {
  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-prefix-root-"));
    workspaceA = path.join(rootDir, "workspace-a");
    workspaceB = path.join(rootDir, "workspace-b");
    await createWorkspace(workspaceA, "shared", "Workspace A", "raw A");
    await createWorkspace(workspaceB, "shared", "Workspace B", "raw B");
    const lockPath = path.join(rootDir, "daemon.lock");
    server = await startFleetWikiServer({ cwd: workspaceA, lockPath, port: 0, host: "127.0.0.1" });
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { port: number; token: string };
    baseUrl = `http://127.0.0.1:${lock.port}`;
    lockToken = lock.token;
    wsA = await currentWorkspaceId();
    wsB = await registerWorkspace(workspaceB);
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("serves selected workspace data through /w/:ws/api routes", async () => {
    const entryA = await fetchJson<{ frontmatter: { title: string } }>(`/w/${wsA}/api/entry/shared`);
    const entryB = await fetchJson<{ frontmatter: { title: string } }>(`/w/${wsB}/api/entry/shared`);
    expect(entryA.frontmatter.title).toBe("Workspace A");
    expect(entryB.frontmatter.title).toBe("Workspace B");

    const rawA = await fetch(`${baseUrl}/w/${wsA}/api/raw?ref=${encodeURIComponent("raw/sample.md")}`);
    const rawB = await fetch(`${baseUrl}/w/${wsB}/api/raw?ref=${encodeURIComponent("raw/sample.md")}`);
    await expect(rawA.text()).resolves.toBe("raw A");
    await expect(rawB.text()).resolves.toBe("raw B");
  });

  it("serves selected workspace drydock data through /w/:ws/api routes", async () => {
    await expectWorkspaceBody(`/w/${wsA}/api/queue`, MARKER_A, MARKER_B);
    await expectWorkspaceBody(`/w/${wsB}/api/queue`, MARKER_B, MARKER_A);
    await expectWorkspaceBody(`/w/${wsA}/api/queue/${SHARED_PATCH_ID}`, MARKER_A, MARKER_B);
    await expectWorkspaceBody(`/w/${wsB}/api/queue/${SHARED_PATCH_ID}`, MARKER_B, MARKER_A);
    await expectWorkspaceBody(`/w/${wsA}/api/conflicts`, MARKER_A, MARKER_B);
    await expectWorkspaceBody(`/w/${wsB}/api/conflicts`, MARKER_B, MARKER_A);
    await expectWorkspaceBody(`/w/${wsA}/api/conflicts/${SHARED_CONFLICT_ID}`, MARKER_A, MARKER_B);
    await expectWorkspaceBody(`/w/${wsB}/api/conflicts/${SHARED_CONFLICT_ID}`, MARKER_B, MARKER_A);
    await expectWorkspaceBody(`/w/${wsA}/api/index-md`, MARKER_A, MARKER_B);
    await expectWorkspaceBody(`/w/${wsB}/api/index-md`, MARKER_B, MARKER_A);
    await expectWorkspaceBody(`/w/${wsA}/api/log`, MARKER_A, MARKER_B);
    await expectWorkspaceBody(`/w/${wsB}/api/log`, MARKER_B, MARKER_A);
  });

  it("redirects legacy SPA routes to the MRU workspace", async () => {
    const response = await fetch(`${baseUrl}/entry/shared`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/w/${wsB}/entry/shared`);
  });

  it("routes legacy APIs through the MRU workspace", async () => {
    const entry = await fetchJson<{ frontmatter: { title: string } }>("/api/entry/shared");
    expect(entry.frontmatter.title).toBe("Workspace B");
  });

  it("scopes concurrent queue action locks by workspace id", async () => {
    const slowApproveA = startSlowApprove(`/w/${wsA}/api/queue/${encodeURIComponent(SHARED_PATCH_ID)}/approve`);
    await delay(100);

    const approveB = await fetch(`${baseUrl}/w/${wsB}/api/queue/${encodeURIComponent(SHARED_PATCH_ID)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({}),
    });
    expect(approveB.status).toBe(200);

    const responseA = await slowApproveA.finish();
    expect(responseA.status).toBe(200);
  });

  it("redirects unknown workspace navigations to Welcome", async () => {
    const response = await fetch(`${baseUrl}/w/000000000000/entry/shared`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });

  it("does not serve API misses through the SPA fallback", async () => {
    const response = await fetch(`${baseUrl}/w/${wsA}/api/not-found`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "not_found" });
  });
});

async function currentWorkspaceId(): Promise<string> {
  const body = await fetchJson<{ currentWorkspaceId: string }>("/api/workspaces");
  return body.currentWorkspaceId;
}

async function registerWorkspace(cwd: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/admin/workspaces`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${lockToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cwd }),
  });
  const body = await response.json() as { workspace: { id: string } };
  return body.workspace.id;
}

async function fetchJson<T>(pathOrUrl: string): Promise<T> {
  const response = await fetch(pathOrUrl.startsWith("http") ? pathOrUrl : `${baseUrl}${pathOrUrl}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function expectWorkspaceBody(route: string, expectedMarker: string, forbiddenMarker: string): Promise<void> {
  const response = await fetch(`${baseUrl}${route}`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain(expectedMarker);
  expect(body).not.toContain(forbiddenMarker);
}

async function createWorkspace(cwd: string, id: string, title: string, raw: string): Promise<void> {
  const wikiDir = path.join(cwd, ".fleet", "knowledge", "wiki");
  const rawDir = path.join(cwd, ".fleet", "knowledge", "raw");
  const queueDir = path.join(cwd, ".fleet", "knowledge", "queue");
  const conflictsDir = path.join(cwd, ".fleet", "knowledge", "conflicts");
  const marker = title === "Workspace A" ? MARKER_A : MARKER_B;
  await mkdir(wikiDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  await mkdir(queueDir, { recursive: true });
  await mkdir(path.join(cwd, ".fleet", "knowledge", "archive"), { recursive: true });
  await mkdir(conflictsDir, { recursive: true });
  await writeFile(path.join(rawDir, "sample.md"), raw, "utf8");
  await writeFile(
    path.join(wikiDir, `${id}.md`),
    [
      "---",
      `id: ${id}`,
      `title: ${title}`,
      "tags: []",
      "created: 2026-05-19T00:00:00.000Z",
      "updated: 2026-05-19T00:00:00.000Z",
      "version: 1",
      "status: current",
      "---",
      "",
      `# ${title}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(wikiDir, "index.md"), `# Fleet Wiki Index\n\n- ${marker}\n`, "utf8");
  await writeFile(
    path.join(cwd, ".fleet", "knowledge", "log.md"),
    `## 2026-05-19T00:00:00.000Z — drydock run\n- marker: \`${marker}\`\n\n`,
    "utf8",
  );
  await writeQueuePatch(queueDir, SHARED_PATCH_ID, id, marker);
  await writeConflict(conflictsDir, SHARED_CONFLICT_ID, id, marker);
}

async function writeQueuePatch(queueDir: string, patchId: string, targetId: string, marker: string): Promise<void> {
  const patchDir = path.join(queueDir, patchId);
  await mkdir(patchDir, { recursive: true });
  await writeFile(
    path.join(patchDir, "patch.md"),
    [
      "---",
      "op: \"update_wiki\"",
      `target: "wiki/${targetId}.md"`,
      `summary: "Patch ${marker}"`,
      "proposer: \"workspace-prefix-test\"",
      "created: \"2026-05-19T00:00:00.000Z\"",
      "---",
      JSON.stringify({
        id: targetId,
        title: `Patch ${marker}`,
        tags: [],
        created: "2026-05-19T00:00:00.000Z",
        updated: "2026-05-19T00:00:00.000Z",
        version: 2,
        body: `Patch body ${marker}`,
      }),
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(patchDir, "meta.json"),
    JSON.stringify({
      id: patchId,
      status: "pending",
      createdAt: "2026-05-19T00:00:00.000Z",
      warnings: [marker],
    }),
    "utf8",
  );
}

async function writeConflict(conflictsDir: string, conflictId: string, wikiId: string, marker: string): Promise<void> {
  const conflictDir = path.join(conflictsDir, conflictId);
  await mkdir(conflictDir, { recursive: true });
  await writeFile(
    path.join(conflictDir, "meta.json"),
    JSON.stringify({
      id: conflictId,
      status: "unresolved",
      reason: "base_hash_mismatch",
      createdAt: "2026-05-19T00:00:00.000Z",
      target: `wiki/${wikiId}.md`,
      wikiId,
      title: `Conflict ${marker}`,
      patchId: SHARED_PATCH_ID,
    }),
    "utf8",
  );
  await writeFile(path.join(conflictDir, "current.md"), `# Current ${marker}\n`, "utf8");
  await writeFile(path.join(conflictDir, "proposed.md"), `# Proposed ${marker}\n`, "utf8");
  await writeFile(path.join(conflictDir, "raw-source.md"), `Raw conflict ${marker}\n`, "utf8");
}

function startSlowApprove(pathname: string): { finish: () => Promise<{ status: number; body: string }> } {
  let clientRequest: ClientRequest | null = null;
  const responsePromise = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    clientRequest = request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    clientRequest.on("error", reject);
    clientRequest.write("{");
  });

  return {
    finish: async () => {
      clientRequest?.end("}");
      return responsePromise;
    },
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
