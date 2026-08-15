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
  await fs.mkdir(outsidePath);
  await fs.writeFile(path.join(theaterPath, "src", "needle.ts"), "export {}");
  await fs.writeFile(path.join(theaterPath, "src", "nested", "needle.test.ts"), "test()");
  await fs.writeFile(path.join(outsidePath, "needle-secret.txt"), "secret");
  await fs.symlink(outsidePath, path.join(theaterPath, "escape"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { force: true, recursive: true });
});

describe("Files palette search", () => {
  it("returns sorted Theater-relative file paths and excludes escaping symlinks", async () => {
    const outcome = await searchTheaterFiles(theaterPath, "needle", 8);

    expect(outcome.files).toEqual([
      { relativePath: "src/needle.ts" },
      { relativePath: "src/nested/needle.test.ts" },
    ]);
    expect(outcome.totalMatches).toBe(2);
    expect(outcome.walkCapped).toBeUndefined();
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(temporaryDirectory);
    expect(serialized).not.toContain(await fs.realpath(theaterPath));
    expect(serialized).not.toContain("needle-secret");
  });

  it("reports totalMatches beyond the requested limit", async () => {
    const outcome = await searchTheaterFiles(theaterPath, "needle", 1);

    expect(outcome.files).toHaveLength(1);
    expect(outcome.totalMatches).toBe(2);
    expect(outcome.walkCapped).toBeUndefined();
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

  it("marks walkCapped when the directory cap stops the traversal", async () => {
    const widePath = path.join(temporaryDirectory, "wide-theater");
    for (let i = 0; i < 510; i += 1) {
      await fs.mkdir(path.join(widePath, `d${i}`), { recursive: true });
      await fs.writeFile(path.join(widePath, `d${i}`, "needle.txt"), "x");
    }

    const outcome = await searchTheaterFiles(widePath, "needle", 8);

    expect(outcome.walkCapped).toBe(true);
    expect(outcome.files.length).toBeLessThanOrEqual(8);
    expect(outcome.totalMatches).toBeGreaterThan(0);
    expect(outcome.totalMatches).toBeLessThan(510);
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
