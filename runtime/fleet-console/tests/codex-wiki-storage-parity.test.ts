import { access, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureWorkspaceDirectory, resolveWorkspaceDirectory, withDirectoryLock } from "@dotobokuri/core-infra";
import { createWikiWorkspaceResolver, getWikiToolSpecs } from "@dotobokuri/fleet-wiki";
import { afterEach, describe, expect, it } from "vitest";

import { createConsoleServer, type ConsoleServer } from "../core/host/server.js";

const ROOT_ENTRY = "root-console-entry";
const NESTED_DECOY = "nested-legacy-decoy";
const STAGED_ENTRY = "approval-gated-stage";
const CONSOLE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Console and injected Wiki tools share Theater-root storage", () => {
  const roots: string[] = [];
  const servers: ConsoleServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("migrates only root legacy knowledge on an authorized POST and exposes it to approval-gated tools", async () => {
    const fixture = await createFixture(roots, servers);
    const source = path.join(fixture.theaterA, ".fleet", "knowledge");
    const nestedSource = path.join(fixture.theaterA, "nested", ".fleet", "knowledge");
    await writeEntry(source, ROOT_ENTRY, "Root Console entry", "migrated root body");
    await writeEntry(nestedSource, NESTED_DECOY, "Nested decoy", "must never migrate");
    await writeFile(path.join(source, "AGENTS.md"), "Fleet Wiki doctrine\n");
    await symlink("AGENTS.md", path.join(source, "CLAUDE.md"));
    const sourceBytes = await snapshot(source);

    const theater = await registerTheater(fixture.endpoint, fixture.theaterA);
    const workspace = resolveWorkspaceDirectory(fixture.fleetDataDir, fixture.theaterA);
    await expect(access(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });

    // Durable registration restore must retain availability without initializing Wiki storage.
    await fixture.server.stop();
    const restarted = await startServer(fixture.fleetDataDir, fixture.theaterA, fixture.root, servers);
    fixture.endpoint = restarted.endpoint;
    fixture.server = restarted.server;
    await expect(access(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });

    const response = await fetch(`${fixture.endpoint}api/v1/theaters/${encodeURIComponent(theater.id)}/codex-workspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const dto = await response.json() as Record<string, unknown>;
    expect(dto).toEqual({ hasWiki: true, id: theater.id });
    expect(Object.keys(dto).sort()).toEqual(["hasWiki", "id"]);
    expect(dto.id).toMatch(/^[0-9a-f]{12}$/);
    assertPathFree(JSON.stringify(dto), fixture);

    const destination = path.join(workspace.path, "knowledge");
    expect(await readFile(path.join(destination, "wiki", `${ROOT_ENTRY}.md`), "utf8")).toContain("migrated root body");
    expect((await lstat(path.join(destination, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
    await expect(readlink(path.join(destination, "CLAUDE.md"))).resolves.toBe("AGENTS.md");
    await expect(readlink(path.join(source, "CLAUDE.md"))).resolves.toBe("AGENTS.md");
    await expect(access(path.join(destination, "wiki", `${NESTED_DECOY}.md`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await snapshot(source)).toEqual(sourceBytes);
    expect(JSON.parse(await readFile(path.join(workspace.path, "knowledge.migrated.json"), "utf8"))).toMatchObject({ version: 1, outcome: "copied" });
    expect((await readdir(workspace.path)).filter((name) => name.startsWith("knowledge.migrating-"))).toEqual([]);

    const resolver = createResolver(fixture.fleetDataDir);
    const readResult = await runTool(resolver, "wiki_read", fixture.theaterA, { ids: [ROOT_ENTRY] });
    expect(JSON.stringify(readResult)).toContain("migrated root body");

    const staged = await runTool(resolver, "wiki_ingest", fixture.theaterA, {
      id: STAGED_ENTRY,
      title: "Approval gated stage",
      body: "This is staged through the Wiki tool and requires approval. ".repeat(4),
      tags: [],
      source: "approval gated source",
    });
    expect(staged.ok).toBe(true);
    expect(staged.patch_id).toMatch(/^[0-9]{4}-/);
    const drydock = await fetch(`${fixture.endpoint}console/codex/w/${theater.id}/api/drydock`);
    expect(drydock.status).toBe(200);
    const drydockText = await drydock.text();
    expect(drydockText).toContain(String(staged.patch_id));
    expect(drydockText).toContain("pending");
    assertPathFree(drydockText, fixture);
  }, 20_000);

  it("uses the same gate for direct/MRU access, keeps Theaters isolated, and never re-copies after a marker", async () => {
    const fixture = await createFixture(roots, servers);
    const sourceA = path.join(fixture.theaterA, ".fleet", "knowledge");
    const sourceB = path.join(fixture.theaterB, ".fleet", "knowledge");
    await writeEntry(sourceA, "theater-a-entry", "Theater A", "A body");
    await writeEntry(sourceB, "theater-b-entry", "Theater B", "B body");
    const theaterA = await registerTheater(fixture.endpoint, fixture.theaterA);
    const theaterB = await registerTheater(fixture.endpoint, fixture.theaterB);
    const workspaceB = resolveWorkspaceDirectory(fixture.fleetDataDir, fixture.theaterB);

    // B is MRU: unprefixed direct Codex access, rather than the POST route, starts migration.
    const direct = await fetch(`${fixture.endpoint}console/codex/api/entry/theater-b-entry`);
    expect(direct.status).toBe(200);
    const directText = await direct.text();
    expect(directText).toContain("B body");
    assertPathFree(directText, fixture);
    expect(await readFile(path.join(workspaceB.path, "knowledge", "wiki", "theater-b-entry.md"), "utf8")).toContain("B body");

    const prefixedA = await fetch(`${fixture.endpoint}console/codex/w/${theaterA.id}/api/entry/theater-a-entry`);
    expect(prefixedA.status).toBe(200);
    expect(await prefixedA.text()).toContain("A body");

    await fixture.server.stop();
    const restarted = await startServer(fixture.fleetDataDir, fixture.theaterA, fixture.root, servers);
    fixture.endpoint = restarted.endpoint;
    fixture.server = restarted.server;
    const afterRestart = await fetch(`${fixture.endpoint}console/codex/api/entry/theater-b-entry`);
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.text()).toContain("B body");

    const forgotten = await fetch(`${fixture.endpoint}api/v1/theaters/${theaterB.id}`, { method: "DELETE" });
    expect(forgotten.status).toBe(200);
    const forgottenBody = await forgotten.json() as { readonly deletion: { readonly deletionId: string } };
    const mruAfterForget = await fetch(`${fixture.endpoint}console/codex/api/entry/theater-a-entry`);
    expect(mruAfterForget.status).toBe(200);
    expect(await mruAfterForget.text()).toContain("A body");

    await rm(path.join(workspaceB.path, "knowledge"), { recursive: true, force: true });
    expect(await readFile(path.join(workspaceB.path, "knowledge.migrated.json"), "utf8")).toContain('"outcome":"copied"');
    const restoredB = await fetch(`${fixture.endpoint}api/v1/deletions/${encodeURIComponent(forgottenBody.deletion.deletionId)}/restore`, { method: "POST" });
    expect(restoredB.status).toBe(200);
    const empty = await fetch(`${fixture.endpoint}api/v1/theaters/${theaterB.id}/codex-workspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ hasWiki: true, id: theaterB.id });
    await expect(access(path.join(workspaceB.path, "knowledge", "wiki", "theater-b-entry.md"))).rejects.toMatchObject({ code: "ENOENT" });

    // A real Wiki use lazily initializes the empty destination but the marker still forbids a legacy re-copy.
    await runTool(createResolver(fixture.fleetDataDir), "wiki_orient", fixture.theaterB, {});
    await expect(access(path.join(workspaceB.path, "knowledge", "wiki", "theater-b-entry.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(workspaceB.path, "knowledge", "schema", "wiki-schema.md"))).resolves.toBeUndefined();
  }, 20_000);
});

