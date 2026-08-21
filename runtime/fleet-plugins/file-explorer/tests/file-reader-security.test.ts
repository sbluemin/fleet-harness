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
  it("serves README-scale local GIF assets inside the Theater", async () => {
    const result = await readImageForTheater(theaterPath, "readme-demo.gif");
    expect(result.mimeType).toBe("image/gif");
    expect(result.buffer.byteLength).toBe(10 * 1024 * 1024);
  });

  it("rejects a symlinked image that resolves outside the Theater", async () => {
    await expect(
      readImageForTheater(theaterPath, "link-outside.png"),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ImageServeError && e.code === "path_outside_theater",
    );
  });
});

describe("handleFilesImage cache-busting query", () => {
  it("serves the image when an extra v= parameter is present", async () => {
    const chunks: Buffer[] = [];
    let status = 0;
    const jsonWrites: Array<{ readonly status: number }> = [];
    const res = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (buf?: Buffer) => {
        if (buf) chunks.push(buf);
      },
    } as unknown as http.ServerResponse;
    const ctx = {
      host: {
        http: {
          writeJson: (_response: http.ServerResponse, code: number) => jsonWrites.push({ status: code }),
        },
        security: { isTerminalAuthorized: () => true },
        paths: { resolveTheaterPath: () => theaterPath },
      },
    } as unknown as FleetPluginServerContext;

    await handleFilesImage(
      {
        method: "GET",
        url: "/files/image?theaterId=theater-a&path=normal.png&v=1787123456789",
        headers: { host: "localhost" },
      } as http.IncomingMessage,
      res,
      ctx,
    );

    expect(jsonWrites).toEqual([]);
    expect(status).toBe(200);
    expect(Buffer.concat(chunks).byteLength).toBe(4);
  });
});
