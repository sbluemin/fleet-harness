import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readFileForTheater } from "../server/file-reader.js";
import { listTheaterContents } from "../server/tree-services.js";

let dir: string | null = null;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("목록/읽기 메타", () => {
  it("목록 엔트리는 정렬용 sizeBytes/mtimeMs를 싣는다", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fexp-meta-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");
    fs.mkdirSync(path.join(dir, "sub"));

    const result = await listTheaterContents(dir, "");
    const fileEntry = result.entries.find((entry) => entry.name === "a.txt");
    const dirEntry = result.entries.find((entry) => entry.name === "sub");
    expect(fileEntry?.sizeBytes).toBe(5);
    expect(fileEntry?.mtimeMs).toBeTypeOf("number");
    // 디렉터리는 크기 신호가 없다 — mtime만 싣는다.
    expect(dirEntry?.sizeBytes).toBeUndefined();
    expect(dirEntry?.mtimeMs).toBeTypeOf("number");
  });

  it("파일 읽기는 전체 크기(sizeBytes)와 mtimeMs를 싣는다", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fexp-meta-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\nworld\n");

    const result = await readFileForTheater(dir, "a.txt");
    expect(result.sizeBytes).toBe(12);
    expect(result.truncated).toBeUndefined();
    expect(result.mtimeMs).toBe(fs.statSync(path.join(dir, "a.txt")).mtimeMs);
  });

  it("1 MiB cap으로 잘린 읽기도 mtimeMs를 싣는다", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fexp-meta-"));
    const payload = Buffer.alloc(1024 * 1024 + 40, 97);
    fs.writeFileSync(path.join(dir, "big.txt"), payload);

    const result = await readFileForTheater(dir, "big.txt");
    expect(result.truncated).toBe(true);
    expect(result.content).toHaveLength(1024 * 1024);
    expect(result.sizeBytes).toBe(1024 * 1024 + 40);
    expect(result.mtimeMs).toBe(fs.statSync(path.join(dir, "big.txt")).mtimeMs);
  });
});
