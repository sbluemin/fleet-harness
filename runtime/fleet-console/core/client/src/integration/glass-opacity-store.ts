import { useSyncExternalStore } from "react";

/* ── 유리 불투명도 네 묶음 ─────────────────────────────────────────────
   리퀴드 글래스는 끄는 스위치가 없고, 사람은 묶음별 틴트 불투명도로 재질을 고른다. 수치는
   실제 틴트 알파(%)다 — 100은 완전 불투명, 하한 20은 판독이 무너지기 전의 선이다.
   메뉴·팝업·팔레트는 묶음에 들지 않는다(고정 재질).

   값은 브라우저-로컬(localStorage)이고 **문서 루트**에 `--glass-<group>-alpha`로 실린다.
   theme.css의 유리 재료(`--glass-on-tint-*`)가 :root에서 이 변수를 알파 자리에 치환하므로,
   다른 요소에 실으면 이미 폴백이 박힌 값만 상속된다. 사람이 한 번도 만지지 않은 묶음은
   변수를 싣지 않는다 — 재료의 폴백이 테마별 현행 알파라 기본 화면이 정확히 오늘 그대로다.
   아래 표는 그 폴백을 테마별로 옮겨 적은 것이다(theme.css의 `var(--glass-<group>-alpha, N%)`와
   수동 동기화). 슬라이더의 표시·기본·초기화 값이 이 표를 읽어야 첫 조작에서 화면이 튀지 않는다.

   키는 public/theme-boot.js의 퇴역 스위치 이관(꺼 둔 사람 → 100%)과 수동 동기화한다. */
export type GlassGroup = "window" | "bar" | "side-bar" | "rail";

export const GLASS_OPACITY_MIN = 20;
export const GLASS_OPACITY_MAX = 100;
const INSTRUMENT_DEFAULTS: Readonly<Record<GlassGroup, number>> = { window: 60, bar: 55, "side-bar": 50, rail: 54 };
const DEEP_DEFAULTS: Readonly<Record<GlassGroup, number>> = { window: 60, bar: 50, "side-bar": 45, rail: 50 };
const THEME_DEFAULTS: Readonly<Record<string, Readonly<Record<GlassGroup, number>>>> = {
  maritime: DEEP_DEFAULTS,
  carbon: DEEP_DEFAULTS,
};

function currentTheme(): string {
  return typeof document === "undefined" ? "" : document.documentElement.getAttribute("data-theme") ?? "";
}

/** 테마가 폴백으로 쓰는 현행 알파 — 모르는 테마(라이트 포함)는 기본 테마 값이다. */
export function glassOpacityDefault(group: GlassGroup, theme: string = currentTheme()): number {
  return (THEME_DEFAULTS[theme] ?? INSTRUMENT_DEFAULTS)[group];
}

const GROUPS: readonly GlassGroup[] = ["window", "bar", "side-bar", "rail"];
/* 구 척도(재질 한 겹 전체의 opacity, 100 = 현행 재질)로 저장된 두 값. 새 키가 없을 때만
   「기본값 × 저장값」으로 한 번 옮기고 지운다. */
const LEGACY_KEYS: Partial<Record<GlassGroup, string>> = {
  "side-bar": "fleet-console.operations.side-glass-alpha",
  rail: "fleet-console.rail.overlayAlpha",
};

type GlassOpacity = Readonly<Record<GlassGroup, number | null>>;

const listeners = new Set<() => void>();
let opacity: GlassOpacity = readAll();

function storageKey(group: GlassGroup): string {
  return `fleet-console.glass.${group}-opacity`;
}

function clampOpacity(value: number): number {
  return Math.min(GLASS_OPACITY_MAX, Math.max(GLASS_OPACITY_MIN, Math.round(value)));
}

function readAll(): GlassOpacity {
  const next: Record<GlassGroup, number | null> = { window: null, bar: null, "side-bar": null, rail: null };
  for (const group of GROUPS) next[group] = readStored(group);
  return next;
}

function readStored(group: GlassGroup): number | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = localStorage.getItem(storageKey(group));
    if (raw !== null && raw.trim() !== "" && Number.isFinite(Number(raw))) return clampOpacity(Number(raw));
    const legacyKey = LEGACY_KEYS[group];
    const legacy = legacyKey ? localStorage.getItem(legacyKey) : null;
    if (legacyKey === undefined || legacy === null) return null;
    localStorage.removeItem(legacyKey);
    const parsed = Number(legacy);
    if (legacy.trim() === "" || !Number.isFinite(parsed)) return null;
    const converted = clampOpacity((glassOpacityDefault(group) * parsed) / 100);
    localStorage.setItem(storageKey(group), String(converted));
    return converted;
  } catch {
    return null;
  }
}

function apply(group: GlassGroup, value: number | null): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  if (value === null) style.removeProperty(`--glass-${group}-alpha`);
  else style.setProperty(`--glass-${group}-alpha`, `${value}%`);
}

/** 부팅이 저장된 취향을 첫 페인트 앞에서 한 번 싣는다 — 재료의 폴백이 곧 기본값이라 미호출도 안전하다. */
export function applyStoredGlassOpacity(): void {
  for (const group of GROUPS) apply(group, opacity[group]);
}

export function setGlassOpacity(group: GlassGroup, value: number): void {
  const clamped = clampOpacity(value);
  if (opacity[group] === clamped) return;
  opacity = { ...opacity, [group]: clamped };
  try {
    localStorage.setItem(storageKey(group), String(clamped));
  } catch {
    // 저장소 접근 불가 환경에서는 이번 문서에만 적용한다.
  }
  apply(group, clamped);
  for (const listener of listeners) listener();
}

/** 초기화 — 저장값과 루트 변수를 걷어 테마별 CSS 폴백으로 돌아간다(수치를 박으면 테마를 바꿔도 고정된다). */
export function resetGlassOpacity(group: GlassGroup): void {
  if (opacity[group] === null) return;
  opacity = { ...opacity, [group]: null };
  try {
    localStorage.removeItem(storageKey(group));
  } catch {
    // 저장소 접근 불가 환경에서는 이번 문서에만 적용한다.
  }
  apply(group, null);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function subscribeTheme(listener: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** 슬라이더가 보여 줄 값과 초기화 값 — 만지지 않은 묶음은 지금 테마의 현행 알파다. */
export function useGlassOpacity(group: GlassGroup): { readonly value: number; readonly defaultValue: number } {
  const stored = useSyncExternalStore(subscribe, () => opacity[group], () => opacity[group]);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, currentTheme);
  const defaultValue = glassOpacityDefault(group, theme);
  return { value: stored ?? defaultValue, defaultValue };
}
