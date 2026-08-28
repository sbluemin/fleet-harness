/* 터미널 글꼴 체인이 스스로 싣는 폴백 서체들. 사용자가 고르는 서체(Cascadia·JetBrains·Fira·
   Source Code Pro·설치 서체)는 라틴만 책임지고, 그 서체가 갖지 못한 두 영역을 여기 두 서체가 진다:
   Nerd Font 심볼과 한글. 둘 다 open 전에 선대기하는 이유는 같다 — WebGL glyph atlas는 글리프를
   처음 그릴 때 래스터화하고 그 결과를 같은 설정의 터미널들이 모듈 레벨에서 공유하므로, 늦게 도착한
   서체 때문에 잘못 구워진 글리프를 한 터미널이 되돌릴 수 없다. */

const SYMBOLS_NERD_FONT_MONO_FAMILY = "Symbols Nerd Font Mono";
const KOREAN_MONO_FALLBACK_FAMILY = "Nanum Gothic Coding";

/* 한글 서브셋은 unicode-range가 없는 통짜 @font-face다. load()에 텍스트를 주지 않으면 브라우저가
   기본 텍스트(공백)만으로 매칭을 끝내 정작 한글 글리프를 받지 않는 판본이 있어, 대표 음절을
   명시해 실제 한글 커버리지를 끌어온다. */
const KOREAN_MONO_PROBE_TEXT = "한글";

const FALLBACK_FONT_LOAD_SPECS: readonly (readonly [spec: string, text?: string])[] = [
  [`1em "${SYMBOLS_NERD_FONT_MONO_FAMILY}"`],
  [`1em "${KOREAN_MONO_FALLBACK_FAMILY}"`, KOREAN_MONO_PROBE_TEXT],
  [`bold 1em "${KOREAN_MONO_FALLBACK_FAMILY}"`, KOREAN_MONO_PROBE_TEXT],
];

const TERMINAL_FALLBACK_FONT_LOAD_TIMEOUT_MS = 650;

let terminalFallbackFontLoad: Promise<void> | null = null;

export function preloadTerminalFallbackFonts(): Promise<void> {
  if (terminalFallbackFontLoad) return terminalFallbackFontLoad;
  terminalFallbackFontLoad = loadTerminalFallbackFonts();
  return terminalFallbackFontLoad;
}

export async function waitForTerminalFallbackFonts(): Promise<void> {
  await withTimeout(preloadTerminalFallbackFonts(), TERMINAL_FALLBACK_FONT_LOAD_TIMEOUT_MS);
}

async function loadTerminalFallbackFonts(): Promise<void> {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts?.load) return;
  await Promise.all(FALLBACK_FONT_LOAD_SPECS.map(async ([spec, text]) => {
    try {
      await (text === undefined ? fonts.load(spec) : fonts.load(spec, text));
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
