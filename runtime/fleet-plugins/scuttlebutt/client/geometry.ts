export interface Size {
  readonly width: number;
  readonly height: number;
}

export type CardPlacement =
  | { readonly side: "above"; readonly left: number; readonly bottom: number; readonly maxHeight: number }
  | { readonly side: "below" | "beside"; readonly left: number; readonly top: number; readonly maxHeight: number };

const EDGE = 8;
const GAP = 10;

export function placeCard(
  viewport: Size,
  mascot: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  card: Size,
): CardPlacement {
  const centerX = mascot.left + mascot.width / 2;
  const centeredLeft = clamp(centerX - card.width / 2, EDGE, Math.max(EDGE, viewport.width - card.width - EDGE));
  if (mascot.top - card.height - GAP >= EDGE) {
    return {
      side: "above",
      left: centeredLeft,
      bottom: viewport.height - mascot.top + GAP,
      maxHeight: Math.max(0, mascot.top - 18),
    };
  }
  const belowTop = mascot.top + mascot.height + GAP;
  if (belowTop + card.height <= viewport.height - EDGE) {
    return {
      side: "below",
      left: centeredLeft,
      top: belowTop,
      maxHeight: Math.max(0, viewport.height - belowTop - EDGE),
    };
  }
  const besideLeft = centerX < viewport.width / 2
    ? mascot.left + mascot.width + GAP
    : mascot.left - card.width - GAP;
  return {
    side: "beside",
    left: clamp(besideLeft, EDGE, Math.max(EDGE, viewport.width - card.width - EDGE)),
    top: clamp(
      mascot.top + mascot.height / 2 - card.height / 2,
      EDGE,
      Math.max(EDGE, viewport.height - card.height - EDGE),
    ),
    maxHeight: Math.max(0, viewport.height - EDGE * 2),
  };
}

/**
 * 상단 바에 둔 부관의 시트 자리. 글리프 아래로 내려오고 글리프의 오른쪽 변에 맞춘다 —
 * 새의 위치가 아니라 밴드가 닻이라 항상 같은 자리다. 높이는 화면의 80%까지만 쓴다: 그 이상은
 * 답이 아니라 벽이다.
 */
export function placeDockedCard(
  viewport: Size,
  glyph: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  card: Size,
): CardPlacement {
  const top = glyph.top + glyph.height + GAP;
  return {
    side: "below",
    left: clamp(glyph.left + glyph.width - card.width, EDGE, Math.max(EDGE, viewport.width - card.width - EDGE)),
    top,
    maxHeight: Math.max(0, Math.min(viewport.height * 0.8, viewport.height - top - EDGE)),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
