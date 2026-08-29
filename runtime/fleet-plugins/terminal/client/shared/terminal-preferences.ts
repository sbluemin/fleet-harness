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

// 채팅 로그 컬럼의 읽기 폭 프리셋. 값은 chat.css의 data-reading-width 오버라이드와 한 벌이다 —
// reading이 기존의 100ch 중앙 컬럼이고, 폰트처럼 서버 영속(플러그인 설정)이라 콘솔을 따라다닌다.
export type ChatReadingWidth = "reading" | "wide" | "full";

export const DEFAULT_CHAT_READING_WIDTH: ChatReadingWidth = "reading";

export function isChatReadingWidth(value: unknown): value is ChatReadingWidth {
  return value === "reading" || value === "wide" || value === "full";
}

export function nextChatReadingWidth(width: ChatReadingWidth): ChatReadingWidth {
  return width === "reading" ? "wide" : width === "wide" ? "full" : "reading";
}

export type TerminalFontId = "cascadia" | "jetbrains" | "fira-code" | "source-code-pro";

export type TerminalFontSource = "curated" | "custom";

export interface TerminalFontSettings {
  readonly source: TerminalFontSource;
  readonly id: TerminalFontId | null;
  readonly customName: string;
  /* 선택 서체에 없는 CJK 글리프를 그릴 서체. 빈 문자열이면 번들 서체만 쓴다. 주 서체와 다른 축인
     이유는 커버리지가 겹치지 않기 때문이다 — 라틴 등폭 서체 중 CJK를 가진 것은 사실상 없고, 그
     둘을 한 선택지로 묶으면 라틴 취향과 CJK 가독성 중 하나를 포기해야 한다. */
  readonly cjkFallbackName: string;
  readonly family: string;
  readonly size: number;
}

import { fontResolves, quoteFontFamily, sanitizeFontFamilyName, withFontFallback } from "@fleet-console/font-picker/resolve";


export interface CuratedTerminalFont {
  readonly id: TerminalFontId;
  readonly name: string;
  readonly familyName: string;
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
  readonly cjkFallbackName?: unknown;
  readonly size?: unknown;
}

const SYMBOLS_NERD_FONT_MONO_FAMILY = "Symbols Nerd Font Mono";
/* 번들 CJK 폴백 — 큐레이트 4종도, ui-monospace/SF Mono/Menlo도 CJK 글리프가 없다. 이 서체가
   없으면 한글만 체인을 전부 빠져나가 OS 기본 폴백(비례폭 고딕)이 그리고, 같은 줄의 라틴과 굵기·
   폭이 어긋나 "폰트가 깨진" 것처럼 읽힌다. 번들인 이유는 이것뿐이 아니다: 통짜 CJK 웹폰트는 굵기당
   수 MB고, unicode-range로 쪼갠 서브셋은 첫 CJK 글자에 반응해 반드시 늦게 도착하는데 xterm의
   WebGL 글리프 아틀라스는 터미널 간 모듈 공유라 한 터미널이 비울 수 없어 폴백 글리프가 영구히
   구워진다. 그래서 선대기 가능한 한글 통짜 서브셋 하나만 싣고, 가나·한자는 사용자가 고른 설치
   서체(로드가 없어 아틀라스 경합도 없다)에 맡긴다. */
export const BUNDLED_CJK_FALLBACK_FAMILY = "Nanum Gothic Coding";
const BASE_MONO_FALLBACK_STACK = `ui-monospace, "SF Mono", Menlo, "${SYMBOLS_NERD_FONT_MONO_FAMILY}", monospace`;

/* 사용자가 고른 CJK 폴백이 번들 서체보다 앞에 서고, 번들 서체는 그 뒤에 남는다 — 지우지 않는
   이유는 커버리지가 스크립트마다 갈리기 때문이다. 가나·한자만 있고 한글이 없는 일본어 서체를
   골랐을 때 번들을 치우면 한글이 다시 OS 폴백으로 샌다. 선택 서체 바로 뒤에 두는 이유는 뒤쪽
   (ui-monospace 다음)에 두면 그 제네릭이 플랫폼마다 무엇으로 풀리는지에 CJK 렌더가 의존하기
   때문이다. */
export function terminalFontFallbackStack(cjkFallbackName: string): string {
  const chosen = sanitizeFontFamilyName(cjkFallbackName);
  const head = chosen && chosen !== BUNDLED_CJK_FALLBACK_FAMILY ? `${quoteFontFamily(chosen)}, ` : "";
  return `${head}${quoteFontFamily(BUNDLED_CJK_FALLBACK_FAMILY)}, ${BASE_MONO_FALLBACK_STACK}`;
}

