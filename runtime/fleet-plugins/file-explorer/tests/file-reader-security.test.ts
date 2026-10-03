import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FileReadError, readFileForTheater, type FileReadResult } from "../server/file-reader.js";
import { ImageServeError, readImageForTheater } from "../server/image-server.js";
import { handleFilesDiskStatus, handleFilesRead, handleFilesResolve } from "../server/tree-services.js";

let tmpDir: string;
let theaterPath: string;

beforeAll(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fexp-sec-"));
  theaterPath = path.join(tmpDir, "theater");
  await fs.promises.mkdir(theaterPath);
  await fs.promises.symlink(theaterPath, path.join(tmpDir, "theater-alias"), "dir");

  // Theater 밖 파일
  await fs.promises.writeFile(path.join(tmpDir, "outside.txt"), "secret");
  await fs.promises.writeFile(path.join(tmpDir, "outside.png"), Buffer.alloc(4, 0));

  // Theater 안 정상 파일
  await fs.promises.writeFile(path.join(theaterPath, "normal.txt"), "hello");
  await fs.promises.writeFile(path.join(theaterPath, "normal.png"), Buffer.alloc(4, 0));
  await fs.promises.writeFile(path.join(theaterPath, "readme-demo.gif"), Buffer.alloc(10 * 1024 * 1024, 0));

  // Theater 안에서 Theater 밖을 가리키는 심링크
  await fs.promises.symlink(
    path.join(tmpDir, "outside.txt"),
    path.join(theaterPath, "link-outside.txt"),
  );
  await fs.promises.symlink(
    path.join(tmpDir, "outside.png"),
    path.join(theaterPath, "link-outside.png"),
  );
});

