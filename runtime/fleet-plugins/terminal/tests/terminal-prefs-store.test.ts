import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateLegacyTerminalPrefs } from "../client/shared/terminal-prefs-store.js";

const RENDERER_KEY = "fleet-plugin.terminal.renderer";
const FONT_KEY = "fleet-plugin.terminal.font";
const LEGACY_RENDERER_KEY = "fleet-console.terminalRenderer";
const LEGACY_FONT_KEY = "fleet-console.terminalFont";

describe("migrateLegacyTerminalPrefs", () => {
  const store: Record<string, string> = {};
  const originalWindow = (globalThis as Record<string, unknown>).window;

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: mockStorage },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  // Case A: 레거시 키 존재 → 새 키로 이전, 레거시 키 삭제
  it("migrates legacy renderer key to new namespace and removes legacy key", () => {
    store[LEGACY_RENDERER_KEY] = "dom";
    migrateLegacyTerminalPrefs();
    expect(store[RENDERER_KEY]).toBe("dom");
    expect(store[LEGACY_RENDERER_KEY]).toBeUndefined();
  });

  // Case B: 새 키가 이미 존재 → 레거시를 덮어쓰지 않음(no-op)
  it("does not overwrite existing new key when legacy also present", () => {
    store[RENDERER_KEY] = "webgl";
    store[LEGACY_RENDERER_KEY] = "dom";
    migrateLegacyTerminalPrefs();
    expect(store[RENDERER_KEY]).toBe("webgl");
    expect(store[LEGACY_RENDERER_KEY]).toBe("dom"); // 레거시도 그대로
  });

  // Case C: 둘 다 없으면 기본값 webgl로 새 키 기록
  it("writes default renderer when both keys absent", () => {
    migrateLegacyTerminalPrefs();
    expect(store[RENDERER_KEY]).toBe("webgl");
    expect(store[FONT_KEY]).toBeDefined();
    expect(store[LEGACY_RENDERER_KEY]).toBeUndefined();
    expect(store[LEGACY_FONT_KEY]).toBeUndefined();
  });

  // Case D: 두 번 호출해도 idempotent — 새 키가 생긴 뒤에는 no-op
  it("is idempotent when called a second time after migration", () => {
    store[LEGACY_RENDERER_KEY] = "dom";
    migrateLegacyTerminalPrefs();
    const rendererAfterFirst = store[RENDERER_KEY];
    // 레거시 재설정 후 재호출 — 새 키가 있으므로 덮어쓰면 안 됨
    store[LEGACY_RENDERER_KEY] = "webgl";
    migrateLegacyTerminalPrefs();
    expect(store[RENDERER_KEY]).toBe(rendererAfterFirst);
  });
});
