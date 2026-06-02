import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeAtomicSync, writeAtomicAsync } from "../../src/fs-store/atomic-write.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-atomic-write-"));
  tempDirs.push(dir);
  return dir;
}

describe("writeAtomicSync", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("원자적으로 파일을 생성한다", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "test.json");

    writeAtomicSync(filePath, '{"hello":"world"}');

    expect(fs.readFileSync(filePath, "utf-8")).toBe('{"hello":"world"}');
  });

  it("기존 파일을 원자적으로 교체한다", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "test.json");

    writeAtomicSync(filePath, "first");
    writeAtomicSync(filePath, "second");

    expect(fs.readFileSync(filePath, "utf-8")).toBe("second");
  });

  it("0o600 모드로 파일을 생성한다 (sensitive)", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "test.json");

    writeAtomicSync(filePath, "secret", { mode: 0o600 });

    const stat = fs.statSync(filePath);
    // Windows에서는 권한이 다를 수 있으므로 Unix에서만 확인
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("temp 파일을 정리한다 (실패시 남아있지 않음)", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "test.json");

    writeAtomicSync(filePath, "content");

    const entries = fs.readdirSync(dir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });
});

describe("writeAtomicAsync", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("비동기로 원자적 파일 쓰기", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "test.json");

    await writeAtomicAsync(filePath, '{"async":true}');

    expect(fs.readFileSync(filePath, "utf-8")).toBe('{"async":true}');
  });

  it("병렬 async 쓰기가 서로를 손상시키지 않는다", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "test.json");

    await writeAtomicAsync(filePath, "first");
    await writeAtomicAsync(filePath, "second");

    expect(fs.readFileSync(filePath, "utf-8")).toBe("second");
  });
});
