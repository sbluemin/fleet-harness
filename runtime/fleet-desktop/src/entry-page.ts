import { readDesktopEntryFonts, type DesktopEntryFonts } from "@fleet-console/protocol/desktop";
import type { WebContents } from "electron";
import { readDesktopBrandTarget, type DesktopBrandTarget } from "@fleet-console/protocol/desktop/brand";

/**
 * 진입 화면은 한 줄 상태만 말한다. busy는 진행 중, done은 넘겨줄 준비, warning은 멈추지 않고
 * 이어 가는 경고, failed는 첫 설치 실패처럼 여기서 멈춘 상태다.
 */
export type EntryTone = "busy" | "done" | "warning" | "failed";

/**
 * 종료 인사 — 넘겨주기의 역재생. veiled는 투명한 판 위에서 마크가 Console의 실측 브랜드 자리에 앉은
 * 모습(전환 없이 곧바로), shown은 바탕이 차오르며 마크와 워드마크가 가운데로 돌아온 모습이다.
 */
export type EntryFarewell = "veiled" | "shown";

/**
 * 사용자가 Console에서 고른 테마의 색. Console이 테마 스냅샷에 실어 보내고(desktop-theme-sync),
 * 진입 화면과 종료 인사는 이 값으로 기본 판(entry.css의 다크)을 덮는다. 모르면 기본 판 그대로다.
 */
export interface EntryPalette {
  readonly scheme: "dark" | "light";
  /** 창과 Console 뷰의 네이티브 바탕. Electron이 읽을 수 있는 #rrggbb. */
  readonly canvas: string;
  readonly tokens: Readonly<Record<EntryPaletteToken, string>>;
  readonly fonts?: DesktopEntryFonts;
}

export const ENTRY_PALETTE_TOKENS = [
  "ink-abyss", "ink-deep", "ink-veil", "ink-rim", "ink-fog", "ink-muted", "ink-spectral", "ink-pearl",
  "brass", "aurora", "positive", "coral", "hairline", "hairline-strong",
] as const;

export type EntryPaletteToken = (typeof ENTRY_PALETTE_TOKENS)[number];

