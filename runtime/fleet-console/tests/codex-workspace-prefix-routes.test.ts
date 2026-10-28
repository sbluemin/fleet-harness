import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexWorkspaceContextKey, publishResolvedWorkspace, resolveCodexWorkspace, resolvedCodexWorkspaceIdFor } from "../features/codex/client/workspace-store.js";

import { legacyKnowledgeRoot, startCodexTestServer } from "./codex-test-server.js";
import type { CodexTestServer } from "./codex-test-server.js";

let server: CodexTestServer | null = null;
let rootDir = "";
let workspaceA = "";
let workspaceB = "";
let baseUrl = "";
let wsA = "";
let wsB = "";

const MARKER_A = "workspace-a-exclusive-marker";
const MARKER_B = "workspace-b-exclusive-marker";

describe("workspace-prefixed routes", () => {
  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-prefix-root-"));
    workspaceA = path.join(rootDir, "workspace-a");
    workspaceB = path.join(rootDir, "workspace-b");
    await mkdir(workspaceA, { recursive: true });
    await mkdir(workspaceB, { recursive: true });
    await createWorkspace(legacyKnowledgeRoot(workspaceA, rootDir), "shared", "Workspace A", "raw A");
    await createWorkspace(legacyKnowledgeRoot(workspaceB, rootDir), "shared", "Workspace B", "raw B");
    const lockPath = path.join(rootDir, "daemon.lock");
    server = await startCodexTestServer({ cwd: workspaceA, lockPath, port: 0, host: "127.0.0.1" });
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { port: number };
    baseUrl = `http://127.0.0.1:${lock.port}/console/codex`;
    wsA = await server.registerWorkspace(workspaceA);
    wsB = await server.registerWorkspace(workspaceB);
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  // 사령관마다 자기 위키만 본다 — 주소는 사령관 UUID 의 `/c/<uuid>/` 이고, 같은 Theater 를 함께 써도 고른 사령관의 위키다.
  it("keeps Wiki reads with the selected commodore even when owners share a Theater", async () => {
    const entryA = await fetchJson<{ frontmatter: { title: string } }>(`/c/${wsA}/api/entry/shared`);
    const entryB = await fetchJson<{ frontmatter: { title: string } }>(`/c/${wsB}/api/entry/shared`);
    expect(entryA.frontmatter.title).toBe("Workspace A");
    expect(entryB.frontmatter.title).toBe("Workspace B");

    // 브라우저의 상대 URL만 실제 격리 서버로 연결한다. 위키 해석·본문 읽기는 제품 경로 그대로다.
    const origin = new URL(baseUrl).origin;
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Origin", origin);
      return nativeFetch(typeof input === "string" ? new URL(input, origin) : input, { ...init, headers });
    });
    try {
      const ownerA = wsA;
      const ownerB = wsB;
      const listed = await (await fetch("/api/v1/commodore/list", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json() as { readonly commodores: readonly { readonly commodoreId: string; readonly theaters: readonly { readonly theaterId: string }[] }[] };
      const theaterA = listed.commodores.find((owner) => owner.commodoreId === ownerA)!.theaters[0]!.theaterId;
      const grant = await (await fetch("/api/v1/theaters/folder-grants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: workspaceA }) })).json();
      const added = await fetch("/api/v1/commodore/theaters/add", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commodoreId: ownerB, folderGrantId: grant.folderGrantId }),
      });
      expect(added.status).toBe(200);
      // 사령관이 없으면 위키도 없다 — 공유 Theater 에서 임의의 사령관을 고르지 않고, 서버도 Theater 로는 묻지 않는다.
      expect(await resolveCodexWorkspace(null)).toEqual({ hasWiki: false, id: null });
      for (const [owner, title, other] of [[ownerA, "Workspace A", ownerB], [ownerB, "Workspace B", ownerA], [ownerA, "Workspace A", ownerB]]) {
        const workspace = await resolveCodexWorkspace(owner);
        expect(workspace).toEqual({ hasWiki: true, id: owner });
        publishResolvedWorkspace({ contextKey: codexWorkspaceContextKey(owner), theaterId: theaterA, ...workspace });
        expect(resolvedCodexWorkspaceIdFor(other)).toBeNull();
        const resolved = resolvedCodexWorkspaceIdFor(owner);
        const entry = await fetchJson<{ frontmatter: { title: string } }>(`/c/${resolved}/api/entry/shared`);
        expect(entry.frontmatter.title).toBe(title);
      }
  } finally {
      vi.restoreAllMocks();
    }
  });


});

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

async function createWorkspace(knowledge: string, id: string, title: string, raw: string): Promise<void> {
  const wikiDir = path.join(knowledge, "wiki");
  const rawDir = path.join(knowledge, "raw");
  const marker = title === "Workspace A" ? MARKER_A : MARKER_B;
  await mkdir(wikiDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
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
    path.join(knowledge, "log.md"),
    `## 2026-05-19T00:00:00.000Z — drydock run\n- marker: \`${marker}\`\n\n`,
    "utf8",
  );
}
