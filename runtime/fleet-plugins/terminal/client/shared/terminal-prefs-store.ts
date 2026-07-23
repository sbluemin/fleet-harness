import { useSyncExternalStore } from "react";

import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";

import { createCuratedTerminalFontSettings, createCustomTerminalFontSettings, createDefaultTerminalFontSettings, parseStoredTerminalFontSettings, parseTerminalFontSettingsValue, serializeTerminalFontSettings } from "./terminal-font.js";
import type { TerminalFontId, TerminalFontSettings, TerminalRenderer } from "./types.js";

interface TerminalPrefsState {
  readonly renderer: TerminalRenderer;
  readonly font: TerminalFontSettings;
}

type Listener = () => void;

const RENDERER_KEY = "fleet-plugin.terminal.renderer";
const FONT_KEY = "fleet-plugin.terminal.font";
const LEGACY_RENDERER_KEY = "fleet-console.terminalRenderer";
const LEGACY_FONT_KEY = "fleet-console.terminalFont";

const listeners = new Set<Listener>();

let state: TerminalPrefsState = initState();
let settingsCapability: ClientSettingsCapability | null = null;
let fontWriteEpoch = 0;
let terminalSettingsWriteFlight: Promise<void> | null = null;

export function migrateLegacyTerminalPrefs(): void {
  if (typeof window === "undefined") return;
  try {
    // 두 신규 키는 항상 함께 기록되므로(아래 setItem 2회) 둘 중 하나라도 있으면 이미 마이그레이션된 것으로 보고 no-op(idempotent).
    // OR 가드는 의도적이다 — AND로 바꾸면 부분쓰기 후 legacy 삭제된 상태에서 재진입 시 default로 덮어쓸 위험이 있다.
    if (window.localStorage.getItem(RENDERER_KEY) !== null || window.localStorage.getItem(FONT_KEY) !== null) return;
    const legacyRenderer = window.localStorage.getItem(LEGACY_RENDERER_KEY);
    const legacyFont = window.localStorage.getItem(LEGACY_FONT_KEY);
    const renderer: TerminalRenderer = legacyRenderer === "webgl" || legacyRenderer === "dom" ? legacyRenderer : "webgl";
    const font = parseStoredTerminalFontSettings(legacyFont);
    window.localStorage.setItem(RENDERER_KEY, renderer);
    window.localStorage.setItem(FONT_KEY, serializeTerminalFontSettings(font));
    window.localStorage.removeItem(LEGACY_RENDERER_KEY);
    window.localStorage.removeItem(LEGACY_FONT_KEY);
  } catch {
    // localStorage 접근 실패 시 in-memory 기본값 유지.
  }
}

export function connectTerminalSettings(settings: ClientSettingsCapability): void {
  // 재연결 시 진행 중인 이전 하이드레이션이 낡은 결과를 채택하지 못하도록 epoch를 올려 폐기한다.
  fontWriteEpoch += 1;
  settingsCapability = settings;
  void hydrateFontFromServer();
}

export function getTerminalPrefsSnapshot(): TerminalPrefsState {
  return state;
}

export function useTerminalPrefs(): TerminalPrefsState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useTerminalRenderer(): TerminalRenderer {
  return useSyncExternalStore(subscribe, () => state.renderer, () => state.renderer);
}

export function useTerminalFontSettings(): TerminalFontSettings {
  return useSyncExternalStore(subscribe, () => state.font, () => state.font);
}

export function setTerminalRenderer(renderer: TerminalRenderer): void {
  writeStoredRenderer(renderer);
  patchState({ renderer });
}

export function setTerminalFont(fontId: TerminalFontId): void {
  const font = createCuratedTerminalFontSettings(fontId, state.font.size);
  fontWriteEpoch += 1;
  patchState({ font });
  void pushFontToServer(font);
}

export function setCustomTerminalFont(customName: string): void {
  const font = createCustomTerminalFontSettings(customName, state.font.size);
  fontWriteEpoch += 1;
  patchState({ font });
  void pushFontToServer(font);
}

