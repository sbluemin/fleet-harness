import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDurableJsonStore } from "../../src/fs-store/json-store.js";

interface TestData {
  version: number;
  value: string;
}

function sanitize(raw: unknown): TestData {
  if (typeof raw === "object" && raw !== null && "version" in raw && "value" in raw) {
    const r = raw as Record<string, unknown>;
    if (typeof r.version === "number" && typeof r.value === "string") {
      return { version: r.version, value: r.value };
    }
  }
  return { version: 1, value: "" };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-json-store-"));
  tempDirs.push(dir);
  return dir;
}

describe("createDurableJsonStore", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("없는 파일이면 sanitize(undefined) 기본값을 반환한다", () => {
    const dir = makeTempDir();
    const store = createDurableJsonStore<TestData>({
      filePath: path.join(dir, "data.json"),
      lockDir: null,
      sanitize,
      sensitivity: "normal",
    });

    expect(store.load()).toEqual({ version: 1, value: "" });
  });

  it("save 후 load가 동일 데이터를 반환한다", () => {
    const dir = makeTempDir();
    const store = createDurableJsonStore<TestData>({
      filePath: path.join(dir, "data.json"),
      lockDir: null,
      sanitize,
      sensitivity: "normal",
    });

    store.save({ version: 1, value: "hello" });

    expect(store.load()).toEqual({ version: 1, value: "hello" });
  });

  it("update가 현재 값을 읽고 변환된 값을 저장한다", () => {
    const dir = makeTempDir();
    const store = createDurableJsonStore<TestData>({
      filePath: path.join(dir, "data.json"),
      lockDir: null,
      sanitize,
      sensitivity: "normal",
    });

    store.save({ version: 1, value: "initial" });
    const result = store.update((current) => ({ ...current, value: "updated" }));

    expect(result).toEqual({ version: 1, value: "updated" });
    expect(store.load()).toEqual({ version: 1, value: "updated" });
  });

  it("lockDir 사용 시 락을 통해 쓰기를 보호한다", () => {
    const dir = makeTempDir();
    const lockDir = path.join(dir, "data.json.lock");
    const store = createDurableJsonStore<TestData>({
      filePath: path.join(dir, "data.json"),
      lockDir,
      sanitize,
      sensitivity: "normal",
      timeoutMs: 2000,
    });

    store.save({ version: 1, value: "locked-write" });
    expect(store.load()).toEqual({ version: 1, value: "locked-write" });
  });

  it("path 속성이 올바른 filePath를 반환한다", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "myfile.json");
    const store = createDurableJsonStore<TestData>({
      filePath,
      lockDir: null,
      sanitize,
      sensitivity: "normal",
    });

    expect(store.path).toBe(filePath);
  });

  it("temp 파일을 정리한다", () => {
    const dir = makeTempDir();
    const store = createDurableJsonStore<TestData>({
      filePath: path.join(dir, "data.json"),
      lockDir: path.join(dir, "data.json.lock"),
      sanitize,
      sensitivity: "normal",
      tempCleanupPrefix: ".tmp-data.json-",
      timeoutMs: 2000,
    });

    store.save({ version: 1, value: "clean" });

    const entries = fs.readdirSync(dir);
    expect(entries.filter((e) => e.startsWith(".tmp-data.json-"))).toHaveLength(0);
  });

  it("sensitive 모드에서 0o600 권한으로 파일을 생성한다", () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir();
    const store = createDurableJsonStore<TestData>({
      filePath: path.join(dir, "secret.json"),
      lockDir: null,
      sanitize,
      sensitivity: "sensitive",
    });

    store.save({ version: 1, value: "secret" });

    const stat = fs.statSync(path.join(dir, "secret.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("mutate가 undefined를 반환하면 쓰기를 생략하고 현재 값을 돌려준다", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "data.json");
    const store = createDurableJsonStore<TestData>({
      filePath,
      lockDir: `${filePath}.lock`,
      sanitize,
      sensitivity: "normal",
    });

    const result = store.update(() => undefined);

    // 바꿀 것이 없다는 판정이 빈 문서를 새로 만들면, 저장한 적 없는 파일이 생긴다.
    expect(result).toEqual({ version: 1, value: "" });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("mutate가 undefined를 반환해도 기존 파일은 그대로 둔다", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "data.json");
    const store = createDurableJsonStore<TestData>({
      filePath,
      lockDir: `${filePath}.lock`,
      sanitize,
      sensitivity: "normal",
    });
    store.save({ version: 2, value: "kept" });
    const before = fs.readFileSync(filePath, "utf-8");

    expect(store.update(() => undefined)).toEqual({ version: 2, value: "kept" });
    expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
  });

  it("normal 모드에서 0o644 권한으로 파일을 생성한다", () => {
    if (process.platform === "win32") return;
    const dir = makeTempDir();
    const store = createDurableJsonStore<TestData>({
      filePath: path.join(dir, "data.json"),
      lockDir: null,
      sanitize,
      sensitivity: "normal",
    });

    store.save({ version: 1, value: "data" });

    const stat = fs.statSync(path.join(dir, "data.json"));
    expect(stat.mode & 0o777).toBe(0o644);
  });
});
