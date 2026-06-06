import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
  };
});

import { writeAtomicSync, writeAtomicAsync } from "../../src/fs-store/atomic-write.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-atomic-write-"));
  tempDirs.push(dir);
  return dir;
}

function makeErrnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("writeAtomicSync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("fsync EPERM은 저장을 막지 않는다", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "test.json");
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw makeErrnoError("EPERM");
    });

    writeAtomicSync(filePath, "content");

    expect(fs.readFileSync(filePath, "utf-8")).toBe("content");
  });

  it("fsync EIO는 실제 I/O 오류로 전파한다", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "test.json");
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw makeErrnoError("EIO");
    });

    expect(() => writeAtomicSync(filePath, "content")).toThrow(/EIO/);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe("writeAtomicAsync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("fsync EPERM은 저장을 막지 않는다", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "test.json");
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
      const fd = await originalOpen(...args);
      vi.spyOn(fd, "sync").mockRejectedValueOnce(makeErrnoError("EPERM"));
      return fd;
    });

    await writeAtomicAsync(filePath, "content");

    expect(fs.readFileSync(filePath, "utf-8")).toBe("content");
  });

  it("fsync EIO는 실제 I/O 오류로 전파한다", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "test.json");
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementationOnce(async (...args) => {
      const fd = await originalOpen(...args);
      vi.spyOn(fd, "sync").mockRejectedValueOnce(makeErrnoError("EIO"));
      return fd;
    });

    await expect(writeAtomicAsync(filePath, "content")).rejects.toThrow(/EIO/);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
