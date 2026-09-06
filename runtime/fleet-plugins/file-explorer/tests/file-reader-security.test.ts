import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FileReadError, readFileForTheater } from "../server/file-reader.js";
import { ImageServeError, readImageForTheater } from "../server/image-server.js";
import { handleFilesImage } from "../server/tree-services.js";

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

describe("readImageForTheater — symlink containment", () => {

  it("rejects a symlinked image that resolves outside the Theater", async () => {
    await expect(
      readImageForTheater(theaterPath, "link-outside.png"),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ImageServeError && e.code === "path_outside_theater",
    );
  });
});
