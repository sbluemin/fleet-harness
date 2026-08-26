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

  it("reports totalMatches beyond the requested limit", async () => {
    const outcome = await searchTheaterFiles(theaterPath, "needle", 1);

    expect(outcome.files).toHaveLength(1);
    expect(outcome.totalMatches).toBe(2);
    expect(outcome.walkCapped).toBeUndefined();
    expect(outcome.ignoredSkipped).toBe(false);
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
    expect(outcome.ignoredSkipped).toBe(false);
  });

  it("skips dependency directories during the walk but still lists them", async () => {
    await fs.mkdir(path.join(theaterPath, "node_modules"), { recursive: true });
    for (let i = 0; i < 510; i += 1) {
      await fs.mkdir(path.join(theaterPath, "node_modules", `pkg${i}`));
      await fs.writeFile(path.join(theaterPath, "node_modules", `pkg${i}`, "needle.ts"), "x");
    }
    await fs.mkdir(path.join(theaterPath, "src", "deep", "a", "b", "c", "d"), { recursive: true });
    await fs.writeFile(path.join(theaterPath, "src", "deep", "a", "b", "c", "d", "needle-target.ts"), "x");

    const outcome = await searchTheaterFiles(theaterPath, "needle", 8);

    expect(outcome.files.map((file) => file.relativePath)).toEqual([
      "src/deep/a/b/c/d/needle-target.ts",
      "src/needle.ts",
      "src/nested/needle.test.ts",
    ]);
    expect(outcome.files.every((file) => !file.relativePath.includes("node_modules"))).toBe(true);
    expect(outcome.ignoredSkipped).toBe(true);
    expect(outcome.walkCapped).toBeUndefined();

    const listed = await listTheaterContents(theaterPath, "");
    expect(listed.entries.map((entry) => entry.name)).toContain("node_modules");
  });

  it("matches every token split on whitespace and slashes", async () => {
    await fs.mkdir(path.join(theaterPath, "src", "deep", "a", "b", "c", "d"), { recursive: true });
    await fs.writeFile(path.join(theaterPath, "src", "deep", "a", "b", "c", "d", "needle-target.ts"), "x");

    const bySlash = await searchTheaterFiles(theaterPath, "deep/needle", 8);
    expect(bySlash.files).toEqual([
      { relativePath: "src/deep/a/b/c/d/needle-target.ts", kind: "file" },
    ]);

    const bySpace = await searchTheaterFiles(theaterPath, "deep needle", 8);
    expect(bySpace.files).toEqual(bySlash.files);
  });

  it("returns matching directories with kind dir", async () => {
    const outcome = await searchTheaterFiles(theaterPath, "nested", 8);

    expect(outcome.files).toContainEqual({ relativePath: "src/nested", kind: "dir" });
    expect(outcome.files).toContainEqual({ relativePath: "src/nested/needle.test.ts", kind: "file" });
  });

  it("keeps the HTTP response free of absolute and real paths", async () => {
    const { ctx, writes } = searchContext({ theaterId: "theater-a", query: "needle", limit: 8 });

    await handleFilesSearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(writes[0]?.status).toBe(200);
    expect(writes[0]?.body).toMatchObject({
      totalMatches: 2,
      ignoredSkipped: false,
      files: [
        { relativePath: "src/needle.ts", kind: "file" },
        { relativePath: "src/nested/needle.test.ts", kind: "file" },
      ],
    });
    expect(JSON.stringify(writes[0]?.body)).not.toContain(temporaryDirectory);
    expect(JSON.stringify(writes[0]?.body)).not.toContain(await fs.realpath(theaterPath));
  });

  it("still answers when the request stream closes after its body is read", async () => {
    // Node는 짧은 본문을 다 읽은 직후에도 IncomingMessage에 "close"를 흘린다.
    // 그 신호를 취소로 쓰면 모든 검색이 응답 없이 매달린다(실측: curl 8초 타임아웃).
    const { ctx, writes } = searchContext({ theaterId: "theater-a", query: "needle", limit: 8 });
    const requestListeners: Array<() => void> = [];
    const req = {
      method: "POST",
      on: (event: string, listener: () => void) => { if (event === "close") requestListeners.push(listener); },
      off: () => {},
    } as unknown as http.IncomingMessage;
    const res = { writableEnded: false, on: () => {}, off: () => {} } as unknown as http.ServerResponse;

    const pending = handleFilesSearch(req, res, ctx);
    for (const listener of requestListeners) listener();
    await pending;

    expect(writes[0]?.status).toBe(200);
    expect(writes[0]?.body).toMatchObject({ totalMatches: 2 });
  });

  it("takes its cancel signal from the response socket, not the request stream", async () => {
    const { ctx, writes } = searchContext({ theaterId: "theater-a", query: "needle", limit: 8 });
    const requestEvents: string[] = [];
    const responseEvents: string[] = [];
    const req = {
      method: "POST",
      on: (event: string) => { requestEvents.push(event); },
      off: () => {},
    } as unknown as http.IncomingMessage;
    const res = {
      writableEnded: false,
      on: (event: string) => { responseEvents.push(event); },
      off: () => {},
    } as unknown as http.ServerResponse;

    await handleFilesSearch(req, res, ctx);

    expect(responseEvents).toContain("close");
    expect(requestEvents).not.toContain("close");
    expect(writes[0]?.status).toBe(200);
  });

  it("returns only the kinds the caller asked for", async () => {
    // 공개 검색 경로는 파일 열기와 내용 일치를 위한 파일 결과만 반환한다.
    await fs.mkdir(path.join(theaterPath, "needle-dir"));
    const defaultSearch = searchContext({ theaterId: "theater-a", query: "needle", limit: 8 });
    await handleFilesSearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, defaultSearch.ctx);
    const defaultBody = defaultSearch.writes[0]?.body as { files: Array<{ kind: string }> };
    expect(defaultBody.files.every((file) => file.kind === "file")).toBe(true);

    const filesOnly = searchContext({ theaterId: "theater-a", query: "needle", limit: 8, kinds: ["file"] });
    await handleFilesSearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, filesOnly.ctx);
    const filesBody = filesOnly.writes[0]?.body as { files: Array<{ kind: string }>; totalMatches: number };
    expect(filesBody.files.every((file) => file.kind === "file")).toBe(true);
    // 종류 필터는 상한과 집계 전에 걸린다 — 총계도 파일만 센다.
    expect(filesBody.totalMatches).toBe(filesBody.files.length);
  });

  it("rejects an unknown kinds value instead of ignoring it", async () => {
    const { ctx, writes } = searchContext({ theaterId: "theater-a", query: "needle", limit: 8, kinds: ["folder"] });
    await handleFilesSearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);
    expect(writes[0]).toEqual({ status: 400, body: { error: "invalid_request" } });
  });

  it("drops hidden matches before the limit and the count", async () => {
    // 숨김 경로가 상한을 채운 뒤 클라이언트에서 걸리면 화면은 비고 안내만 일치 수를 말한다.
    await fs.mkdir(path.join(theaterPath, ".secret"), { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      await fs.writeFile(path.join(theaterPath, ".secret", `needle-${index}.ts`), "export {}");
    }
    const shown = searchContext({ theaterId: "theater-a", query: "needle", limit: 200, includeHidden: false });
    await handleFilesSearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, shown.ctx);
    const body = shown.writes[0]?.body as { files: Array<{ relativePath: string }>; totalMatches: number };
    expect(body.files.every((file) => !file.relativePath.split("/").some((segment) => segment.startsWith(".")))).toBe(true);
    expect(body.totalMatches).toBe(body.files.length);

    const withHidden = searchContext({ theaterId: "theater-a", query: "needle", limit: 200, includeHidden: true });
    await handleFilesSearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, withHidden.ctx);
    const hiddenBody = withHidden.writes[0]?.body as { totalMatches: number };
    expect(hiddenBody.totalMatches).toBeGreaterThan(body.totalMatches);
  });

  it("does not charge hidden entries against the traversal budget", async () => {
    // 결과에서만 걸러내면 점 파일이 항목 예산을 태워 보이는 파일에 닿지 못한다.
    const source = fsSync.readFileSync(new URL("../server/tree-services.ts", import.meta.url), "utf8");
    const walk = source.slice(source.indexOf("if (entryCount >= SEARCH_ENTRY_CAP)"));
    const skipIndex = walk.indexOf('if (!includeHidden && entry.name.startsWith("."))');
    const chargeIndex = walk.indexOf("entryCount += 1;");
    expect(skipIndex).toBeGreaterThan(-1);
    expect(skipIndex).toBeLessThan(chargeIndex);
  });

  it("accepts a palette-search limit of 200", async () => {
    const { ctx, writes } = searchContext({ theaterId: "theater-a", query: "needle", limit: 200 });

    await handleFilesSearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(writes[0]?.status).toBe(200);
    expect((writes[0]?.body as { files: unknown[] }).files.length).toBeLessThanOrEqual(200);
  });

  it("rejects a palette-search limit above 200", async () => {
    const { ctx, writes } = searchContext({ theaterId: "theater-a", query: "needle", limit: 201 });

    await handleFilesSearch({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);

    expect(writes[0]).toEqual({ status: 400, body: { error: "invalid_request" } });
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
