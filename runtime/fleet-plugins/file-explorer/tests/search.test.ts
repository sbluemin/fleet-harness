import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleFilesSearch, listTheaterContents, searchTheaterFiles } from "../server/tree-services.js";

let temporaryDirectory: string;
let theaterPath: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "file-search-"));
  theaterPath = path.join(temporaryDirectory, "theater");
  const outsidePath = path.join(temporaryDirectory, "outside");
  await fs.mkdir(path.join(theaterPath, "src", "nested"), { recursive: true });
  await fs.mkdir(outsidePath);
  await fs.writeFile(path.join(theaterPath, "src", "needle.ts"), "export {}");
  await fs.writeFile(path.join(theaterPath, "src", "nested", "needle.test.ts"), "test()");
  await fs.writeFile(path.join(outsidePath, "needle-secret.txt"), "secret");
  await fs.symlink(outsidePath, path.join(theaterPath, "escape"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { force: true, recursive: true });
});

function searchContext(body: {
  readonly theaterId?: unknown;
  readonly query?: unknown;
  readonly limit?: unknown;
  readonly kinds?: unknown;
  readonly includeHidden?: unknown;
}): {
  readonly ctx: FleetPluginServerContext;
  readonly writes: Array<{ readonly status: number; readonly body: unknown }>;
} {
  const writes: Array<{ readonly status: number; readonly body: unknown }> = [];
  const ctx = {
    host: {
      http: {
        readJsonBody: async () => body,
        writeJson: (_res: http.ServerResponse, status: number, body: unknown) => writes.push({ status, body }),
      },
      security: { isTerminalAuthorized: () => true },
      paths: { resolveTheaterPath: () => theaterPath },
    },
  } as unknown as FleetPluginServerContext;
  return { ctx, writes };
}

describe("Files palette search", () => {
  it("returns sorted Theater-relative file paths and excludes escaping symlinks", async () => {
    const outcome = await searchTheaterFiles(theaterPath, "needle", 8);

    expect(outcome.files).toEqual([
      { relativePath: "src/needle.ts", kind: "file" },
      { relativePath: "src/nested/needle.test.ts", kind: "file" },
    ]);
    expect(outcome.totalMatches).toBe(2);
    expect(outcome.walkCapped).toBeUndefined();
    expect(outcome.ignoredSkipped).toBe(false);
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(temporaryDirectory);
    expect(serialized).not.toContain(await fs.realpath(theaterPath));
    expect(serialized).not.toContain("needle-secret");
  });

  it("never walks version-control internals, even when they contain matches", async () => {
    await fs.mkdir(path.join(theaterPath, ".git", "objects"), { recursive: true });
    await fs.writeFile(path.join(theaterPath, ".git", "needle-config"), "x");

    const outcome = await searchTheaterFiles(theaterPath, "needle", 8);

    expect(outcome.files.map((file) => file.relativePath)).toEqual([
      "src/needle.ts",
      "src/nested/needle.test.ts",
    ]);
  });

  it("does not traverse a symlink alias that points at VCS internals", async () => {
    await fs.mkdir(path.join(theaterPath, ".git"), { recursive: true });
    await fs.writeFile(path.join(theaterPath, ".git", "needle-config"), "x");
    await fs.symlink(path.join(theaterPath, ".git"), path.join(theaterPath, "metadata"), "dir");

    const outcome = await searchTheaterFiles(theaterPath, "needle", 8);

    expect(outcome.files.map((file) => file.relativePath)).toEqual([
      "src/needle.ts",
      "src/nested/needle.test.ts",
    ]);
  });

  it("keeps the HTTP response free of absolute and real paths", async () => {
    const { ctx, writes } = searchContext({ theaterId: "theater-a", query: "needle", limit: 8 });

    await handleFilesSearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(writes[0]?.status).toBe(200);
    expect(writes[0]?.body).toMatchObject({
      totalMatches: 2,
      ignoredSkipped: true,
      complete: false,
      files: [
        { relativePath: "src/needle.ts", kind: "file" },
        { relativePath: "src/nested/needle.test.ts", kind: "file" },
      ],
    });
    expect(JSON.stringify(writes[0]?.body)).not.toContain(temporaryDirectory);
    expect(JSON.stringify(writes[0]?.body)).not.toContain(await fs.realpath(theaterPath));
  });

  it("aborts the walk when the response socket closes before it answers", async () => {
    const { ctx, writes } = searchContext({ theaterId: "theater-a", query: "needle", limit: 8 });
    const res = new EventEmitter() as http.ServerResponse & EventEmitter;
    (res as { writableEnded: boolean }).writableEnded = false;
    const originalOn = res.on.bind(res);
    res.on = ((event: string, listener: (...args: unknown[]) => void) => {
      originalOn(event, listener);
      // 클라이언트가 이미 떠난 상태를 흉내낸다 — 등록 즉시 close.
      if (event === "close") listener();
      return res;
    }) as typeof res.on;

    await handleFilesSearch({ method: "POST" } as http.IncomingMessage, res, ctx);

    expect(writes).toEqual([]);
  });
});