afterAll(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe("readFileForTheater — symlink containment", () => {
  it("reads a normal file inside the Theater", async () => {
    const result = await readFileForTheater(theaterPath, "normal.txt");
    expect(result.content).toBe("hello");
  });

  it("rejects a symlink that resolves outside the Theater", async () => {
    await expect(
      readFileForTheater(theaterPath, "link-outside.txt"),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof FileReadError && e.code === "path_outside_theater",
    );
  });

  it("rejects path traversal via ../", async () => {
    await expect(
      readFileForTheater(theaterPath, "../outside.txt"),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof FileReadError && e.code === "path_outside_theater",
    );
  });
});

describe("Files bounded reads", () => {
  it("reads a large text file through bounded head, range and tail requests at the public endpoint", async () => {
    const cap = 1024 * 1024;
    // 뒤쪽 한글은 head의 마지막 바이트에 걸치고, tail의 시작점은 앞쪽 한글 중간에 선다.
    const content = "HEAD\nx한" + "x".repeat(cap - 10) + "한\nTAIL";
    await fs.promises.writeFile(path.join(theaterPath, "large.log"), content);
    const read = async (window: unknown) => {
      let status = 0;
      let payload: unknown;
      const ctx = { host: {
        security: { isTerminalAuthorized: () => true }, paths: { resolveTheaterPath: () => theaterPath },
        http: { readJsonBody: async () => ({ theaterId: "fixture", relativePath: "large.log", window }), writeJson: (_res: unknown, code: number, body: unknown) => { status = code; payload = body; } },
      } } as unknown as FleetPluginServerContext;
      await handleFilesRead({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);
      expect(JSON.stringify(payload)).not.toContain(tmpDir);
      const result = payload as FileReadResult;
      if (status === 200) expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(1024 * 1024);
      return { status, payload: result };
    };
    const head = await read({ mode: "head" });
    expect(head.status).toBe(200);
    expect(head.payload.content.startsWith("HEAD")).toBe(true);
    const range = await read({ mode: "range", offset: head.payload.window!.endByte });
    expect(range.status).toBe(200);
    expect(range.payload.window!.startByte).toBe(head.payload.window!.endByte);
    // 1MiB Buffer의 깊은 toEqual은 CI에서 timeout을 넘기므로 바이트 비교는 Buffer.equals로 한다.
    expect(Buffer.from(head.payload.content + range.payload.content).equals(Buffer.from(content))).toBe(true);
    const tail = await read({ mode: "tail" });
    expect(tail.status).toBe(200);
    expect(tail.payload.content.endsWith("TAIL")).toBe(true);
    expect(tail.payload.window!.endByte).toBe(Buffer.byteLength(content));
    expect(Buffer.from(tail.payload.content).equals(Buffer.from(content).subarray(tail.payload.window!.startByte, tail.payload.window!.endByte))).toBe(true);
    const insideCharacter = await read({ mode: "range", offset: cap });
    expect(insideCharacter.payload.window!.startByte).toBe(head.payload.window!.endByte + Buffer.byteLength("한"));
    expect(insideCharacter.payload.content).toBe("\nTAIL");
    expect((await read({ mode: "range", offset: -1 })).status).toBe(400);
  });
});

describe("Files migrated wiki metadata", () => {
  it("public reads identify only exact legacy copies with a contained regular migration marker", async () => {
    const legacy = path.join(theaterPath, ".fleet", "knowledge");
    await fs.promises.mkdir(path.join(legacy, "wiki"), { recursive: true });
    await fs.promises.writeFile(path.join(legacy, "wiki", "old.md"), "# Old fixture copy\n");
    const marker = path.join(legacy, ".codex-migration.json");
    const mapping = JSON.stringify({ schemaVersion: 1, entries: { "wiki/old.md": "fixture-entry" } });
    await fs.promises.writeFile(marker, mapping);
    const read = async () => {
      let payload: unknown;
      const ctx = { host: {
        security: { isTerminalAuthorized: () => true }, paths: { resolveTheaterPath: () => theaterPath },
        http: { readJsonBody: async () => ({ theaterId: "fixture", relativePath: ".fleet/knowledge/wiki/old.md" }), writeJson: (_res: unknown, _status: number, body: unknown) => { payload = body; } },
      } } as unknown as FleetPluginServerContext;
      await handleFilesRead({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);
      expect(JSON.stringify(payload)).not.toContain(tmpDir);
      return payload;
    };
    expect(await read()).toMatchObject({ migratedWikiEntryId: "fixture-entry" });
    await fs.promises.unlink(marker);
    const outsideMarker = path.join(tmpDir, "outside-marker.json");
    await fs.promises.writeFile(outsideMarker, mapping);
    await fs.promises.symlink(outsideMarker, marker);
    expect(await read()).not.toHaveProperty("migratedWikiEntryId");
  });
});

describe("Files reference resolution", () => {
  it("returns only Theater-relative paths and rejects lexical and realpath escapes at the public endpoint", async () => {
    const resolve = async (requestedPath: string, pathKind: "absolute" | "theater-relative") => {
      let response: { status: number; body: unknown } | undefined;
      const ctx = { host: {
        security: { isTerminalAuthorized: () => true },
        paths: { resolveTheaterPath: () => theaterPath },
        http: { readJsonBody: async () => ({ theaterId: "fixture", path: requestedPath, pathKind }), writeJson: (_res: unknown, status: number, body: unknown) => { response = { status, body }; } },
      } } as unknown as FleetPluginServerContext;
      await handleFilesResolve({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, ctx);
      expect(JSON.stringify(response)).not.toContain(tmpDir);
      return response;
    };
    expect(await resolve(path.join(theaterPath, "normal.txt"), "absolute")).toEqual({ status: 200, body: { path: "normal.txt", kind: "file" } });
    expect(await resolve(path.join(tmpDir, "theater-alias", "normal.txt"), "absolute")).toEqual({ status: 200, body: { path: "normal.txt", kind: "file" } });
    expect(await resolve("../outside.txt", "theater-relative")).toEqual({ status: 403, body: { error: "outside_theater" } });
    expect(await resolve("link-outside.txt", "theater-relative")).toEqual({ status: 403, body: { error: "outside_theater" } });
    expect(await resolve("missing.txt", "theater-relative")).toEqual({ status: 404, body: { error: "not_found" } });
    let diskStatus: unknown;
    const statusContext = { host: {
      security: { isTerminalAuthorized: () => true }, paths: { resolveTheaterPath: () => theaterPath },
      http: { readJsonBody: async () => ({ theaterId: "fixture", paths: ["normal.txt", "link-outside.txt", "missing.txt"] }), writeJson: (_res: unknown, _status: number, body: unknown) => { diskStatus = body; } },
    } } as unknown as FleetPluginServerContext;
    await handleFilesDiskStatus({ method: "POST" } as http.IncomingMessage, {} as http.ServerResponse, statusContext);
    expect(diskStatus).toEqual({ statuses: [
      { relativePath: "normal.txt", state: "present", mtimeMs: expect.any(Number) },
      { relativePath: "link-outside.txt", state: "unavailable" },
      { relativePath: "missing.txt", state: "deleted" },
    ] });
    expect(JSON.stringify(diskStatus)).not.toContain(tmpDir);
  });
});

describe("readImageForTheater — symlink containment", () => {

  it("rejects a symlinked image that resolves outside the Theater", async () => {
    await expect(
      readImageForTheater(theaterPath, "link-outside.png"),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ImageServeError && e.code === "path_outside_theater",
    );
  });
});
