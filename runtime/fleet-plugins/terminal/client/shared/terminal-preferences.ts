export type TerminalRenderer = "webgl" | "dom";

export type TerminalInactiveFlush = "saving" | "balanced" | "instant";

export const DEFAULT_TERMINAL_INACTIVE_FLUSH: TerminalInactiveFlush = "balanced";

// 선택하지 않은 패널이 출력을 화면에 옮기는 주기. 활성 패널은 이 설정의 대상이 아니다 — 사용자가
// 보고 있는 터미널을 느리게 만드는 선택지는 만들지 않는다. balanced가 이 설정이 생기기 전의 동작이다.
const TERMINAL_INACTIVE_FLUSH_MS: Record<TerminalInactiveFlush, number> = {
  saving: 500,
  balanced: 250,
  instant: 50,
};

export function terminalInactiveFlushMs(inactiveFlush: TerminalInactiveFlush): number {
  return TERMINAL_INACTIVE_FLUSH_MS[inactiveFlush];
}

export function isTerminalInactiveFlush(value: unknown): value is TerminalInactiveFlush {
  return value === "saving" || value === "balanced" || value === "instant";
}

export type TerminalFontId = "cascadia" | "jetbrains" | "fira-code" | "source-code-pro";

export type TerminalFontSource = "curated" | "custom";

export interface TerminalFontSettings {
  readonly source: TerminalFontSource;
  readonly id: TerminalFontId | null;
  readonly customName: string;
  readonly family: string;
  readonly size: number;
}

import { fontResolves, sanitizeFontFamilyName, withFontFallback } from "@fleet-console/font-picker/resolve";


export interface CuratedTerminalFont {
  readonly id: TerminalFontId;
  readonly name: string;
  readonly familyName: string;
  readonly family: string;
  readonly meta: string;
}

export interface TerminalFontResolution {
  readonly status: "self-hosted" | "resolved" | "fallback";
  readonly fallbackName: string;
}

interface StoredTerminalFontSettings {
  readonly source?: unknown;
  readonly id?: unknown;
  readonly customName?: unknown;
  readonly size?: unknown;
}

const SYMBOLS_NERD_FONT_MONO_FAMILY = "Symbols Nerd Font Mono";
const TERMINAL_FONT_FALLBACK_STACK = `ui-monospace, "SF Mono", Menlo, "${SYMBOLS_NERD_FONT_MONO_FAMILY}", monospace`;
const DEFAULT_TERMINAL_FONT_SIZE = 14;
const MIN_TERMINAL_FONT_SIZE = 10;
const MAX_TERMINAL_FONT_SIZE = 22;

export const TERMINAL_FONT_SIZE_RANGE = {
  min: MIN_TERMINAL_FONT_SIZE,
  max: MAX_TERMINAL_FONT_SIZE,
};

export const DEFAULT_TERMINAL_FONT_ID: TerminalFontId = "cascadia";

export const CURATED_TERMINAL_FONTS: readonly CuratedTerminalFont[] = [
  {
    id: "cascadia",
    name: "Cascadia Code",
    familyName: "Cascadia Code Variable",
    family: `"Cascadia Code Variable", ${TERMINAL_FONT_FALLBACK_STACK}`,
    meta: "Variable · terminal tuned",
  },
  {
    id: "jetbrains",
    name: "JetBrains Mono",
    familyName: "JetBrains Mono Variable",
    family: `"JetBrains Mono Variable", ${TERMINAL_FONT_FALLBACK_STACK}`,
    meta: "Variable · console mono",
  },
  {
    id: "fira-code",
    name: "Fira Code",
    familyName: "Fira Code Variable",
    family: `"Fira Code Variable", ${TERMINAL_FONT_FALLBACK_STACK}`,
    meta: "Variable · ligatures",
  },
  {
    id: "source-code-pro",
    name: "Source Code Pro",
    familyName: "Source Code Pro Variable",
    family: `"Source Code Pro Variable", ${TERMINAL_FONT_FALLBACK_STACK}`,
    meta: "Variable · Adobe mono",
  },
];

export const DEFAULT_TERMINAL_FONT = CURATED_TERMINAL_FONTS[0] as CuratedTerminalFont;

export function curatedTerminalFontById(id: TerminalFontId | null): CuratedTerminalFont {
  return CURATED_TERMINAL_FONTS.find((font) => font.id === id) ?? DEFAULT_TERMINAL_FONT;
}

export function createDefaultTerminalFontSettings(): TerminalFontSettings {
  return {
    source: "curated",
    id: DEFAULT_TERMINAL_FONT_ID,
    customName: "",
    family: DEFAULT_TERMINAL_FONT.family,
    size: DEFAULT_TERMINAL_FONT_SIZE,
  };
}

