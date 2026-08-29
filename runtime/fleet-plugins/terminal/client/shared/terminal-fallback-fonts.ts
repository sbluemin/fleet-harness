/* 터미널 글꼴 체인이 스스로 싣는 폴백 서체들. 사용자가 고르는 서체(Cascadia·JetBrains·Fira·
   Source Code Pro·설치 서체)는 라틴만 책임지고, 그 서체가 갖지 못한 두 영역을 여기 두 서체가 진다:
   Nerd Font 심볼과 한글. 둘 다 open 전에 선대기하는 이유는 같다 — WebGL glyph atlas는 글리프를
   처음 그릴 때 래스터화하고 그 결과를 같은 설정의 터미널들이 모듈 레벨에서 공유하므로, 늦게 도착한
   서체 때문에 잘못 구워진 글리프를 한 터미널이 되돌릴 수 없다. */

import { BUNDLED_CJK_FALLBACK_FAMILY } from "./terminal-preferences.js";

const SYMBOLS_NERD_FONT_MONO_FAMILY = "Symbols Nerd Font Mono";
const KOREAN_MONO_FALLBACK_FAMILY = BUNDLED_CJK_FALLBACK_FAMILY;

/* 한글 서브셋은 unicode-range가 없는 통짜 @font-face다. load()에 텍스트를 주지 않으면 브라우저가
   기본 텍스트(공백)만으로 매칭을 끝내 정작 한글 글리프를 받지 않는 판본이 있어, 대표 음절을
   명시해 실제 한글 커버리지를 끌어온다. */
const KOREAN_MONO_PROBE_TEXT = "한글";

interface FallbackFontLoadSpec {
  readonly spec: string;
  readonly text?: string;
  /** 커버리지 판정의 기준선이 되는 얼굴. 탐침이 보통 굵기로 그리므로 regular 하나만 해당한다. */
  readonly baseline?: boolean;
}

const FALLBACK_FONT_LOAD_SPECS: readonly FallbackFontLoadSpec[] = [
  { spec: `1em "${SYMBOLS_NERD_FONT_MONO_FAMILY}"` },
  { spec: `1em "${KOREAN_MONO_FALLBACK_FAMILY}"`, text: KOREAN_MONO_PROBE_TEXT, baseline: true },
  { spec: `bold 1em "${KOREAN_MONO_FALLBACK_FAMILY}"`, text: KOREAN_MONO_PROBE_TEXT },
];

const TERMINAL_FALLBACK_FONT_LOAD_TIMEOUT_MS = 650;

let terminalFallbackFontLoad: Promise<void> | null = null;
let cjkBaselineFaceLoaded = false;

export function preloadTerminalFallbackFonts(): Promise<void> {
  if (terminalFallbackFontLoad) return terminalFallbackFontLoad;
  terminalFallbackFontLoad = loadTerminalFallbackFonts();
  return terminalFallbackFontLoad;
}

export async function waitForTerminalFallbackFonts(): Promise<void> {
  await withTimeout(preloadTerminalFallbackFonts(), TERMINAL_FALLBACK_FONT_LOAD_TIMEOUT_MS);
}

/* 번들 CJK 서체가 실제로 도착했는지. 위의 대기는 터미널 부팅을 볼모로 잡지 않으려고 시간 상한을
   두므로, 상한이 먼저 끝나면 서체가 없는데도 resolve한다. 그래서 대기와 준비 여부는 별개의 질문이다.

   `FontFaceSet.check()`로는 이 질문에 답할 수 없다 — 이름이 세트에 아예 없으면 확인할 얼굴이 없어
   true를 낸다(실측 확인). 스타일 청크가 실려오지 못했거나 가족명이 어긋난 경우, 즉 기준선이 통째로
   사라진 바로 그 경우를 "준비됨"으로 읽는다. 반면 `load()`의 결과 배열에는 세트에 실제로 들어온
   얼굴만 담기므로, 비어 있지 않다는 것이 곧 이 얼굴이 왔다는 뜻이다. */
export function cjkFallbackBaselineReady(): boolean {
  return cjkBaselineFaceLoaded;
}

async function loadTerminalFallbackFonts(): Promise<void> {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts?.load) return;
  await Promise.all(FALLBACK_FONT_LOAD_SPECS.map(async ({ spec, text, baseline }) => {
    try {
      const faces = await (text === undefined ? fonts.load(spec) : fonts.load(spec, text));
      if (baseline && faces.length > 0) cjkBaselineFaceLoaded = true;
    } catch {
      // 폰트 로드 실패는 터미널 부팅을 막지 않는다. CSS fallback 체인으로 계속 진행한다.
    }
  }));
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(resolveOnce, timeoutMs);
    promise.then(resolveOnce, resolveOnce);

    function resolveOnce(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }
  });
}
