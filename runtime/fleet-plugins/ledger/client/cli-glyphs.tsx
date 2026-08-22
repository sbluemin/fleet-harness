import type { ReactNode } from "react";
import { isLaunchProviderGlyphId, launchProviderGlyph } from "@fleet-console/sdk/components/launch-provider-glyphs";

// 마크 원본은 SDK가 단독으로 소유한다. 여기서 정하는 것은 ledger 행이 쓰는 치수뿐이다 —
// `.ledger-client-mark`에는 svg 치수를 주는 CSS 규칙이 없어 속성으로 넘겨야 한다.
const ROW_GLYPH_SIZE = { width: 16, height: 16 } as const;

/** 지출 행의 공급자는 상류 집계가 주는 자유 문자열이다. 모르는 값을 특정 공급자 로고로
 *  그리면 남의 지출로 읽히므로, 판별되지 않는 값은 중립 셸 마크로 떨어뜨린다. */
function DefaultGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M3 4.25 6.5 8 3 11.75M8 12h5" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function providerGlyph(provider: string): ReactNode {
  // 상류가 Claude를 `anthropic`으로도 보고한다.
  const id = provider === "anthropic" ? "claude" : provider;
  return isLaunchProviderGlyphId(id) ? launchProviderGlyph(id, ROW_GLYPH_SIZE) : <DefaultGlyph />;
}