export function createCuratedTerminalFontSettings(id: TerminalFontId | null, size: number): TerminalFontSettings {
  const font = curatedTerminalFontById(id);
  return {
    source: "curated",
    id: font.id,
    customName: "",
    family: font.family,
    size: clampTerminalFontSize(size),
  };
}

export function createCustomTerminalFontSettings(customName: string, size: number): TerminalFontSettings {
  const sanitizedName = sanitizeCustomFontFamilyName(customName);
  return {
    source: "custom",
    id: null,
    customName: sanitizedName,
    family: withFontFallback(sanitizedName, DEFAULT_TERMINAL_FONT.family),
    size: clampTerminalFontSize(size),
  };
}

export function parseTerminalFontSettingsValue(value: unknown): TerminalFontSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const stored = value as StoredTerminalFontSettings;
  const size = clampTerminalFontSize(typeof stored.size === "number" ? stored.size : DEFAULT_TERMINAL_FONT_SIZE);
  if (stored.source === "custom" && typeof stored.customName === "string") {
    return createCustomTerminalFontSettings(stored.customName, size);
  }
  if (typeof stored.id === "string" && isTerminalFontId(stored.id)) {
    return createCuratedTerminalFontSettings(stored.id, size);
  }
  return null;
}

export function parseStoredTerminalFontSettings(raw: string | null): TerminalFontSettings {
  if (!raw) return createDefaultTerminalFontSettings();
  try {
    const parsed = parseTerminalFontSettingsValue(JSON.parse(raw) as unknown);
    if (parsed !== null) return parsed;
  } catch {
    // 손상된 localStorage 값은 기본 Cascadia self-hosted 설정으로 복구한다.
  }
  return createDefaultTerminalFontSettings();
}

export function serializeTerminalFontSettings(settings: TerminalFontSettings): string {
  return JSON.stringify({
    source: settings.source,
    id: settings.id,
    customName: settings.customName,
    size: settings.size,
  });
}

export function clampTerminalFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(size)));
}

export function resolveTerminalFont(settings: TerminalFontSettings): TerminalFontResolution {
  if (settings.source === "curated") {
    return { status: "self-hosted", fallbackName: DEFAULT_TERMINAL_FONT.name };
  }
  if (!settings.customName) {
    return { status: "fallback", fallbackName: DEFAULT_TERMINAL_FONT.name };
  }
  return {
    status: fontResolves(settings.customName) ? "resolved" : "fallback",
    fallbackName: DEFAULT_TERMINAL_FONT.name,
  };
}

function isTerminalFontId(value: string): value is TerminalFontId {
  return CURATED_TERMINAL_FONTS.some((font) => font.id === value);
}

function sanitizeCustomFontFamilyName(name: string): string {
  return sanitizeFontFamilyName(name);
}

import { useSyncExternalStore } from "react";

import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";


interface TerminalPrefsState {
  readonly renderer: TerminalRenderer;
  readonly inactiveFlush: TerminalInactiveFlush;
  readonly font: TerminalFontSettings;
}

type Listener = () => void;

const RENDERER_KEY = "fleet-plugin.terminal.renderer";
const INACTIVE_FLUSH_KEY = "fleet-plugin.terminal.inactiveFlush";
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

export function useTerminalInactiveFlush(): TerminalInactiveFlush {
  return useSyncExternalStore(subscribe, () => state.inactiveFlush, () => state.inactiveFlush);
}

export function useTerminalFontSettings(): TerminalFontSettings {
  return useSyncExternalStore(subscribe, () => state.font, () => state.font);
}

export function setTerminalRenderer(renderer: TerminalRenderer): void {
  writeStoredRenderer(renderer);
  patchState({ renderer });
}

export function setTerminalInactiveFlush(inactiveFlush: TerminalInactiveFlush): void {
  writeStoredInactiveFlush(inactiveFlush);
  patchState({ inactiveFlush });
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

function readStoredInactiveFlush(): TerminalInactiveFlush {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_INACTIVE_FLUSH;
  try {
    const stored = window.localStorage.getItem(INACTIVE_FLUSH_KEY);
    return isTerminalInactiveFlush(stored) ? stored : DEFAULT_TERMINAL_INACTIVE_FLUSH;
  } catch {
    return DEFAULT_TERMINAL_INACTIVE_FLUSH;
  }
}

function writeStoredInactiveFlush(inactiveFlush: TerminalInactiveFlush): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INACTIVE_FLUSH_KEY, inactiveFlush);
  } catch {
    // 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
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
    return { renderer: "webgl", inactiveFlush: DEFAULT_TERMINAL_INACTIVE_FLUSH, font: createDefaultTerminalFontSettings() };
  }
  migrateLegacyTerminalPrefs();
  return { renderer: readStoredRenderer(), inactiveFlush: readStoredInactiveFlush(), font: readStoredFont() };
}