export function curatedTerminalFontFamily(id: TerminalFontId | null, cjkFallbackName: string): string {
  return `${quoteFontFamily(curatedTerminalFontById(id).familyName)}, ${terminalFontFallbackStack(cjkFallbackName)}`;
}

export function defaultTerminalFontFamily(cjkFallbackName: string): string {
  return curatedTerminalFontFamily(DEFAULT_TERMINAL_FONT_ID, cjkFallbackName);
}

const DEFAULT_TERMINAL_FONT_SIZE = 14;
const MIN_TERMINAL_FONT_SIZE = 10;
const MAX_TERMINAL_FONT_SIZE = 22;

export const TERMINAL_FONT_SIZE_RANGE = {
  min: MIN_TERMINAL_FONT_SIZE,
  max: MAX_TERMINAL_FONT_SIZE,
};

export const DEFAULT_TERMINAL_FONT_ID: TerminalFontId = "cascadia";

export const CURATED_TERMINAL_FONTS: readonly CuratedTerminalFont[] = [
  { id: "cascadia", name: "Cascadia Code", familyName: "Cascadia Code Variable", meta: "Variable · terminal tuned" },
  { id: "jetbrains", name: "JetBrains Mono", familyName: "JetBrains Mono Variable", meta: "Variable · console mono" },
  { id: "fira-code", name: "Fira Code", familyName: "Fira Code Variable", meta: "Variable · ligatures" },
  { id: "source-code-pro", name: "Source Code Pro", familyName: "Source Code Pro Variable", meta: "Variable · Adobe mono" },
];

export const DEFAULT_TERMINAL_FONT = CURATED_TERMINAL_FONTS[0] as CuratedTerminalFont;

export function curatedTerminalFontById(id: TerminalFontId | null): CuratedTerminalFont {
  return CURATED_TERMINAL_FONTS.find((font) => font.id === id) ?? DEFAULT_TERMINAL_FONT;
}

export function createDefaultTerminalFontSettings(): TerminalFontSettings {
  return createCuratedTerminalFontSettings(DEFAULT_TERMINAL_FONT_ID, DEFAULT_TERMINAL_FONT_SIZE, "");
}

export function createCuratedTerminalFontSettings(id: TerminalFontId | null, size: number, cjkFallbackName = ""): TerminalFontSettings {
  const font = curatedTerminalFontById(id);
  const cjk = sanitizeCustomFontFamilyName(cjkFallbackName);
  return {
    source: "curated",
    id: font.id,
    customName: "",
    cjkFallbackName: cjk,
    family: curatedTerminalFontFamily(font.id, cjk),
    size: clampTerminalFontSize(size),
  };
}

export function createCustomTerminalFontSettings(customName: string, size: number, cjkFallbackName = ""): TerminalFontSettings {
  const sanitizedName = sanitizeCustomFontFamilyName(customName);
  const cjk = sanitizeCustomFontFamilyName(cjkFallbackName);
  return {
    source: "custom",
    id: null,
    customName: sanitizedName,
    cjkFallbackName: cjk,
    family: withFontFallback(sanitizedName, defaultTerminalFontFamily(cjk)),
    size: clampTerminalFontSize(size),
  };
}

export function createTerminalFontSettings(settings: TerminalFontSettings, cjkFallbackName: string): TerminalFontSettings {
  return settings.source === "custom"
    ? createCustomTerminalFontSettings(settings.customName, settings.size, cjkFallbackName)
    : createCuratedTerminalFontSettings(settings.id, settings.size, cjkFallbackName);
}

export function parseTerminalFontSettingsValue(value: unknown): TerminalFontSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const stored = value as StoredTerminalFontSettings;
  const size = clampTerminalFontSize(typeof stored.size === "number" ? stored.size : DEFAULT_TERMINAL_FONT_SIZE);
  // 필드가 없는 옛 저장본은 번들 폴백만 쓰던 상태 그대로 읽힌다 — 값 부재가 곧 기본값이라 판본이 필요없다.
  const cjk = typeof stored.cjkFallbackName === "string" ? stored.cjkFallbackName : "";
  if (stored.source === "custom" && typeof stored.customName === "string") {
    return createCustomTerminalFontSettings(stored.customName, size, cjk);
  }
  if (typeof stored.id === "string" && isTerminalFontId(stored.id)) {
    return createCuratedTerminalFontSettings(stored.id, size, cjk);
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
    cjkFallbackName: settings.cjkFallbackName,
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
  readonly chatReadingWidth: ChatReadingWidth;
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
let chatReadingWidthWriteEpoch = 0;
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
  chatReadingWidthWriteEpoch += 1;
  settingsCapability = settings;
  void hydrateTerminalSettingsFromServer();
}

