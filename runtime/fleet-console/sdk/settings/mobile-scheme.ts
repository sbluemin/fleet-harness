import type { ConsoleTheme } from "../plugin/types.js";

/**
 * 모바일 팔레트의 공개 신호 — 루트(`<html>`) 속성 두 개다.
 *
 * - `data-view-mode="mobile"`: 모바일 배치 전체(Fleet Mobile 앱, 좁은 창, 명시 선호).
 * - `data-mobile-scheme="dark" | "light"`: 모바일 전용 색상 모드가 정한 극성.
 *
 * 두 속성이 함께 설 때만 theme.css의 모바일 블록이 매치되고, 그동안 루트 토큰은 Console 테마가
 * 아니라 모바일 팔레트(`--m-*`)를 가리킨다. Console 테마 id(`ctx.theme`)는 그대로 데스크톱 설정
 * 값이므로, 극성이나 테마 id로 분기하는 소비자는 이 신호를 함께 봐야 밝은 바탕에 다크용 색을
 * 깔지 않는다. 값은 호스트가 쓰고, 소비자는 읽기만 한다.
 */
export type MobileScheme = "dark" | "light";

export const MOBILE_SCHEME_ATTRIBUTES = ["data-view-mode", "data-mobile-scheme"] as const;

/** 모바일 팔레트가 지금 서 있으면 그 극성, 아니면 null(데스크톱 팔레트). */
export function readMobileScheme(root: Element | null = typeof document === "undefined" ? null : document.documentElement): MobileScheme | null {
  if (!root || root.getAttribute("data-view-mode") !== "mobile") return null;
  const scheme = root.getAttribute("data-mobile-scheme");
  return scheme === "dark" || scheme === "light" ? scheme : null;
}

/** 모바일 팔레트가 켜지거나 꺼지거나 극성이 바뀔 때 부른다. 반환값으로 구독을 끊는다. */
export function subscribeMobileScheme(listener: (scheme: MobileScheme | null) => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const root = document.documentElement;
  let previous = readMobileScheme(root);
  const observer = new MutationObserver(() => {
    const next = readMobileScheme(root);
    if (next === previous) return;
    previous = next;
    listener(next);
  });
  observer.observe(root, { attributes: true, attributeFilter: [...MOBILE_SCHEME_ATTRIBUTES] });
  return () => observer.disconnect();
}

/**
 * 테마 id로 극성을 고르는 소비자(서버가 검증하는 아티팩트 테마 등)에 넘길, 모바일 극성과 맞춘
 * Console 테마 id. 모바일 팔레트가 없으면 받은 id를 그대로 돌려준다. 색 자체는 루트 토큰에서
 * 읽어야 한다 — 이 id는 극성(color-scheme·대비 하한)만 맞추는 용도다.
 */
export function mobilePolarityTheme(theme: ConsoleTheme, scheme: MobileScheme | null = readMobileScheme()): ConsoleTheme {
  if (scheme === null) return theme;
  if (scheme === "light") return "whites";
  return theme === "whites" ? "carbon" : theme;
}
