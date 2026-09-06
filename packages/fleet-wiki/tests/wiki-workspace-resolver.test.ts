import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
  };
});

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
