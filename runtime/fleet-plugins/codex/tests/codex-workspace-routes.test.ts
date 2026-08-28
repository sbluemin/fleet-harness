import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMemoryPaths } from "@dotobokuri/fleet-wiki";
import type { MemoryPaths, WikiWorkspaceResolver } from "@dotobokuri/fleet-wiki";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCodexGateway } from "../server/codex/gateway.js";
import { createCodexWorkspaceRouter } from "../server/codex/workspace-routes.js";

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

  const identityHash = (cwd: string): string => cwd;

  function createGateway() {
    const wikiWorkspaceResolver: WikiWorkspaceResolver = { resolve };
    return createCodexGateway({
      cwd: theaterRoot,
      host: "127.0.0.1",
      version: "0.0.0",
      getPort: () => 0,
      wikiWorkspaceResolver,
      allowedOriginsFor: () => ["http://127.0.0.1:0"],
      theaterPaths: { canonicalize: (cwd: string) => realpathSync(cwd), hash: (cwd: string) => cwd },
      security: { validateHost: () => true, isWriteAdmitted: () => true },
    });
  }

  it("registers and resolves the canonical Theater root", async () => {
    const gateway = createGateway();
    const result = await gateway.resolveWorkspaceForTheater("theater", theaterRoot);
    expect(result).toEqual({ hasWiki: true, id: identityHash(await realpath(theaterRoot)) });
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

  it("resolves the Theater named in the body and returns a path-free DTO", async () => {
    const { router, resolveWorkspace, writeJson } = routerFor({ theaterId: "theater" });
    await router({ req: { method: "POST" } as never, res: {} as never, pathname: "/api/v1/plugins/codex/workspace" });
    expect(resolveWorkspace).toHaveBeenCalledWith("theater", "/tmp/theater");
    expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 200, { hasWiki: true, id: WORKSPACE_ID });
  });

  // Theater가 경로에서 본문으로 옮겨 왔으므로 "빈 본문만 허용"은 더 이상 계약이 아니다.
  // 남는 계약은 하나다: Theater를 말하지 않은 요청은 워크스페이스를 열지 않는다.
  it.each([null, [], {}, { theaterId: "" }, { theaterId: 7 }])("refuses a body that names no Theater", async (body) => {
    const { router, resolveWorkspace, writeJson } = routerFor(body);
    await router({ req: { method: "POST" } as never, res: {} as never, pathname: "/api/v1/plugins/codex/workspace" });
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 400, { error: "invalid_theater" });
  });

});
