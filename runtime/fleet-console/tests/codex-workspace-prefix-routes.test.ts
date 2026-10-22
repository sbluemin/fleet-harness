import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startCodexTestServer } from "./codex-test-server.js";
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
    await createWorkspace(workspaceA, "shared", "Workspace A", "raw A");
    await createWorkspace(workspaceB, "shared", "Workspace B", "raw B");
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

  it("serves selected workspace entry data through /w/:ws/api routes", async () => {
    const entryA = await fetchJson<{ frontmatter: { title: string } }>(`/w/${wsA}/api/entry/shared`);
    const entryB = await fetchJson<{ frontmatter: { title: string } }>(`/w/${wsB}/api/entry/shared`);
    expect(entryA.frontmatter.title).toBe("Workspace A");
    expect(entryB.frontmatter.title).toBe("Workspace B");
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

async function createWorkspace(cwd: string, id: string, title: string, raw: string): Promise<void> {
  const wikiDir = path.join(cwd, ".fleet", "knowledge", "wiki");
  const rawDir = path.join(cwd, ".fleet", "knowledge", "raw");
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
    path.join(cwd, ".fleet", "knowledge", "log.md"),
    `## 2026-05-19T00:00:00.000Z — drydock run\n- marker: \`${marker}\`\n\n`,
    "utf8",
  );
}
