import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createWikiWorkspaceResolver,
  createWikiWorkspaceResolverForTest,
  classifyWikiWorkspaceNodeForTest,
  shouldSyncDirectoryForTest,
  type WikiWorkspaceResolverDependencies,
} from "../src/workspace-resolver.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

interface TestHooks {
  beforeMigrationCommit?(): void;
  beforeCopyFile?(source: string, destination: string): void;
}

async function fixture(hooks?: TestHooks) {
  const root = await mkdtemp(process.platform === "darwin" ? "/tmp/fwr-" : path.join(os.tmpdir(), "fleet-wiki-resolver-"));
  roots.push(root);
  const cwd = path.join(root, "theater");
  const workspace = path.join(root, "data", "workspaces", "theater");
  await mkdir(cwd, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const dependencies: WikiWorkspaceResolverDependencies = {
    ensureWorkspace: () => ({ cwd, path: workspace }),
    withMigrationLock: (_workspace, operation) => operation(),
  };
  return { cwd, workspace, resolver: hooks
    ? createWikiWorkspaceResolverForTest(dependencies, hooks)
    : createWikiWorkspaceResolver(dependencies) };
}

describe("createWikiWorkspaceResolver", () => {
  it("copies root legacy content once through durable sibling storage without changing the source", async () => {
    const { cwd, workspace, resolver } = await fixture();
    const sourceFile = path.join(cwd, ".fleet", "knowledge", "wiki", "entry.md");
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, "legacy\n");
    const paths = await resolver.resolve(cwd);
    expect(paths.root).toBe(path.join(workspace, "knowledge"));
    await expect(readFile(path.join(paths.wikiDir, "entry.md"), "utf8")).resolves.toBe("legacy\n");
    await expect(readFile(sourceFile, "utf8")).resolves.toBe("legacy\n");
    expect(JSON.parse(await readFile(path.join(workspace, "knowledge.migrated.json"), "utf8")).outcome).toBe("copied");
    await rm(paths.root, { recursive: true });
    await resolver.resolve(cwd);
    await expect(readFile(path.join(paths.wikiDir, "entry.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves contained relative file symlinks without dereferencing or changing the source", async () => {
    const { cwd, workspace, resolver } = await fixture();
    const source = path.join(cwd, ".fleet", "knowledge");
    await mkdir(path.join(source, "schema"), { recursive: true });
    await writeFile(path.join(source, "AGENTS.md"), "root doctrine\n");
    await writeFile(path.join(source, "schema", "AGENTS.md"), "schema doctrine\n");
    await symlink("AGENTS.md", path.join(source, "CLAUDE.md"));
    await symlink("AGENTS.md", path.join(source, "schema", "CLAUDE.md"));

    const paths = resolver.resolve(cwd);
    for (const relative of ["CLAUDE.md", path.join("schema", "CLAUDE.md")]) {
      const sourceLink = path.join(source, relative);
      const destinationLink = path.join(paths.root, relative);
      expect((await lstat(destinationLink)).isSymbolicLink()).toBe(true);
      await expect(readlink(destinationLink)).resolves.toBe("AGENTS.md");
      expect((await lstat(sourceLink)).isSymbolicLink()).toBe(true);
      await expect(readlink(sourceLink)).resolves.toBe("AGENTS.md");
    }
    await expect(readFile(path.join(paths.root, "CLAUDE.md"), "utf8")).resolves.toBe("root doctrine\n");
    await expect(readFile(path.join(paths.schemaDir, "CLAUDE.md"), "utf8")).resolves.toBe("schema doctrine\n");
    expect(resolver.resolve(cwd)).toMatchObject({ root: paths.root });
  });

  it("leaves a destination regular file entirely untouched and does not create a marker", async () => {
    const { cwd, workspace, resolver } = await fixture();
    await mkdir(path.join(cwd, ".fleet", "knowledge"), { recursive: true });
    await writeFile(path.join(cwd, ".fleet", "knowledge", "legacy.md"), "legacy");
    await mkdir(path.join(workspace, "knowledge", "schema"), { recursive: true });
    await writeFile(path.join(workspace, "knowledge", "schema", "wiki-schema.md"), "destination");
    await resolver.resolve(cwd);
    await expect(readFile(path.join(workspace, "knowledge", "schema", "wiki-schema.md"), "utf8")).resolves.toBe("destination");
    await expect(readFile(path.join(workspace, "knowledge.migrated.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("makes destination content a total no-op before malformed marker or staging control inspection", async () => {
    const { cwd, workspace, resolver } = await fixture();
    await mkdir(path.join(cwd, ".fleet", "knowledge"), { recursive: true });
    await writeFile(path.join(workspace, "knowledge"), "already durable");
    await writeFile(path.join(workspace, "knowledge.migrated.json"), "not json");
    const temporary = path.join(workspace, "knowledge.migrated.json.33333333-3333-4333-8333-333333333333.tmp");
    await writeFile(temporary, "interrupted marker write");
    await symlink(path.join(cwd, "missing"), path.join(workspace, "knowledge.migrating-not-a-uuid"));
    expect(resolver.resolve(cwd)).toMatchObject({ root: path.join(workspace, "knowledge") });
    await expect(readFile(path.join(workspace, "knowledge"), "utf8")).resolves.toBe("already durable");
    await expect(readFile(temporary, "utf8")).resolves.toBe("interrupted marker write");
  });

  it("recovers only a marker-referenced staged copy and never re-copies after marker recovery", async () => {
    const { cwd, workspace, resolver } = await fixture();
    const transactionId = "11111111-1111-4111-8111-111111111111";
    const stagingFile = path.join(workspace, `knowledge.migrating-${transactionId}`, "wiki", "entry.md");
    await mkdir(path.dirname(stagingFile), { recursive: true });
    await writeFile(stagingFile, "staged");
    await writeFile(path.join(workspace, `knowledge.migrating-${transactionId}`, "AGENTS.md"), "staged doctrine");
    await symlink("AGENTS.md", path.join(workspace, `knowledge.migrating-${transactionId}`, "CLAUDE.md"));
    await writeFile(path.join(workspace, "knowledge.migrated.json"), JSON.stringify({ version: 1, outcome: "copied", transactionId, completedAt: "2026-07-17T00:00:00.000Z" }));
    await mkdir(path.join(cwd, ".fleet", "knowledge"), { recursive: true });
    await writeFile(path.join(cwd, ".fleet", "knowledge", "legacy.md"), "must not copy");
    const paths = resolver.resolve(cwd);
    await expect(readFile(path.join(paths.wikiDir, "entry.md"), "utf8")).resolves.toBe("staged");
    expect((await lstat(path.join(paths.root, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
    await expect(readlink(path.join(paths.root, "CLAUDE.md"))).resolves.toBe("AGENTS.md");
    await expect(readFile(path.join(paths.root, "legacy.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rebuilds valid pre-marker staging but fails closed for unsafe source, marker, and staging state", async () => {
    const { cwd, workspace, resolver } = await fixture();
    const stale = path.join(workspace, "knowledge.migrating-22222222-2222-4222-8222-222222222222");
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "old.md"), "old");
    await mkdir(path.join(cwd, ".fleet", "knowledge"), { recursive: true });
    await writeFile(path.join(cwd, ".fleet", "knowledge", "fresh.md"), "fresh");
    const paths = resolver.resolve(cwd);
    await expect(readFile(path.join(paths.root, "fresh.md"), "utf8")).resolves.toBe("fresh");

    const unsafe = await fixture();
    await mkdir(path.join(unsafe.cwd, ".fleet", "knowledge"), { recursive: true });
    await symlink(path.join(unsafe.cwd, "missing"), path.join(unsafe.cwd, ".fleet", "knowledge", "link"));
    expect(() => unsafe.resolver.resolve(unsafe.cwd)).toThrow(/Unsafe/);

    const malformed = await fixture();
    await mkdir(path.join(malformed.workspace, "knowledge.migrating-bad"), { recursive: true });
    expect(() => malformed.resolver.resolve(malformed.cwd)).toThrow(/Unsafe/);

    const marker = await fixture();
    await symlink(path.join(marker.cwd, "missing"), path.join(marker.workspace, "knowledge.migrated.json"));
    expect(() => marker.resolver.resolve(marker.cwd)).toThrow(/Unsafe/);
  });

  it("removes only exact regular marker-write residue before retrying the migration", async () => {
    const { cwd, workspace, resolver } = await fixture();
    const sourceFile = path.join(cwd, ".fleet", "knowledge", "wiki", "entry.md");
    const temporary = path.join(workspace, "knowledge.migrated.json.44444444-4444-4444-8444-444444444444.tmp");
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, "legacy\n");
    await writeFile(temporary, "interrupted marker write");

    const paths = resolver.resolve(cwd);
    await expect(readFile(path.join(paths.wikiDir, "entry.md"), "utf8")).resolves.toBe("legacy\n");
    await expect(readFile(temporary, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sourceFile, "utf8")).resolves.toBe("legacy\n");
  });

  it("fails closed for malformed or unsafe marker temp controls", async () => {
    const malformed = await fixture();
    await writeFile(path.join(malformed.workspace, "knowledge.migrated.json.not-a-uuid.tmp"), "not resolver-owned");
    expect(() => malformed.resolver.resolve(malformed.cwd)).toThrow(/Unsafe/);

    const symlinked = await fixture();
    await symlink(path.join(symlinked.cwd, "missing"), path.join(symlinked.workspace, "knowledge.migrated.json.55555555-5555-4555-8555-555555555555.tmp"));
    expect(() => symlinked.resolver.resolve(symlinked.cwd)).toThrow(/Unsafe/);

    const directory = await fixture();
    await mkdir(path.join(directory.workspace, "knowledge.migrated.json.66666666-6666-4666-8666-666666666666.tmp"));
    expect(() => directory.resolver.resolve(directory.cwd)).toThrow(/Unsafe/);
  });

  it("fails closed when destination content appears after staging", async () => {
    let workspace = "";
    const state = await fixture({ beforeMigrationCommit: () => {
      fs.mkdirSync(path.join(workspace, "knowledge"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "knowledge", "racer.md"), "racer");
    } });
    workspace = state.workspace;
    await mkdir(path.join(state.cwd, ".fleet", "knowledge"), { recursive: true });
    await writeFile(path.join(state.cwd, ".fleet", "knowledge", "legacy.md"), "legacy");
    expect(() => state.resolver.resolve(state.cwd)).toThrow(/race/i);
    await expect(readFile(path.join(workspace, "knowledge", "racer.md"), "utf8")).resolves.toBe("racer");
  });

  it("allows empty source and destination without artifacts, while unsafe nodes fail closed", async () => {
    const { cwd, workspace, resolver } = await fixture();
    expect(resolver.resolve(cwd)).toMatchObject({ root: path.join(workspace, "knowledge") });
    await expect(readFile(path.join(workspace, "knowledge.migrated.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(path.join(workspace, "knowledge"), { recursive: true });
    await symlink(path.join(cwd, "missing"), path.join(workspace, "knowledge", "unsafe"));
    expect(() => resolver.resolve(cwd)).toThrow(/Unsafe/);
  });

  it("rejects absolute, escaping, dangling, and directory symlinks before creating migration artifacts", async () => {
    const absolute = await fixture();
    const absoluteSource = path.join(absolute.cwd, ".fleet", "knowledge");
    await mkdir(absoluteSource, { recursive: true });
    await writeFile(path.join(absoluteSource, "target.md"), "target");
    await symlink(path.join(absoluteSource, "target.md"), path.join(absoluteSource, "absolute.md"));
    expect(() => absolute.resolver.resolve(absolute.cwd)).toThrow(/Unsafe/);

    const escaping = await fixture();
    const escapingSource = path.join(escaping.cwd, ".fleet", "knowledge");
    const outside = path.join(escaping.cwd, "outside.md");
    await mkdir(escapingSource, { recursive: true });
    await writeFile(outside, "outside");
    await symlink(path.relative(escapingSource, outside), path.join(escapingSource, "escaping.md"));
    expect(() => escaping.resolver.resolve(escaping.cwd)).toThrow(/Unsafe/);

    const dangling = await fixture();
    const danglingSource = path.join(dangling.cwd, ".fleet", "knowledge");
    await mkdir(danglingSource, { recursive: true });
    await symlink("missing.md", path.join(danglingSource, "dangling.md"));
    expect(() => dangling.resolver.resolve(dangling.cwd)).toThrow(/Unsafe/);

    const directory = await fixture();
    const directorySource = path.join(directory.cwd, ".fleet", "knowledge");
    await mkdir(path.join(directorySource, "docs"), { recursive: true });
    await writeFile(path.join(directorySource, "docs", "entry.md"), "entry");
    await symlink("docs", path.join(directorySource, "docs-link"));
    expect(() => directory.resolver.resolve(directory.cwd)).toThrow(/Unsafe/);

    for (const state of [absolute, escaping, dangling, directory]) {
      await expect(readFile(path.join(state.workspace, "knowledge.migrated.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(fs.readdirSync(state.workspace).some((name) => name.startsWith("knowledge.migrating-"))).toBe(false);
    }
  });

  it("leaves no marker or destination after a copy failure, then safely retries from rebuilt staging", async () => {
    const failed = await fixture({ beforeCopyFile: () => { throw new Error("copy failed"); } });
    const sourceFile = path.join(failed.cwd, ".fleet", "knowledge", "nested", "entry.md");
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, "source bytes\n");
    expect(() => failed.resolver.resolve(failed.cwd)).toThrow(/copy failed/);
    await expect(readFile(sourceFile, "utf8")).resolves.toBe("source bytes\n");
    await expect(readFile(path.join(failed.workspace, "knowledge", "nested", "entry.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(failed.workspace, "knowledge.migrated.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(fs.readdirSync(failed.workspace).some((name) => name.startsWith("knowledge.migrating-"))).toBe(true);

    const retry = createWikiWorkspaceResolver({
      ensureWorkspace: () => ({ cwd: failed.cwd, path: failed.workspace }),
      withMigrationLock: (_workspace, operation) => operation(),
    });
    const paths = retry.resolve(failed.cwd);
    await expect(readFile(path.join(paths.root, "nested", "entry.md"), "utf8")).resolves.toBe("source bytes\n");
    expect(JSON.parse(await readFile(path.join(failed.workspace, "knowledge.migrated.json"), "utf8")).outcome).toBe("copied");
  });

  it.skipIf(process.platform === "win32")("fails closed for FIFO and Unix socket nodes in every migration position", async () => {
    const source = await fixture();
    const sourceFifo = path.join(source.cwd, ".fleet", "knowledge");
    await mkdir(path.dirname(sourceFifo), { recursive: true });
    execFileSync("mkfifo", [sourceFifo]);
    expect(() => source.resolver.resolve(source.cwd)).toThrow(/Unsafe/);

    const destination = await fixture();
    const destinationSocket = await listenUnixSocket(path.join(destination.workspace, "knowledge"));
    try {
      expect(fs.lstatSync(path.join(destination.workspace, "knowledge")).isSocket()).toBe(true);
      expect(classifyWikiWorkspaceNodeForTest(fs.lstatSync(path.join(destination.workspace, "knowledge")))).toBe("unsafe");
      expect(() => destination.resolver.resolve(destination.cwd)).toThrow(/Unsafe/);
    } finally { await closeServer(destinationSocket); }

    const staging = await fixture();
    execFileSync("mkfifo", [path.join(staging.workspace, "knowledge.migrating-33333333-3333-4333-8333-333333333333")]);
    expect(() => staging.resolver.resolve(staging.cwd)).toThrow(/Unsafe/);

    const marker = await fixture();
    const markerSocket = await listenUnixSocket(path.join(marker.workspace, "knowledge.migrated.json"));
    try {
      expect(() => marker.resolver.resolve(marker.cwd)).toThrow(/Unsafe/);
    } finally { await closeServer(markerSocket); }

    const control = await fixture();
    execFileSync("mkfifo", [path.join(control.workspace, "knowledge.migrated.json.77777777-7777-4777-8777-777777777777.tmp")]);
    expect(() => control.resolver.resolve(control.cwd)).toThrow(/Unsafe/);
  });

  it.skipIf(process.platform === "win32" || !fs.existsSync("/dev/null"))("classifies an existing character device as unsafe without privileges", () => {
    const device = fs.lstatSync("/dev/null");
    expect(device.isCharacterDevice()).toBe(true);
    expect(classifyWikiWorkspaceNodeForTest(device)).toBe("unsafe");
  });

  it("skips directory fsync only on Windows", () => {
    expect(shouldSyncDirectoryForTest("win32")).toBe(false);
    expect(shouldSyncDirectoryForTest("darwin")).toBe(true);
    expect(shouldSyncDirectoryForTest("linux")).toBe(true);
  });
});

async function listenUnixSocket(socketPath: string): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return server;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
