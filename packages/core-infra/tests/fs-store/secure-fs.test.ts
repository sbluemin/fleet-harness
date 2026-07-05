import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  safeLstat,
  ensureSafeDirectory,
  assertWithinRoot,
  readDirectoryIdentity,
} from "../../src/fs-store/secure-fs.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-secure-fs-"));
  tempDirs.push(dir);
  return dir;
}

describe("safeLstat", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("존재하는 파일의 stat을 반환한다", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "test.txt");
    fs.writeFileSync(file, "hello");

    const stat = safeLstat(file);
    expect(stat).not.toBeNull();
    expect(stat?.isFile()).toBe(true);
  });

  it("없는 경로는 null을 반환한다", () => {
    expect(safeLstat("/nonexistent/path/xyz")).toBeNull();
  });
});

describe("ensureSafeDirectory", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("없는 디렉터리를 생성한다", () => {
    const base = makeTempDir();
    const target = path.join(base, "new-dir");

    ensureSafeDirectory(target);

    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it("심볼릭링크를 디렉터리로 오용하면 throw한다", () => {
    if (process.platform === "win32") return; // Windows 심링크 생략
    const base = makeTempDir();
    const target = path.join(base, "safe-dir");
    const symlink = path.join(base, "sym-dir");
    fs.mkdirSync(target);
    fs.symlinkSync(target, symlink);

    expect(() => ensureSafeDirectory(symlink)).toThrow(/Unsafe/);
  });
});

describe("assertWithinRoot", () => {
  it("root 하위 경로는 통과한다", () => {
    const root = "/tmp/root";
    expect(() => assertWithinRoot(root, "/tmp/root/sub/file.txt")).not.toThrow();
  });

  it("root 외부 경로는 throw한다", () => {
    const root = "/tmp/root";
    expect(() => assertWithinRoot(root, "/tmp/other/file.txt")).toThrow(/escapes root/);
  });

  it("traversal 시도를 막는다", () => {
    const root = "/tmp/root";
    expect(() => assertWithinRoot(root, "/tmp/root/../other/file.txt")).toThrow(/escapes root/);
  });
});

describe("readDirectoryIdentity", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("디렉터리의 dev/ino를 반환한다", () => {
    const dir = makeTempDir();
    const identity = readDirectoryIdentity(dir);
    expect(identity).not.toBeNull();
    expect(typeof identity?.dev).toBe("number");
    expect(typeof identity?.ino).toBe("number");
  });

  it("없는 디렉터리는 null을 반환한다", () => {
    expect(readDirectoryIdentity("/nonexistent/path/xyz")).toBeNull();
  });
});
