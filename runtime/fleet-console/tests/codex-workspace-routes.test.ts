import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMemoryPaths } from "@dotobokuri/fleet-wiki";
import type { MemoryPaths, WikiWorkspaceResolver } from "@dotobokuri/fleet-wiki";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCodexGateway } from "../core/host/codex/gateway.js";
import { createCodexWorkspaceRouter } from "../core/host/codex/workspace-routes.js";
import { workspaceHash } from "../core/host/theaters/theater-domain.js";

const WORKSPACE_ID = "0123456789ab";

describe("Codex Theater-root workspace resolution", () => {
  let tmpDir = "";
  let theaterRoot = "";
  let resolve: ReturnType<typeof vi.fn<(cwd: string) => MemoryPaths>>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fleet-codex-workspace-"));
    theaterRoot = path.join(tmpDir, "theater");
    await mkdir(theaterRoot);
    resolve = vi.fn((cwd: string) => createMemoryPaths(path.join(cwd, "fleet-data", "knowledge")));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createGateway() {
    const wikiWorkspaceResolver: WikiWorkspaceResolver = { resolve };
    return createCodexGateway({ cwd: theaterRoot, host: "127.0.0.1", version: "0.0.0", getPort: () => 0, wikiWorkspaceResolver });
  }

  it("registers and resolves the canonical Theater root", async () => {
    const gateway = createGateway();
    const result = await gateway.resolveWorkspaceForTheater("theater", theaterRoot);
    expect(result).toEqual({ hasWiki: true, id: workspaceHash(await realpath(theaterRoot)) });
    expect(resolve).toHaveBeenCalledWith(await realpath(theaterRoot));
  });

  it("does not create storage while registration metadata is restored", async () => {
    const gateway = createGateway();
    await gateway.registerWorkspace(theaterRoot, "2026-07-17T00:00:00.000Z", "theater");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("forgets only the registered Theater-root workspace", async () => {
    const gateway = createGateway();
    const resolved = await gateway.resolveWorkspaceForTheater("theater-a", theaterRoot);

    gateway.unregisterTheaterWorkspaces("theater-a");

    expect(resolved.id).not.toBeNull();
    expect(gateway.getWorkspace(resolved.id!)).toBeNull();
  });
});

describe("Codex Theater-root workspace route", () => {
  function routerFor(body: unknown, resolveWorkspace = vi.fn().mockResolvedValue({ hasWiki: true, id: WORKSPACE_ID })) {
    const writeJson = vi.fn();
    const router = createCodexWorkspaceRouter({
      getTheater: () => ({ id: "theater", path: "/tmp/theater", realpath: "/tmp/theater", label: "theater", registeredAt: "1", lastOpenedAt: "1" }),
      isAuthorized: () => true,
      readJsonBody: async <T>() => body as T,
      resolveWorkspace,
      writeJson,
    });
    return { router, resolveWorkspace, writeJson };
  }

  it("accepts exactly an empty object and returns a path-free DTO", async () => {
    const { router, resolveWorkspace, writeJson } = routerFor({});
    await router({ req: { method: "POST" } as never, res: {} as never, pathname: "/api/v1/theaters/theater/codex-workspace" });
    expect(resolveWorkspace).toHaveBeenCalledWith("theater", "/tmp/theater");
    expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 200, { hasWiki: true, id: WORKSPACE_ID });
  });

  it.each([null, [], { relPath: null }, { relPath: "nested" }, { unknown: true }])("rejects non-empty or non-object request bodies", async (body) => {
    const { router, resolveWorkspace, writeJson } = routerFor(body);
    await router({ req: { method: "POST" } as never, res: {} as never, pathname: "/api/v1/theaters/theater/codex-workspace" });
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 400, { error: "invalid_request" });
  });
});