export function setInstalledTerminalFont(familyName: string): void {
  // 설치 폰트도 legacy custom wire shape로 직렬화해 저장 포맷 호환성을 유지한다.
  const font = createCustomTerminalFontSettings(familyName, state.font.size);
  fontWriteEpoch += 1;
  patchState({ font });
  void pushFontToServer(font);
}

export function setTerminalFontSize(size: number): void {
  const font = state.font.source === "custom"
    ? createCustomTerminalFontSettings(state.font.customName, size)
    : createCuratedTerminalFontSettings(state.font.id, size);
  fontWriteEpoch += 1;
  patchState({ font });
  void pushFontToServer(font);
}

async function hydrateFontFromServer(): Promise<void> {
  if (!settingsCapability) return;
  const epoch = fontWriteEpoch;
  try {
    const value = await settingsCapability.read("terminal");
    if (value !== null) {
      const parsed = parseTerminalFontSettingsValue(value["font"]);
      if (parsed !== null) {
        if (epoch !== fontWriteEpoch) return;
        patchState({ font: parsed });
        try { window.localStorage.removeItem(FONT_KEY); } catch { /* best-effort */ }
        return;
      }
    }
    // 서버 값 부재 — 1회 시드 마이그레이션
    if (typeof window !== "undefined") {
      let stored: string | null = null;
      try { stored = window.localStorage.getItem(FONT_KEY); } catch { /* best-effort */ }
      if (stored !== null) {
        const parsed = parseStoredTerminalFontSettings(stored);
        if (epoch !== fontWriteEpoch) return;
        patchState({ font: parsed });
        void pushFontToServer(parsed);
        try { window.localStorage.removeItem(FONT_KEY); } catch { /* best-effort */ }
      }
    }
  } catch {
    // best-effort — read 실패 시 조용히 현 상태 유지.
  }
}

async function pushFontToServer(font: TerminalFontSettings): Promise<void> {
  const settings = settingsCapability;
  if (!settings) return;
  try {
    await mergeTerminalSettingsRecord(settings, {
      font: { source: font.source, id: font.id, customName: font.customName, size: font.size },
    });
  } catch {
    // best-effort — write 실패 시 조용히 무시한다.
  }
}

export function mergeTerminalSettingsRecord(settings: ClientSettingsCapability, patch: Record<string, unknown>): Promise<void> {
  const merge = async () => {
    const current = await settings.read("terminal");
    await settings.write("terminal", { ...(current ?? {}), ...patch });
  };
  const previous = terminalSettingsWriteFlight;
  const write = previous ? previous.catch(() => undefined).then(merge) : merge();
  terminalSettingsWriteFlight = write;
  void write.finally(() => {
    if (terminalSettingsWriteFlight === write) terminalSettingsWriteFlight = null;
  }).catch(() => undefined);
  return write;
}

function readStoredRenderer(): TerminalRenderer {
  if (typeof window === "undefined") return "webgl";
  try {
    const stored = window.localStorage.getItem(RENDERER_KEY);
    return stored === "webgl" || stored === "dom" ? stored : "webgl";
  } catch {
    return "webgl";
  }
}

function readStoredFont(): TerminalFontSettings {
  if (typeof window === "undefined") return createDefaultTerminalFontSettings();
  try {
    return parseStoredTerminalFontSettings(window.localStorage.getItem(FONT_KEY));
  } catch {
    return createDefaultTerminalFontSettings();
  }
}

function writeStoredRenderer(renderer: TerminalRenderer): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RENDERER_KEY, renderer);
  } catch {
    // 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function patchState(patch: Partial<TerminalPrefsState>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): TerminalPrefsState {
  return state;
}

function initState(): TerminalPrefsState {
  if (typeof window === "undefined") {
    return { renderer: "webgl", font: createDefaultTerminalFontSettings() };
  }
  migrateLegacyTerminalPrefs();
  return { renderer: readStoredRenderer(), font: readStoredFont() };
}
