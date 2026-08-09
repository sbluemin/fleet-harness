import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleFilesSearch, searchTheaterFiles } from "../server/tree-services.js";

let temporaryDirectory: string;
let theaterPath: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "file-search-"));
  theaterPath = path.join(temporaryDirectory, "theater");
  const outsidePath = path.join(temporaryDirectory, "outside");
  await fs.mkdir(path.join(theaterPath, "src", "nested"), { recursive: true });
  await fs.mkdir(path.join(theaterPath, "node_modules", "dep"), { recursive: true });
  await fs.mkdir(outsidePath);
  await fs.writeFile(path.join(theaterPath, "src", "needle.ts"), "export {}");
  await fs.writeFile(path.join(theaterPath, "src", "nested", "needle.test.ts"), "test()");
  await fs.writeFile(path.join(theaterPath, "node_modules", "dep", "needle-dep.ts"), "dep()");
  await fs.writeFile(path.join(outsidePath, "needle-secret.txt"), "secret");
  await fs.symlink(outsidePath, path.join(theaterPath, "escape"));
});

// git이 없거나 Theater가 저장소가 아닌 상태를 고정한다 — 호스트에 설치된 git 여부가 결과를 바꾸지 않는다.
const NO_GIT = { execGit: () => Promise.reject(new Error("not a repository")) };

function gitListing(...relativePaths: readonly string[]) {
  return { execGit: () => Promise.resolve(relativePaths.map((entry) => `${entry}\0`).join("")) };
}

afterEach(async () => {
  await fs.rm(temporaryDirectory, { force: true, recursive: true });
});

describe("Files palette search", () => {
  it("returns sorted Theater-relative file paths and excludes escaping symlinks", async () => {
    const results = await searchTheaterFiles(theaterPath, "needle", 8, NO_GIT);

    expect(results).toEqual([
      { relativePath: "src/needle.ts" },
      { relativePath: "src/nested/needle.test.ts" },
    ]);
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(temporaryDirectory);
    expect(serialized).not.toContain(await fs.realpath(theaterPath));
    expect(serialized).not.toContain("needle-secret");
  });

  it("lets git decide what is ignored instead of walking the Theater", async () => {
    const results = await searchTheaterFiles(theaterPath, "needle", 8, gitListing("src/needle.ts"));

    // 훑기였다면 node_modules 아래 파일도 후보였다. git 목록이 후보 집합 자체를 정한다.
    expect(results).toEqual([{ relativePath: "src/needle.ts" }]);
  });

  it("skips dependency and VCS directories when no ignore rules can be read", async () => {
    const results = await searchTheaterFiles(theaterPath, "needle", 8, NO_GIT);

    expect(results.map((result) => result.relativePath)).not.toContain("node_modules/dep/needle-dep.ts");
  });

  it("drops a git-listed path that resolves outside the Theater", async () => {
    // git이 추적하는 심링크라도 Theater 밖을 가리키면 목록에 오르지 않는다.
    const results = await searchTheaterFiles(theaterPath, "needle", 8, gitListing("escape/needle-secret.txt", "src/needle.ts"));

    expect(results).toEqual([{ relativePath: "src/needle.ts" }]);
  });

  it("drops index entries whose file no longer exists", async () => {
    const results = await searchTheaterFiles(theaterPath, "needle", 8, gitListing("src/deleted-needle.ts", "src/needle.ts"));

    expect(results).toEqual([{ relativePath: "src/needle.ts" }]);
  });

  it("answers an empty query with the most recently modified files", async () => {
    const recent = new Date("2026-08-09T10:00:00.000Z");
    const older = new Date("2020-01-01T00:00:00.000Z");
    await fs.utimes(path.join(theaterPath, "src", "nested", "needle.test.ts"), recent, recent);
    await fs.utimes(path.join(theaterPath, "src", "needle.ts"), older, older);

    const results = await searchTheaterFiles(theaterPath, "", 8, gitListing("src/needle.ts", "src/nested/needle.test.ts"));

    expect(results).toEqual([
      { relativePath: "src/nested/needle.test.ts" },
      { relativePath: "src/needle.ts" },
    ]);
  });

  it("accepts an empty query over HTTP instead of rejecting it", async () => {
    const writes: Array<{ readonly status: number; readonly body: unknown }> = [];
    const ctx = {
      host: {
        http: {
          readJsonBody: async () => ({ theaterId: "theater-a", query: "", limit: 8 }),
          writeJson: (_res: http.ServerResponse, status: number, body: unknown) => writes.push({ status, body }),
        },
        security: { isTerminalAuthorized: () => true },
        paths: { resolveTheaterPath: () => theaterPath },
      },
    } as unknown as FleetPluginServerContext;

    await handleFilesSearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(writes[0]?.status).toBe(200);
  });

  it("keeps the HTTP response free of absolute and real paths", async () => {
    const writes: Array<{ readonly status: number; readonly body: unknown }> = [];
    const ctx = {
      host: {
        http: {
          readJsonBody: async () => ({ theaterId: "theater-a", query: "needle", limit: 8 }),
          writeJson: (_res: http.ServerResponse, status: number, body: unknown) => writes.push({ status, body }),
        },
        security: { isTerminalAuthorized: () => true },
        paths: { resolveTheaterPath: () => theaterPath },
      },
    } as unknown as FleetPluginServerContext;

    await handleFilesSearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(writes[0]?.status).toBe(200);
    expect(JSON.stringify(writes[0]?.body)).not.toContain(temporaryDirectory);
    expect(JSON.stringify(writes[0]?.body)).not.toContain(await fs.realpath(theaterPath));
  });
});
