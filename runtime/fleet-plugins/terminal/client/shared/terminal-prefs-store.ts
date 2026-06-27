import { useSyncExternalStore } from "react";

import { createCuratedTerminalFontSettings, createCustomTerminalFontSettings, createDefaultTerminalFontSettings, parseStoredTerminalFontSettings, serializeTerminalFontSettings } from "./terminal-font.js";
import type { TerminalFontId, TerminalFontSettings, TerminalRenderer } from "./types.js";

interface TerminalPrefsState {
  readonly renderer: TerminalRenderer;
  readonly font: TerminalFontSettings;
}

const RENDERER_KEY = "fleet-plugin.terminal.renderer";
const FONT_KEY = "fleet-plugin.terminal.font";
const LEGACY_RENDERER_KEY = "fleet-console.terminalRenderer";
const LEGACY_FONT_KEY = "fleet-console.terminalFont";

type Listener = () => void;

const listeners = new Set<Listener>();

let state: TerminalPrefsState = initState();

function initState(): TerminalPrefsState {
  if (typeof window === "undefined") {
    return { renderer: "webgl", font: createDefaultTerminalFontSettings() };
  }
  migrateLegacyTerminalPrefs();
  return { renderer: readStoredRenderer(), font: readStoredFont() };
}

export function migrateLegacyTerminalPrefs(): void {
  if (typeof window === "undefined") return;
  try {
    // 새 키가 이미 존재하면 no-op(idempotent).
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

function writeStoredFont(font: TerminalFontSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FONT_KEY, serializeTerminalFontSettings(font));
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
  writeStoredFont(font);
  patchState({ font });
}

export function setCustomTerminalFont(customName: string): void {
  const font = createCustomTerminalFontSettings(customName, state.font.size);
  writeStoredFont(font);
  patchState({ font });
}

export function setTerminalFontSize(size: number): void {
  const font = state.font.source === "custom"
    ? createCustomTerminalFontSettings(state.font.customName, size)
    : createCuratedTerminalFontSettings(state.font.id, size);
  writeStoredFont(font);
  patchState({ font });
}