async function createFixture(roots: string[], servers: ConsoleServer[]): Promise<{ root: string; fleetDataDir: string; theaterA: string; theaterB: string; endpoint: string; server: ConsoleServer }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-console-wiki-parity-"));
  roots.push(root);
  const fleetDataDir = path.join(root, "fleet-data");
  const theaterA = path.join(root, "theater-a");
  const theaterB = path.join(root, "theater-b");
  await Promise.all([mkdir(fleetDataDir), mkdir(theaterA), mkdir(theaterB)]);
  const started = await startServer(fleetDataDir, theaterA, root, servers);
  return { root, fleetDataDir, theaterA, theaterB, ...started };
}

async function startServer(fleetDataDir: string, codexCwd: string, root: string, servers: ConsoleServer[]): Promise<{ endpoint: string; server: ConsoleServer }> {
  const server = createConsoleServer({
    host: "127.0.0.1",
    port: 0,
    version: "test",
    dataDir: fleetDataDir,
    release: { channel: "local", version: "test", packageRoot: CONSOLE_PACKAGE_ROOT },
  });
  servers.push(server);
  const lockRoot = await mkdtemp(path.join(root, "lock-"));
  const endpoint = await server.start({ dir: lockRoot, lockFile: path.join(lockRoot, "console.lock") });
  return { endpoint, server };
}

