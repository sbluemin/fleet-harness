/**
 * runtime 단위 테스트
 *
 * internal/agent/runtime.ts의 핵심 계약을 검증합니다:
 * - initRuntime이 `.data` 디렉토리를 생성하는지
 * - 모델 설정 load/save가 올바른 경로에서 동작하는지
 * - 세션 매핑이 initRuntime → onHostSessionChange 흐름으로 동작하는지
 * - 미초기화 상태에서 graceful fallback이 동작하는지
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  initRuntime,
  onHostSessionChange,
  getSessionStore,
  getSessionId,
  getDataDir,
} from "../../src/admiral/agent/internal/session-runtime.js";
import {
  initStore,
  loadModels as getModelConfig,
  saveModels as saveSelectedModels,
  reconcileActiveModelSelections,
  updateModelSelection,
  updateAllModelSelections,
  savePerCliSettings,
  loadCliTypeOverrides,
  updateCliTypeOverride,
} from "../../src/admiral/store/index.js";

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "runtime-test-"));
}

function rmDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  rmDir(tmpDir);
});

describe("initRuntime", () => {
  it("존재하지 않는 dataDir을 자동으로 생성한다", () => {
    const deepDir = path.join(tmpDir, "core", ".data");
    expect(fs.existsSync(deepDir)).toBe(false);

    initRuntime(deepDir);

    expect(fs.existsSync(deepDir)).toBe(true);
    expect(getDataDir()).toBe(deepDir);
  });

  it("이미 존재하는 dataDir에 대해 에러 없이 동작한다", () => {
    initRuntime(tmpDir);
    initRuntime(tmpDir);
    expect(getDataDir()).toBe(tmpDir);
  });
});

describe("getModelConfig / saveSelectedModels", () => {
  it("초기 상태에서 빈 객체를 반환한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    expect(getModelConfig()).toEqual({});
  });

  it("저장된 모델 설정을 올바르게 로드한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    const config = { genesis: { model: "opus" }, sentinel: { model: "gpt-5" } };
    saveSelectedModels(config);

    const loaded = getModelConfig();
    expect(loaded.genesis?.model).toBe("opus");
    expect(loaded.sentinel?.model).toBe("gpt-5");
  });

  it("initRuntime 없이 호출하면 빈 객체를 반환한다 (graceful)", () => {
    const nonExistentDir = path.join(tmpDir, "nonexistent", "deep");
    initRuntime(nonExistentDir);
    initStore(nonExistentDir);
    expect(getModelConfig()).toEqual({});
  });

  it("새로 생성된 dataDir에서 첫 모델 저장이 ENOENT 없이 성공한다", () => {
    const deepDir = path.join(tmpDir, "brand", "new", "path");
    initRuntime(deepDir);
    initStore(deepDir);

    expect(() => {
      saveSelectedModels({ vanguard: { model: "gemini-3" } });
    }).not.toThrow();

    const filePath = path.join(deepDir, "states.json");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("updateModelSelection은 cliType이 아닌 carrierId 키로 저장한다", async () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    onHostSessionChange("model-by-carrier");
    const store = getSessionStore();
    store.set("vanguard", "vanguard-session");

    await updateModelSelection("vanguard", { model: "gemini-2.5-pro" });

    const loaded = getModelConfig();
    expect(loaded.vanguard?.model).toBe("gemini-2.5-pro");
    expect(store.get("vanguard")).toBeUndefined();
  });

  it("updateAllModelSelections은 carrierId 키들을 그대로 저장하고 세션을 정리한다", async () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    onHostSessionChange("bulk-models");
    const store = getSessionStore();
    store.set("vanguard", "vanguard-session");
    store.set("sentinel", "sentinel-session");

    await updateAllModelSelections({
      vanguard: { model: "gemini-2.5-flash" },
      sentinel: { model: "gpt-5" },
    });

    const loaded = getModelConfig();
    expect(loaded.vanguard?.model).toBe("gemini-2.5-flash");
    expect(loaded.sentinel?.model).toBe("gpt-5");
    expect(store.get("vanguard")).toBeUndefined();
    expect(store.get("sentinel")).toBeUndefined();
  });

  it("reconcileActiveModelSelections는 현재 cliType 기준으로 top-level 선택을 재수화한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    saveSelectedModels({
      vanguard: {
        model: "gpt-5.4-mini",
        effort: "xhigh",
        perCliSettings: {
          codex: {
            model: "gpt-5.4-mini",
            effort: "xhigh",
          },
          gemini: {
            model: "gemini-3.1-pro-preview",
          },
        },
      },
    });

    const changed = reconcileActiveModelSelections({ vanguard: "gemini" as any });
    const loaded = getModelConfig();

    expect(changed).toBe(true);
    expect(loaded.vanguard?.model).toBe("gemini-3.1-pro-preview");
    expect(loaded.vanguard?.effort).toBeUndefined();
    expect(loaded.vanguard?.perCliSettings?.gemini?.model).toBe("gemini-3.1-pro-preview");
  });

  it("reconcileActiveModelSelections는 현재 top-level 선택이 유효하면 유지한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    saveSelectedModels({
      genesis: {
        model: "gpt-5.4",
        effort: "high",
        perCliSettings: {
          codex: {
            model: "gpt-5.4-mini",
            effort: "medium",
          },
        },
      },
    });

    const changed = reconcileActiveModelSelections({ genesis: "codex" as any });
    const loaded = getModelConfig();

    expect(changed).toBe(false);
    expect(loaded.genesis?.model).toBe("gpt-5.4");
    expect(loaded.genesis?.effort).toBe("high");
  });

  it("단일 cliType override 저장은 기존 다른 override를 보존한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);

    updateCliTypeOverride("alpha", "codex", "claude");
    updateCliTypeOverride("beta", "gemini", "codex");

    expect(loadCliTypeOverrides()).toEqual({
      alpha: "codex",
      beta: "gemini",
    });
  });

  it("단일 cliType override 삭제는 다른 override를 보존한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);

    updateCliTypeOverride("alpha", "codex", "claude");
    updateCliTypeOverride("beta", "gemini", "codex");
    updateCliTypeOverride("alpha", "claude", "claude");

    expect(loadCliTypeOverrides()).toEqual({
      beta: "gemini",
    });
  });

  it("모델 저장은 기존 cliTypeOverrides를 보존한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);

    updateCliTypeOverride("alpha", "codex", "claude");
    saveSelectedModels({ alpha: { model: "gpt-5.4" } });

    expect(loadCliTypeOverrides()).toEqual({ alpha: "codex" });
  });

  it("per-CLI 설정 저장은 기존 cliTypeOverrides를 보존한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);

    updateCliTypeOverride("alpha", "codex", "claude");
    savePerCliSettings("alpha", "claude", { model: "claude-opus-4-7" });

    expect(loadCliTypeOverrides()).toEqual({ alpha: "codex" });
  });

  it("죽은 owner의 stale lock은 owner metadata 확인 후 회수한다", () => {
    initRuntime(tmpDir);
    initStore(tmpDir);
    const lockDir = path.join(tmpDir, "states.json.lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 999999,
        hostname: os.hostname(),
        startedAt: Date.now() - 60000,
      }),
      "utf-8",
    );

    updateCliTypeOverride("alpha", "codex", "claude");

    expect(loadCliTypeOverrides()).toEqual({ alpha: "codex" });
    expect(fs.existsSync(lockDir)).toBe(false);
  });
});

describe("세션 매핑 (sessionStore + onHostSessionChange)", () => {
  it("호스트 세션 변경 후 세션 매핑이 복원된다", () => {
    initRuntime(tmpDir);

    onHostSessionChange("test-session-1");
    const store = getSessionStore();
    store.set("genesis" as any, "sub-session-abc");
    expect(store.get("genesis" as any)).toBe("sub-session-abc");

    onHostSessionChange("test-session-2");
    expect(store.get("genesis" as any)).toBeUndefined();

    onHostSessionChange("test-session-1");
    expect(store.get("genesis" as any)).toBe("sub-session-abc");
  });

  it("getSessionId로 CLI별 sessionId를 조회할 수 있다", () => {
    initRuntime(tmpDir);
    onHostSessionChange("sid-1");
    const store = getSessionStore();
    store.set("sentinel" as any, "sentinel-session-xyz");

    expect(getSessionId("sentinel" as any)).toBe("sentinel-session-xyz");
    expect(getSessionId("genesis" as any)).toBeUndefined();
  });

  it("미초기화 상태에서 getSessionStore는 noop store를 반환한다", () => {
    const freshDir = path.join(tmpDir, "fresh");
    initRuntime(freshDir);
    const store = getSessionStore();
    expect(store.get("genesis" as any)).toBeUndefined();
    store.set("genesis" as any, "some-id");
  });

  it("세션 매핑 파일이 session-maps/ 하위에 저장된다", () => {
    initRuntime(tmpDir);
    onHostSessionChange("persist-test");
    const store = getSessionStore();
    store.set("vanguard" as any, "gem-sess-1");

    const sessionFile = path.join(tmpDir, "session-maps", "persist-test.json");
    expect(fs.existsSync(sessionFile)).toBe(true);

    const content = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    expect(content.vanguard).toBe("gem-sess-1");
  });
});
