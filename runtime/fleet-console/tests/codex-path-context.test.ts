import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCodexWorkspaceContextRouter } from "../core/host/codex/context-routes.js";
import { createCodexGateway } from "../core/host/codex/gateway.js";
import { TheaterPathContextError } from "../core/host/theater-path-context.js";
import { workspaceHash } from "../core/host/theater.js";

// ─── constants ─────────────────────────────────────────────────────────────

const WORKSPACE_ID = "0123456789ab";

// ─── helpers ───────────────────────────────────────────────────────────────

async function createKnowledgeRoot(dir: string): Promise<void> {
  await mkdir(path.join(dir, ".fleet", "knowledge", "wiki"), { recursive: true });
}

function createGateway() {
  return createCodexGateway({
    cwd: process.cwd(),
    host: "127.0.0.1",
    version: "0.0.0",
    getPort: () => 0,
  });
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe("Codex workspace path-context resolution", () => {
  let tmpDir = "";
  let theaterRoot = "";

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fleet-codex-context-"));
    theaterRoot = path.join(tmpDir, "theater");
    await mkdir(theaterRoot);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("does not fall back to a Theater-root wiki when the selected directory has none", async () => {
    const selectedDir = path.join(theaterRoot, "without-wiki");
    await Promise.all([createKnowledgeRoot(theaterRoot), mkdir(selectedDir)]);

    const result = await createGateway().resolveWorkspaceForPath(theaterRoot, "without-wiki");

    expect(result).toEqual({ hasWiki: false, id: null });
  });

  it("registers a selected wiki workspace idempotently using its canonical realpath hash", async () => {
    const selectedDir = path.join(theaterRoot, "workspace");
    await createKnowledgeRoot(selectedDir);
    const gateway = createGateway();

    const [first, second] = await Promise.all([
      gateway.resolveWorkspaceForPath(theaterRoot, "workspace"),
      gateway.resolveWorkspaceForPath(theaterRoot, "workspace"),
    ]);

    expect(first).toEqual({ hasWiki: true, id: workspaceHash(await realpath(selectedDir)) });
    expect(second).toEqual(first);
    expect(gateway.listWorkspaceRegistrations()).toHaveLength(1);
  });

  it("rejects absolute paths, traversal, and symlink escapes before workspace registration", async () => {
    const outsideDir = path.join(tmpDir, "outside");
    await mkdir(outsideDir);
    await symlink(outsideDir, path.join(theaterRoot, "escape"));
    const gateway = createGateway();

    await expect(gateway.resolveWorkspaceForPath(theaterRoot, "/tmp")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(gateway.resolveWorkspaceForPath(theaterRoot, "../outside")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(gateway.resolveWorkspaceForPath(theaterRoot, "escape")).rejects.toMatchObject({ code: "forbidden" });
    expect(gateway.listWorkspaceRegistrations()).toHaveLength(0);
  });
});

describe("Codex workspace path-context route", () => {
  it("returns only the workspace id and hasWiki after resolving the Theater context", async () => {
    const writeJson = vi.fn();
    const resolveWorkspace = vi.fn().mockResolvedValue({ hasWiki: true, id: WORKSPACE_ID });
    const router = createCodexWorkspaceContextRouter({
      getTheater: () => ({ id: "theater", path: "/tmp/theater", realpath: "/tmp/theater", label: "theater", registeredAt: "1", lastOpenedAt: "1", pathContext: null }),
      isAuthorized: () => true,
      readJsonBody: async <T>() => ({ relPath: "workspace" } as T),
      resolveWorkspace,
      writeJson,
    });

    await router({
      req: { method: "POST" } as never,
      res: {} as never,
      pathname: "/api/v1/theaters/theater/codex-workspace",
    });

    expect(resolveWorkspace).toHaveBeenCalledWith("/tmp/theater", "workspace");
    expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 200, { hasWiki: true, id: WORKSPACE_ID });
  });

  it("maps common resolver containment failures without exposing a path", async () => {
    const writeJson = vi.fn();
    const router = createCodexWorkspaceContextRouter({
      getTheater: () => ({ id: "theater", path: "/tmp/theater", realpath: "/tmp/theater", label: "theater", registeredAt: "1", lastOpenedAt: "1", pathContext: null }),
      isAuthorized: () => true,
      readJsonBody: async <T>() => ({ relPath: "escape" } as T),
      resolveWorkspace: async () => { throw new TheaterPathContextError("forbidden"); },
      writeJson,
    });

    await router({
      req: { method: "POST" } as never,
      res: {} as never,
      pathname: "/api/v1/theaters/theater/codex-workspace",
    });

    expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 403, { error: "forbidden" });
    expect(JSON.stringify(writeJson.mock.calls)).not.toContain("/tmp/theater");
  });
});
