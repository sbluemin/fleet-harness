import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { createMemoryPaths } from "../server/wiki/index.js";
import type { MemoryPaths, WikiWorkspaceResolver } from "../server/wiki/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCodexGateway } from "../server/codex/gateway.js";
import { createCodexWorkspaceRouter } from "../server/codex/workspace-routes.js";
import { createCodexFileRouter } from "../server/codex/file-routes.js";

// 실행 계정/플랫폼과 무관하게 OS의 권한 거부를 대표 라우트 경계에 주입한다.
vi.mock("node:fs/promises", { spy: true });

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
      agent: { createSession: async () => { throw new Error("not used"); } },
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

  it("previews only bounded regular Theater files and refuses traversal and symlink escapes on both file routes", async () => {
    await writeFile(path.join(theaterRoot, "source.ts"), Array.from({ length: 260 }, (_, index) => `line ${index + 1}`).join("\n"));
    await writeFile(path.join(tmpDir, "outside.ts"), "outside secret");
    await symlink(path.join(tmpDir, "outside.ts"), path.join(theaterRoot, "escape.ts"));
    await writeFile(path.join(theaterRoot, "binary.dat"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(theaterRoot, "large.ts"), "x".repeat(256 * 1024 + 1));
    let body: unknown;
    let authorized = true;
    const writeJson = vi.fn();
    const router = createCodexFileRouter({
      getTheater: id => id === "theater" ? { realpath: theaterRoot } : null,
      isAuthorized: () => authorized,
      readJsonBody: async <T>() => body as T,
      writeJson,
    });
    const call = async (endpoint: string, fields: Record<string, unknown>) => {
      body = { theaterId: "theater", ...fields };
      await router({ req: { method: "POST" } as IncomingMessage, res: {} as ServerResponse, pathname: `/api/v1/plugins/codex/${endpoint}` });
      return writeJson.mock.lastCall!;
    };
    const preview = await call("file-peek", { path: "source.ts", line: 130 });
    expect(preview[1]).toBe(200);
    expect(preview[2]).toMatchObject({ path: "source.ts", startLine: 30, truncated: true });
    expect(preview[2].lines).toHaveLength(200);
    expect(JSON.stringify(preview[2])).not.toContain(theaterRoot);
    const canonicalRoot = await realpath(theaterRoot);
    const absoluteRefs = await call("file-refs", { paths: [path.join(canonicalRoot, "source.ts"), canonicalRoot, "missing.ts"] });
    expect(absoluteRefs.slice(1)).toEqual([200, [{ path: "source.ts", status: "file" }, { path: ".", status: "dir" }, { path: "missing.ts", status: "missing" }]]);
    expect(JSON.stringify(absoluteRefs[2])).not.toContain(canonicalRoot);
    for (const escaped of ["../outside.ts", "escape.ts"]) {
      expect((await call("file-peek", { path: escaped }))[1]).toBe(403);
      expect((await call("file-refs", { paths: [escaped] }))[1]).toBe(403);
    }
    for (const absoluteEscape of [path.join(await realpath(tmpDir), "outside.ts"), path.join(canonicalRoot, "escape.ts")]) {
      const rejected = await call("file-refs", { paths: [absoluteEscape] });
      expect(rejected.slice(1)).toEqual([403, { error: "outside_theater" }]);
      expect(JSON.stringify(rejected[2])).not.toContain(absoluteEscape);
    }
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error("access denied"), { code: "EACCES" }));
    expect((await call("file-peek", { path: "source.ts" })).slice(1)).toEqual([403, { error: "forbidden" }]);
    expect((await call("file-peek", { path: "binary.dat" }))[1]).toBe(415);
    expect((await call("file-peek", { path: "large.ts" }))[1]).toBe(413);
    expect((await call("file-refs", { paths: Array(201).fill("source.ts") }))[1]).toBe(400);
    authorized = false;
    expect((await call("file-peek", { path: "source.ts" }))[1]).toBe(403);
  });

  it("registers and resolves the canonical Theater root", async () => {
    const gateway = createGateway();
    const result = await gateway.resolveWorkspaceForTheater("theater", theaterRoot);
    expect(result).toEqual({ hasWiki: true, id: identityHash(await realpath(theaterRoot)) });
    expect(resolve).toHaveBeenCalledWith(await realpath(theaterRoot));
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

  // Theater가 경로에서 본문으로 옮겨 왔으므로 "빈 본문만 허용"은 더 이상 계약이 아니다.
  // 남는 계약은 하나다: Theater를 말하지 않은 요청은 워크스페이스를 열지 않는다.
  it.each([null, [], {}, { theaterId: "" }, { theaterId: 7 }])("refuses a body that names no Theater", async (body) => {
    const { router, resolveWorkspace, writeJson } = routerFor(body);
    await router({ req: { method: "POST" } as never, res: {} as never, pathname: "/api/v1/plugins/codex/workspace" });
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 400, { error: "invalid_theater" });
  });

});
