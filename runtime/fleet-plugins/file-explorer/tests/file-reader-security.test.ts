import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FileReadError, readFileForTheater } from "../server/file-reader.js";
import { ImageServeError, readImageForTheater } from "../server/image-server.js";
import { handleFilesResolve } from "../server/tree-services.js";

let tmpDir: string;
let theaterPath: string;

beforeAll(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fexp-sec-"));
  theaterPath = path.join(tmpDir, "theater");
  await fs.promises.mkdir(theaterPath);

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
    expect(await resolve("../outside.txt", "theater-relative")).toEqual({ status: 403, body: { error: "outside_theater" } });
    expect(await resolve("link-outside.txt", "theater-relative")).toEqual({ status: 403, body: { error: "outside_theater" } });
    expect(await resolve("missing.txt", "theater-relative")).toEqual({ status: 404, body: { error: "not_found" } });
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