async function registerTheater(endpoint: string, cwd: string): Promise<{ id: string }> {
  const grant = await fetch(`${endpoint}api/v1/theaters/folder-grants`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: cwd }),
  });
  expect(grant.status).toBe(200);
  const { folderGrantId } = await grant.json() as { folderGrantId: string };
  const created = await fetch(`${endpoint}api/v1/theaters`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folderGrantId }),
  });
  expect(created.status).toBe(200);
  return created.json() as Promise<{ id: string }>;
}

function createResolver(fleetDataDir: string) {
  return createWikiWorkspaceResolver({
    ensureWorkspace: (cwd) => {
      const workspace = ensureWorkspaceDirectory(fleetDataDir, cwd);
      return { cwd: workspace.cwd, path: workspace.path };
    },
    withMigrationLock: (workspace, operation) => withDirectoryLock({ lockDir: path.join(workspace.path, "knowledge.migration.lock") }, operation),
  });
}

async function runTool(resolver: ReturnType<typeof createResolver>, id: string, cwd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const spec = getWikiToolSpecs(resolver).find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`Missing Wiki tool: ${id}`);
  const result = await spec.execute(args, { cwd, signal: undefined } as never);
  if (!isTextToolResult(result)) throw new Error(`Invalid Wiki tool result: ${id}`);
  expect(result.isError).toBe(false);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function isTextToolResult(value: unknown): value is { isError: boolean; content: Array<{ type: "text"; text: string }> } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.isError === "boolean"
    && Array.isArray(record.content)
    && record.content.length > 0
    && record.content.every((item) => typeof item === "object" && item !== null
      && (item as Record<string, unknown>).type === "text"
      && typeof (item as Record<string, unknown>).text === "string");
}

async function writeEntry(root: string, id: string, title: string, body: string): Promise<void> {
  const wiki = path.join(root, "wiki");
  await mkdir(wiki, { recursive: true });
  await writeFile(path.join(wiki, `${id}.md`), [
    "---", `id: \"${id}\"`, `title: \"${title}\"`, "tags: []", 'created: "2026-07-18T00:00:00.000Z"', 'updated: "2026-07-18T00:00:00.000Z"', "version: 1", "---", "", body, "",
  ].join("\n"), "utf8");
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [path.relative(root, file), await readFile(file, "utf8")] as const)));
}

function assertPathFree(body: string, fixture: { fleetDataDir: string; theaterA: string; theaterB: string }): void {
  for (const value of [fixture.fleetDataDir, fixture.theaterA, fixture.theaterB, "knowledge.migrating-", "knowledge.migrated.json", "workspaces"]) {
    expect(body).not.toContain(value);
  }
}
