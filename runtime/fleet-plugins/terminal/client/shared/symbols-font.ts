const SYMBOLS_NERD_FONT_MONO_FAMILY = "Symbols Nerd Font Mono";
const SYMBOLS_NERD_FONT_MONO_LOAD_SPEC = `1em "${SYMBOLS_NERD_FONT_MONO_FAMILY}"`;
const SYMBOLS_NERD_FONT_MONO_LOAD_TIMEOUT_MS = 650;

let symbolsNerdFontMonoLoad: Promise<void> | null = null;

export function preloadSymbolsNerdFontMono(): Promise<void> {
  if (symbolsNerdFontMonoLoad) return symbolsNerdFontMonoLoad;
  symbolsNerdFontMonoLoad = loadSymbolsNerdFontMono();
  return symbolsNerdFontMonoLoad;
}

export async function waitForSymbolsNerdFontMono(): Promise<void> {
  await withTimeout(preloadSymbolsNerdFontMono(), SYMBOLS_NERD_FONT_MONO_LOAD_TIMEOUT_MS);
}

async function loadSymbolsNerdFontMono(): Promise<void> {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts?.load) return;
  try {
    await fonts.load(SYMBOLS_NERD_FONT_MONO_LOAD_SPEC);
  } catch {
    // 폰트 로드 실패는 터미널 부팅을 막지 않는다. CSS fallback 체인으로 계속 진행한다.
  }
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
