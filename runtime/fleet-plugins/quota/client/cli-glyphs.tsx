import type { ReactNode } from "react";
import { type LaunchProviderGlyphId, launchProviderGlyph } from "@fleet-console/sdk/components/launch-provider-glyphs";

// 마크 원본은 SDK가 단독으로 소유한다. 여기서 정하는 것은 quota 헤더가 쓰는 치수뿐이다 —
// `.quota-provider__mark`에는 svg 치수를 주는 CSS 규칙이 없어 속성으로 넘겨야 한다.
const HEADER_GLYPH_SIZE = { width: 16, height: 16 } as const;
// OpenCode 마크만 240×300 비율이라 폭을 좁혀 헤더의 좌우 여백을 나머지와 맞춘다.
const OPENCODE_GLYPH_SIZE = { width: 13, height: 16 } as const;

export function providerGlyph(provider: LaunchProviderGlyphId): ReactNode {
  return launchProviderGlyph(provider, provider === "opencode" ? OPENCODE_GLYPH_SIZE : HEADER_GLYPH_SIZE);
}
