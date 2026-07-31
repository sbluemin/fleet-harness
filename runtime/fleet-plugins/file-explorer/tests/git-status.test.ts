import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it } from "vitest";

import { handleFilesGitStatus } from "../server/handlers.js";
import { parseGitStatusPorcelainV1Z, scopeGitStatusesToTheater } from "../server/git-status.js";

describe("git status porcelain parser", () => {
  it("parses spaces, Unicode, rename, untracked, and both deleted columns", () => {
    const output = [
      " M file with spaces.ts",
      "?? 문서 파일.md",
      "D  staged-deleted.ts",
      " D worktree-deleted.ts",
      "R  새 이름.ts",
      "old name.ts",
      "A  added.ts",
      "!! ignored.log",
      "",
    ].join("\0");

    expect(parseGitStatusPorcelainV1Z(output)).toEqual([
      { gitPath: "file with spaces.ts", status: "modified" },
      { gitPath: "문서 파일.md", status: "untracked" },
      { gitPath: "staged-deleted.ts", status: "deleted" },
      { gitPath: "worktree-deleted.ts", status: "deleted" },
      { gitPath: "새 이름.ts", status: "modified" },
      { gitPath: "added.ts", status: "modified" },
    ]);
  });

  it("keeps only the parent-repository prefix and emits OS-native separators", () => {
    const entries = parseGitStatusPorcelainV1Z([
      " M packages/app/src/index.ts",
      "?? packages/other/skip.ts",
      "",
    ].join("\0"));

    expect(scopeGitStatusesToTheater(entries, "packages/app/")).toEqual([
      { path: ["src", "index.ts"].join(path.sep), status: "modified" },
    ]);
    expect(scopeGitStatusesToTheater(entries, "packages/app/", "\\")).toEqual([
      { path: "src\\index.ts", status: "modified" },
    ]);
  });
});

describe("handleFilesGitStatus", () => {
  it("returns gitAvailable false for a directory that is not a repository", async () => {
    const theaterPath = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-file-git-status-"));
    const writes: Array<{ readonly status: number; readonly body: unknown }> = [];
    const ctx = {
      host: {
        http: {
          readJsonBody: async () => ({ theaterId: "theater-a" }),
          writeJson: (_res: http.ServerResponse, status: number, body: unknown) => { writes.push({ status, body }); },
        },
        paths: { resolveTheaterPath: () => theaterPath },
        security: { isTerminalAuthorized: () => true },
      },
    } as unknown as FleetPluginServerContext;

    try {
      await handleFilesGitStatus(
        { method: "POST" } as http.IncomingMessage,
        {} as http.ServerResponse,
        ctx,
      );

      expect(writes).toEqual([{
        status: 200,
        body: { ok: true, gitAvailable: false, statuses: [] },
      }]);
    } finally {
      await fs.rm(theaterPath, { recursive: true, force: true });
    }
  });
});
