export type FontAxis = "ui" | "content" | "code";
export type FontSelection =
  | { readonly source: "builtin"; readonly id: "manrope" | "jetbrains-mono" | "source-code-pro" | "cascadia" | "fira-code" }
  | { readonly source: "system"; readonly familyName: string }
  | { readonly source: "inherit" };

export interface FontAxisSettings {
  readonly font: FontSelection;
  readonly size: number;
  /** 빈 값은 축에 번들된 한글 서체를 따른다. */
  readonly cjk: string;
}
export interface TerminalFontOverride {
  readonly font: FontSelection;
  readonly size: number;
  /** 미출시 첫 모델의 복사 값만 보존한다. 터미널 한글은 항상 code.cjk를 읽는다. 새 쓰기는 이 필드를 만들지 않는다. */
  readonly cjk?: string;
}
export interface ConsoleFontSettings {
  readonly ui: FontAxisSettings;
  readonly content: FontAxisSettings;
  readonly code: FontAxisSettings;
  /** null이면 터미널도 코드 축을 그대로 따른다. */
  readonly terminal: TerminalFontOverride | null;
}

export const FONT_SIZE_RANGES = {
  ui: { min: 12, max: 18, defaultValue: 14 },
  content: { min: 12, max: 20, defaultValue: 14 },
  code: { min: 10, max: 22, defaultValue: 13 },
} as const;
export const FONT_BUILT_INS = {
  manrope: { label: "Fleet UI", family: '"Manrope Variable", "Manrope"' },
  "jetbrains-mono": { label: "JetBrains Mono", family: '"JetBrains Mono Variable", "JetBrains Mono"' },
  "source-code-pro": { label: "Source Code Pro", family: '"Source Code Pro Variable", "Source Code Pro"' },
  cascadia: { label: "Cascadia Code", family: '"Cascadia Code Variable", "Cascadia Code"' },
  "fira-code": { label: "Fira Code", family: '"Fira Code Variable", "Fira Code"' },
} as const;
export const DEFAULT_FONTS: ConsoleFontSettings = {
  ui: { font: { source: "builtin", id: "manrope" }, size: 14, cjk: "" },
  content: { font: { source: "inherit" }, size: 14, cjk: "" },
  code: { font: { source: "builtin", id: "jetbrains-mono" }, size: 13, cjk: "" },
  terminal: null,
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function sanitizeFontName(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128) : "";
}
function readSelection(value: unknown, inherit: boolean): FontSelection | null {
  if (!record(value)) return null;
  if (value.source === "inherit" && inherit) return { source: "inherit" };
  if (value.source === "builtin" && typeof value.id === "string" && Object.hasOwn(FONT_BUILT_INS, value.id)) {
    return { source: "builtin", id: value.id as keyof typeof FONT_BUILT_INS };
  }
  if (value.source === "system" && typeof value.familyName === "string" && value.familyName && value.familyName === sanitizeFontName(value.familyName)) {
    return { source: "system", familyName: value.familyName };
  }
  return null;
}
function readAxis(value: unknown, axis: FontAxis): FontAxisSettings | null {
  if (!record(value)) return null;
  const font = readSelection(value.font, axis === "content");
  const range = FONT_SIZE_RANGES[axis];
  if (!font || typeof value.size !== "number" || !Number.isInteger(value.size) || value.size < range.min || value.size > range.max
    || typeof value.cjk !== "string" || value.cjk !== sanitizeFontName(value.cjk)) return null;
  return { font, size: value.size, cjk: value.cjk };
}
export function readFontSettings(value: unknown): ConsoleFontSettings | null {
  if (!record(value)) return null;
  const ui = readAxis(value.ui, "ui");
  const content = readAxis(value.content, "content");
  const code = readAxis(value.code, "code");
  let terminal: TerminalFontOverride | null = null;
  if (record(value.terminal)) {
    const axis = readAxis({ ...value.terminal, cjk: value.terminal.cjk ?? "" }, "code");
    if (axis) terminal = { font: axis.font, size: axis.size, ...(typeof value.terminal.cjk === "string" ? { cjk: axis.cjk } : {}) };
  }
  return ui && content && code && (value.terminal === null || terminal) ? { ui, content, code, terminal } : null;
}

/** 옛 값은 이 함수가 읽기만 한다. 저장소의 원본을 수정하거나 지우지 않는다. */
export function migrateFontSettings(uiValue: unknown, terminalValue: unknown): ConsoleFontSettings {
  let ui = DEFAULT_FONTS.ui;
  if (record(uiValue)) {
    const selected = readSelection(uiValue, false);
    const size = typeof uiValue.size === "number" && uiValue.size >= 12 && uiValue.size <= 18 ? uiValue.size : 14;
    if (selected) ui = { font: selected, size, cjk: "" };
  } else if (typeof uiValue === "string" && Object.hasOwn(FONT_BUILT_INS, uiValue)) {
    ui = { ...ui, font: { source: "builtin", id: uiValue as keyof typeof FONT_BUILT_INS } };
  }
  return { ui, content: { ...DEFAULT_FONTS.content, size: ui.size }, code: migrateTerminalFont(terminalValue) ?? DEFAULT_FONTS.code, terminal: null };
}
export function migrateTerminalFont(value: unknown): FontAxisSettings | null {
  if (!record(value)) return null;
  const id = value.id === "jetbrains" ? "jetbrains-mono" : value.id;
  const customName = sanitizeFontName(value.customName);
  const font: FontSelection | null = value.source === "custom"
    ? customName ? { source: "system", familyName: customName } : { source: "builtin", id: "cascadia" }
    : typeof id === "string" && Object.hasOwn(FONT_BUILT_INS, id) ? { source: "builtin", id: id as keyof typeof FONT_BUILT_INS } : null;
  if (!font) return null;
  const size = typeof value.size === "number" && Number.isFinite(value.size) ? Math.max(10, Math.min(22, Math.round(value.size))) : 14;
  return { font, size, cjk: sanitizeFontName(value.cjkFallbackName) };
}

function quotedFontName(value: string): string {
  const safe = sanitizeFontName(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/</g, "\\3c ").replace(/>/g, "\\3e ");
  return `"${safe}"`;
}

export function fontFamilyForAxis(fonts: ConsoleFontSettings, axis: FontAxis, terminal = false): string {
  const settings = terminal ? fonts.terminal ?? fonts.code : fonts[axis];
  const selection = settings.font.source === "inherit" ? fonts.ui.font : settings.font;
  const primary = selection.source === "builtin" ? FONT_BUILT_INS[selection.id].family
    : selection.source === "system" ? `${quotedFontName(selection.familyName)}, ${axis === "code" ? FONT_BUILT_INS["jetbrains-mono"].family : FONT_BUILT_INS.manrope.family}` : FONT_BUILT_INS.manrope.family;
  const cjk = (terminal ? fonts.code.cjk : settings.cjk) || (axis === "content" && settings.font.source === "inherit" ? fonts.ui.cjk : "");
  const chosen = cjk ? `${quotedFontName(cjk)}, ` : "";
  // Nerd는 코드 축의 마지막 글리프 폴백이다. 선택한 주 서체가 해당 글리프를 갖고 있으면 먼저 그린다.
  return `${primary}, ${chosen}${axis === "code" ? '"Nanum Gothic Coding", "Symbols Nerd Font Mono", ui-monospace, "SF Mono", Menlo, monospace' : '"Pretendard Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'}`;
}