export function getTerminalPrefsSnapshot(): TerminalPrefsState {
  return state;
}

export function useTerminalPrefs(): TerminalPrefsState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useChatReadingWidth(): ChatReadingWidth {
  return useSyncExternalStore(subscribe, () => state.chatReadingWidth, () => state.chatReadingWidth);
}

/* Chat은 터미널 뷰와 같은 Operation의 다른 얼굴이다 — 같은 세션을 CLI로 보다 Chat으로 넘어왔을 때
   서체가 갈리면 두 화면이 다른 앱으로 읽힌다. 그래서 Chat도 이 글꼴을 권위로 삼는다. family만
   구독하는 이유는 크기는 Chat이 자기 타입 스케일을 따로 지기 때문이다(터미널 셀 크기와 읽기
   본문 크기는 같은 축이 아니다). 문자열이라 스냅샷이 안정적이고, 하이드레이션으로 서버 값이
   늦게 도착해도 그 시점에 한 번만 다시 그린다. */
export function useTerminalFontFamily(): string {
  return useSyncExternalStore(subscribe, () => state.font.family, () => state.font.family);
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
  const font = createCuratedTerminalFontSettings(fontId, state.font.size, state.font.cjkFallbackName);
  fontWriteEpoch += 1;
  patchState({ font });
  void pushFontToServer(font);
}

export function setInstalledTerminalFont(familyName: string): void {
  // 설치 폰트도 legacy custom wire shape로 직렬화해 저장 포맷 호환성을 유지한다.
  const font = createCustomTerminalFontSettings(familyName, state.font.size, state.font.cjkFallbackName);
  fontWriteEpoch += 1;
  patchState({ font });
  void pushFontToServer(font);
}

// 빈 이름은 "번들 서체만"을 뜻한다 — 폴백 해제가 아니라 사용자 지정 항목만 체인에서 빠진다.
export function setTerminalCjkFallbackFont(familyName: string): void {
  const font = createTerminalFontSettings(state.font, familyName);
  fontWriteEpoch += 1;
  patchState({ font });
  void pushFontToServer(font);
}

export function setTerminalFontSize(size: number): void {
  const font = state.font.source === "custom"
    ? createCustomTerminalFontSettings(state.font.customName, size, state.font.cjkFallbackName)
    : createCuratedTerminalFontSettings(state.font.id, size, state.font.cjkFallbackName);
  fontWriteEpoch += 1;
  patchState({ font });
  void pushFontToServer(font);
}

export function setChatReadingWidth(width: ChatReadingWidth): void {
  chatReadingWidthWriteEpoch += 1;
  patchState({ chatReadingWidth: width });
  void pushChatReadingWidthToServer(width);
}

async function hydrateTerminalSettingsFromServer(): Promise<void> {
  if (!settingsCapability) return;
  const epoch = fontWriteEpoch;
  const widthEpoch = chatReadingWidthWriteEpoch;
  try {
    const value = await settingsCapability.read("terminal");
    if (value !== null) {
      // 읽기 폭은 서버 값이 전부다 — 새 선호라 폰트 같은 localStorage 시드 마이그레이션이 없다.
      const storedWidth = value["chatReadingWidth"];
      if (isChatReadingWidth(storedWidth) && widthEpoch === chatReadingWidthWriteEpoch) {
        patchState({ chatReadingWidth: storedWidth });
      }
    }
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
      font: { source: font.source, id: font.id, customName: font.customName, cjkFallbackName: font.cjkFallbackName, size: font.size },
    });
  } catch {
    // best-effort — write 실패 시 조용히 무시한다.
  }
}

async function pushChatReadingWidthToServer(width: ChatReadingWidth): Promise<void> {
  const settings = settingsCapability;
  if (!settings) return;
  try {
    await mergeTerminalSettingsRecord(settings, { chatReadingWidth: width });
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
    return { renderer: "webgl", inactiveFlush: DEFAULT_TERMINAL_INACTIVE_FLUSH, font: createDefaultTerminalFontSettings(), chatReadingWidth: DEFAULT_CHAT_READING_WIDTH };
  }
  migrateLegacyTerminalPrefs();
  return { renderer: readStoredRenderer(), inactiveFlush: readStoredInactiveFlush(), font: readStoredFont(), chatReadingWidth: DEFAULT_CHAT_READING_WIDTH };
}