const PALETTE_CANVAS = /^#[\da-f]{6}$/i;
// 렌더러의 CSS 변수로 그대로 들어가는 값이다 — 색 하나 외의 어떤 문법도 통과시키지 않는다.
const PALETTE_COLOR = /^(?:#[\da-f]{6}|oklch\(\d{1,3}(?:\.\d{1,4})?% \d(?:\.\d{1,4})? \d{1,3}(?:\.\d{1,4})?\))$/i;

/**
 * 밖에서 온 팔레트(Console 스냅샷, 지난 실행의 기억)를 받아들일 모양으로 거른다. 아는 토큰이 하나라도
 * 빠지거나 형식이 어긋나면 통째로 버린다 — 절반만 바뀐 판보다 기본 판이 낫다. 모르는 토큰은 무시한다.
 */
export function readEntryPalette(value: unknown): EntryPalette | null {
  if (!isRecord(value) || (value.scheme !== "dark" && value.scheme !== "light")) return null;
  if (typeof value.canvas !== "string" || !PALETTE_CANVAS.test(value.canvas) || !isRecord(value.tokens)) return null;
  const tokens: Partial<Record<EntryPaletteToken, string>> = {};
  for (const token of ENTRY_PALETTE_TOKENS) {
    const color = value.tokens[token];
    if (typeof color !== "string" || !PALETTE_COLOR.test(color)) return null;
    tokens[token] = color;
  }
  const fonts = readDesktopEntryFonts(value.fonts);
  return { scheme: value.scheme, canvas: value.canvas, tokens: tokens as Record<EntryPaletteToken, string>, ...(fonts ? { fonts } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 넘겨주기·종료 인사의 도착 자리를 Console 배율에 맞추는 두 배율. page는 진입 화면 문서 자신의 배율, console은
 * 넘겨받을(또는 떠나는) Console 문서의 배율이다. 맨 위 줄·글리프·간격은 Console CSS px라 console/page 비로 키우고,
 * macOS 신호등 예약(76 DIP)은 네이티브라 page 배율로만 나눈다. 모르면 둘 다 1로 본다(PR #1901의 배율 1 좌표).
 */
export interface EntryZoom {
  readonly page: number;
  readonly console: number;
}

export interface EntryPageSnapshot {
  readonly platform: string;
  readonly lang: "ko" | "en";
  readonly dev: boolean;
  readonly tagline: string;
  readonly tone: EntryTone;
  readonly title: string;
  readonly detail?: string;
  /** 0–100이면 채운 막대, "indeterminate"면 흐르는 막대, 없으면 막대를 숨긴다. */
  readonly progress?: number | "indeterminate";
  /** "Desktop 0.13.4 · Console 1.107.0" — 아는 버전만 담는다. */
  readonly versions: string;
  /** true면 마크와 워드마크가 실측 닻(없으면 옛 상단 자리)으로 줄어들고 나머지는 사라진다. */
  readonly handoff?: boolean;
  readonly farewell?: EntryFarewell;
  readonly palette?: EntryPalette;
  readonly zoom?: EntryZoom;
  /** 공개 Console 닻의 실측 CSS px. 진입 렌더러에서 console/page 배율로 바꾼다. */
  readonly brandTarget?: DesktopBrandTarget;
}

export interface EntryPageWebContents {
  executeJavaScript(code: string): Promise<unknown>;
}

// 진입 HTML은 CSP로 스크립트를 막는다. 이 렌더러는 main이 executeJavaScript로 들여보내는 유일한
// 코드이며, 스냅샷의 글자는 textContent로만 들어간다 — 마크업으로 해석되는 경로를 두지 않는다.
const ENTRY_RENDERER = String.raw`(() => {
  const snapshot = __ENTRY_SNAPSHOT__;
  const root = document.documentElement;
  const byId = (id) => document.getElementById(id);
  const tagline = byId("tagline");
  const title = byId("status-title");
  const detail = byId("detail");
  const bar = byId("bar");
  const fill = byId("bar-fill");
  const versions = byId("versions");
  const devTag = byId("dev-tag");
  if (!tagline || !title || !detail || !bar || !fill || !versions || !devTag) return;
  root.setAttribute("lang", snapshot.lang);
  root.setAttribute("data-platform", snapshot.platform);
  root.setAttribute("data-tone", snapshot.tone);
  // 팔레트가 없으면 기본 판으로 돌아간다 — 앞서 칠한 테마를 남겨 두면 창 바탕·종료 인사와 어긋난다.
  root.removeAttribute("style");
  root.removeAttribute("data-scheme");
  if (snapshot.palette) {
    // CSP가 style 속성은 막아도 CSSOM은 허용한다. 키와 값은 main이 readEntryPalette로 거른 것뿐이다.
    root.setAttribute("data-scheme", snapshot.palette.scheme);
    for (const [token, color] of Object.entries(snapshot.palette.tokens)) root.style.setProperty("--" + token, color);
    if (snapshot.palette.fonts) for (const [axis, font] of Object.entries(snapshot.palette.fonts)) {
      root.style.setProperty("--font-" + axis, font.family);
      root.style.setProperty("--font-" + axis + "-size", font.size + "px");
    }
  }
  // 배율도 앞의 style 초기화로 함께 걷힌다 — 모르면 entry.css 기본값(1)이 PR #1901의 배율 1 좌표를 그린다.
  if (snapshot.zoom) {
    root.style.setProperty("--entry-page-zoom", String(snapshot.zoom.page));
    root.style.setProperty("--handoff-scale", String(snapshot.zoom.console / snapshot.zoom.page));
  }
  root.classList.toggle("has-brand-target", !!snapshot.brandTarget);
  root.classList.toggle("has-mark-only-target", !!snapshot.brandTarget && !snapshot.brandTarget.wordmark);
  if (snapshot.brandTarget) {
    const factor = snapshot.zoom ? snapshot.zoom.console / snapshot.zoom.page : 1;
    for (const [name, box] of [["mark", snapshot.brandTarget.mark], ["word", snapshot.brandTarget.wordmark]]) {
      if (!box) continue;
      for (const key of ["left", "top", "width", "height"]) root.style.setProperty("--target-" + name + "-" + key, box[key] * factor + "px");
      if (name === "word") root.style.setProperty("--target-word-font-size", box.fontSize * factor + "px");
    }
  }
  tagline.textContent = snapshot.tagline;
  title.textContent = snapshot.title;
  detail.textContent = snapshot.detail || "";
  versions.textContent = snapshot.versions;
  devTag.classList.toggle("is-visible", snapshot.dev);
  root.classList.toggle("is-dev", snapshot.dev);
  const progress = snapshot.progress;
  bar.classList.toggle("is-visible", progress !== undefined);
  bar.classList.toggle("is-indeterminate", progress === "indeterminate");
  fill.setAttribute("style", typeof progress === "number" ? "width: " + progress + "%" : "");
  if (snapshot.handoff) root.classList.add("is-handoff");
  if (snapshot.farewell === "veiled") {
    // 전환을 끈 채 상단 자리로 옮기고 스타일을 한 번 확정한 뒤에야 전환을 되살린다.
    root.classList.add("is-instant", "is-handoff", "is-veiled", "is-farewell");
    void root.offsetWidth;
    root.classList.remove("is-instant");
  }
  if (snapshot.farewell === "shown") root.classList.remove("is-handoff", "is-veiled");
})();`;

export async function pushEntrySnapshot(contents: EntryPageWebContents | WebContents, snapshot: EntryPageSnapshot): Promise<void> {
  await contents.executeJavaScript(createEntrySnapshotScript(snapshot));
}

export function createEntrySnapshotScript(snapshot: EntryPageSnapshot): string {
  return ENTRY_RENDERER.replace("__ENTRY_SNAPSHOT__", serializeSnapshot(normalizeEntrySnapshot(snapshot)));
}

export function normalizeEntrySnapshot(snapshot: EntryPageSnapshot): EntryPageSnapshot {
  const { palette, zoom, brandTarget, ...rest } = snapshot;
  const accepted = palette === undefined ? null : readEntryPalette(palette);
  const scaled = zoom !== undefined && isZoomFactor(zoom.page) && isZoomFactor(zoom.console) ? { zoom: { page: zoom.page, console: zoom.console } } : {};
  const target = readDesktopBrandTarget(brandTarget);
  const normalized: EntryPageSnapshot = { ...rest, ...(accepted ? { palette: accepted } : {}), ...scaled, ...(target ? { brandTarget: target } : {}) };
  return typeof normalized.progress === "number" ? { ...normalized, progress: clampProgress(normalized.progress) } : normalized;
}

// 렌더러의 CSS 변수로 들어가는 값이다 — 0.1–10 사이의 유한한 배율만 받는다. 그 밖이면 배율 1 좌표로 물러난다.
function isZoomFactor(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.1 && value <= 10;
}

export function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, progress));
}

function serializeSnapshot(snapshot: EntryPageSnapshot): string {
  return JSON.stringify(snapshot).replace(/[<>&\u2028\u2029]/g, (character) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" })[character] ?? character);
}
