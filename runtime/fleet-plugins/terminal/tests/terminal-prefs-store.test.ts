import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";

import { connectTerminalSettings, getTerminalPrefsSnapshot, mergeTerminalSettingsRecord, migrateLegacyTerminalPrefs, setInstalledTerminalFont, setTerminalFont, setTerminalFontSize } from "../client/shared/terminal-preferences.js";

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

describe("connectTerminalSettings / server hydration", () => {
  const store: Record<string, string> = {};
  const originalWindow = (globalThis as Record<string, unknown>).window;

  function makeStorage() {
    return {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    };
  }

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: makeStorage() },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  function makeCapability(opts: {
    serverValue?: Record<string, unknown> | null;
    readError?: boolean;
  } = {}): ClientSettingsCapability & { putCalls: { id: string; value: Record<string, unknown> }[] } {
    const putCalls: { id: string; value: Record<string, unknown> }[] = [];
    return {
      putCalls,
      read: async (_pluginId) => {
        if (opts.readError) throw new Error("network error");
        return opts.serverValue !== undefined ? opts.serverValue : null;
      },
      write: async (pluginId, value) => {
        putCalls.push({ id: pluginId, value });
      },
    };
  }

  it("hydrates font from server when server has a stored value", async () => {
    const cap = makeCapability({
      serverValue: { font: { source: "curated", id: "jetbrains", customName: "", size: 16 } },
    });
    connectTerminalSettings(cap);
    await vi.waitFor(() => expect(getTerminalPrefsSnapshot().font.id).toBe("jetbrains"));
    expect(getTerminalPrefsSnapshot().font.id).toBe("jetbrains");
    expect(store[FONT_KEY]).toBeUndefined();
  });

  it("seeds server from localStorage when server returns null and FONT_KEY exists", async () => {
    store[FONT_KEY] = JSON.stringify({ source: "curated", id: "fira-code", customName: "", size: 15 });
    const cap = makeCapability({ serverValue: null });
    connectTerminalSettings(cap);
    await vi.waitFor(() => expect(cap.putCalls.length).toBeGreaterThan(0));
    expect(cap.putCalls[0]?.id).toBe("terminal");
    expect((cap.putCalls[0]?.value as { font?: { id?: string } }).font?.id).toBe("fira-code");
    expect(store[FONT_KEY]).toBeUndefined();
  });

  it("seed migration is idempotent — second connect with server value does not PUT again", async () => {
    store[FONT_KEY] = JSON.stringify({ source: "curated", id: "fira-code", customName: "", size: 15 });
    const cap = makeCapability({ serverValue: null });
    connectTerminalSettings(cap);
    await vi.waitFor(() => expect(cap.putCalls.length).toBeGreaterThan(0));
    const firstCallCount = cap.putCalls.length;
    // 서버에 이제 값이 있음 — 재연결 시 추가 PUT 없음
    const cap2 = makeCapability({ serverValue: { font: { source: "curated", id: "fira-code", customName: "", size: 15 } } });
    connectTerminalSettings(cap2);
    // 하이드레이션이 서버 값을 채택할 때까지 대기한 뒤 재시드 PUT이 없음을 단언한다.
    await vi.waitFor(() => expect(getTerminalPrefsSnapshot().font.id).toBe("fira-code"));
    await new Promise((r) => setTimeout(r, 10));
    expect(cap2.putCalls.length).toBe(0);
    // 첫 번째 캐파빌리티의 총 PUT은 1회여야 함
    expect(firstCallCount).toBe(1);
  });

  it("race guard: user setTerminalFontSize during read prevents hydration from overriding", async () => {
    let resolveRead!: (v: Record<string, unknown> | null) => void;
    const cap: ClientSettingsCapability & { putCalls: { id: string; value: Record<string, unknown> }[] } = {
      putCalls: [],
      read: async () => new Promise<Record<string, unknown> | null>((resolve) => { resolveRead = resolve; }),
      write: async (id, value) => { cap.putCalls.push({ id, value }); },
    };
    connectTerminalSettings(cap);
    // read가 pending 중에 사용자가 폰트 크기 변경
    setTerminalFontSize(20);
    // 이제 서버 응답 도착 — epoch가 달라졌으므로 무시
    resolveRead({ font: { source: "curated", id: "jetbrains", customName: "", size: 12 } });
    await new Promise((r) => setTimeout(r, 10));
    // 현재 폰트는 사용자 설정값(20px)이어야 함
    expect(getTerminalPrefsSnapshot().font.size).toBe(20);
  });

  it("race guard: a pending hydration cannot overwrite an installed-font selection", async () => {
    let resolveRead!: (v: Record<string, unknown> | null) => void;
    const cap: ClientSettingsCapability & { putCalls: { id: string; value: Record<string, unknown> }[] } = {
      putCalls: [],
      read: async () => new Promise<Record<string, unknown> | null>((resolve) => { resolveRead = resolve; }),
      write: async (id, value) => { cap.putCalls.push({ id, value }); },
    };
    connectTerminalSettings(cap);
    setInstalledTerminalFont("  MesloLGS NF\u0000  ");
    resolveRead({ font: { source: "curated", id: "jetbrains", customName: "", size: 12 } });
    await vi.waitFor(() => expect(cap.putCalls.length).toBeGreaterThan(0));
    expect(getTerminalPrefsSnapshot().font).toMatchObject({ source: "custom", id: null, customName: "MesloLGS NF" });
    expect((cap.putCalls[0]?.value as { font?: unknown }).font).toEqual({ source: "custom", id: null, customName: "MesloLGS NF", cjkFallbackName: "", size: getTerminalPrefsSnapshot().font.size });
  });

  it("race guard: hydration does not seed PUT if write epoch changed", async () => {
    store[FONT_KEY] = JSON.stringify({ source: "curated", id: "fira-code", customName: "", size: 14 });
    let resolveRead!: (v: Record<string, unknown> | null) => void;
    const cap: ClientSettingsCapability & { putCalls: { id: string; value: Record<string, unknown> }[] } = {
      putCalls: [],
      read: async () => new Promise<Record<string, unknown> | null>((resolve) => { resolveRead = resolve; }),
      write: async (id, value) => { cap.putCalls.push({ id, value }); },
    };
    connectTerminalSettings(cap);
    setTerminalFont("jetbrains"); // epoch 증가 → hydration PUT 폐기
    resolveRead(null);
    await new Promise((r) => setTimeout(r, 10));
    // jetbrains 쓰기 PUT 1개만 있어야 함(hydration 시드 PUT은 없어야 함)
    expect(cap.putCalls.every((c) => {
      const font = (c.value as { font?: { id?: string } }).font;
      return font?.id === "jetbrains";
    })).toBe(true);
  });

  it("set* functions no longer write to localStorage font key", () => {
    connectTerminalSettings(makeCapability({ serverValue: null }));
    delete store[FONT_KEY]; // 초기화
    setTerminalFont("jetbrains");
    expect(store[FONT_KEY]).toBeUndefined();
    setTerminalFontSize(18);
    expect(store[FONT_KEY]).toBeUndefined();
  });

  it("set* functions issue a PUT to the server", async () => {
    const cap = makeCapability({ serverValue: null });
    connectTerminalSettings(cap);
    setTerminalFont("jetbrains");
    await vi.waitFor(() => expect(cap.putCalls.some((c) => {
      const font = (c.value as { font?: { id?: string } }).font;
      return font?.id === "jetbrains";
    })).toBe(true));
    expect(cap.putCalls.some((c) => {
      const font = (c.value as { font?: { id?: string } }).font;
      return font?.id === "jetbrains";
    })).toBe(true);
  });

  it("writes an installed family and size through the legacy custom server payload", async () => {
    const cap = makeCapability({ serverValue: null });
    connectTerminalSettings(cap);
    setTerminalFontSize(17);
    setInstalledTerminalFont("  MesloLGS NF\u0000  ");
    await vi.waitFor(() => expect(cap.putCalls.some((call) => (call.value as { font?: { customName?: string } }).font?.customName === "MesloLGS NF")).toBe(true));
    const installedWrite = cap.putCalls.find((call) => (call.value as { font?: { customName?: string } }).font?.customName === "MesloLGS NF");
    expect(installedWrite).toEqual({ id: "terminal", value: { font: { source: "custom", id: null, customName: "MesloLGS NF", cjkFallbackName: "", size: 17 } } });
    expect(store[FONT_KEY]).toBeUndefined();
  });

  it("preserves the Analyst selection when writing font settings", async () => {
    const selection = { cliId: "cursor", model: "auto", effort: "high" };
    const cap = makeCapability({ serverValue: { analyst: { selection } } });
    connectTerminalSettings(cap);
    setTerminalFont("jetbrains");
    await vi.waitFor(() => expect(cap.putCalls.some((call) => (call.value as { font?: { id?: string } }).font?.id === "jetbrains")).toBe(true));
    expect(cap.putCalls.find((call) => (call.value as { font?: { id?: string } }).font?.id === "jetbrains")).toEqual({
      id: "terminal",
      value: {
        analyst: { selection },
        font: { source: "curated", id: "jetbrains", customName: "", cjkFallbackName: "", size: getTerminalPrefsSnapshot().font.size },
      },
    });
  });

  it("serializes Terminal record merges so concurrent font and Analyst writes preserve both keys", async () => {
    let record: Record<string, unknown> = {};
    const settings: ClientSettingsCapability = {
      read: async () => ({ ...record }),
      write: async (_pluginId, value) => { record = value; },
    };
    const font = { source: "curated", id: "jetbrains", customName: "", size: 16 };
    const analyst = { selection: { cliId: "cursor", model: "auto", effort: "high" } };

    await Promise.all([
      mergeTerminalSettingsRecord(settings, { font }),
      mergeTerminalSettingsRecord(settings, { analyst }),
    ]);

    expect(record).toEqual({ font, analyst });
  });

  it("keeps the local fallback state when an installed-font server write fails", async () => {
    const cap = makeCapability({ serverValue: null });
    cap.write = async () => { throw new Error("network error"); };
    connectTerminalSettings(cap);
    setInstalledTerminalFont("Missing Mono");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getTerminalPrefsSnapshot().font).toMatchObject({ source: "custom", customName: "Missing Mono" });
    expect(store[FONT_KEY]).toBeUndefined();
  });

  it("does not throw when read fails; state stays unchanged", async () => {
    const cap = makeCapability({ readError: true });
    const fontBefore = getTerminalPrefsSnapshot().font;
    connectTerminalSettings(cap);
    await new Promise((r) => setTimeout(r, 20));
    expect(getTerminalPrefsSnapshot().font).toEqual(fontBefore);
  });
});
