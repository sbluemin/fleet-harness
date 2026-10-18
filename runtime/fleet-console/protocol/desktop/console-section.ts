/** Optional, renderer-only sidebar protocol. No saved console data crosses into the active Console. */
export const CONSOLE_SECTION_CAPABILITY = "console-section-v1";
export const CONSOLE_SECTION_SURFACE = "console-section";
export const CONSOLE_SECTION_SIGNAL = "console-section-signal";
export const CONSOLE_SECTION_EVENT = "fleet:console-section";
export const CONSOLE_SECTION_CONTEXT_EVENT = "fleet:console-section-context";
export const CONSOLE_SECTION_FOCUS_EVENT = "fleet:console-section-focus";
export const CONSOLE_SECTION_REFRESH_EVENT = "fleet:console-section-refresh";

export interface ConsoleSectionGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly available: number;
  readonly compact: boolean;
  readonly visible: boolean;
  readonly theme: string;
}

/** Home-only context. This object must never be sent to the active/remote Console. */
export interface ConsoleSectionContext {
  readonly at: string;
  readonly compact: boolean;
  readonly maxHeight: number;
  readonly theme: string;
  /** 상주 뷰의 CSS 좌표를 전체 Console 뷰포트 좌표로 옮기는 기준. 집 문서에만 전달한다. */
  readonly frame?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export function isConsoleSectionGeometry(value: unknown): value is ConsoleSectionGeometry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return [v.x, v.y, v.width, v.available].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100_000)
    && typeof v.compact === "boolean" && typeof v.visible === "boolean"
    && typeof v.theme === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v.theme);
}

/** Navigation is intercepted before any request leaves the renderer. Only capable shells receive it. */
export function consoleSectionSignalUrl(origin: string, value: unknown): string {
  const url = new URL("/console/", origin);
  url.searchParams.set("desktop-surface", CONSOLE_SECTION_SIGNAL);
  url.searchParams.set("signal", JSON.stringify(value));
  return url.toString();
}
