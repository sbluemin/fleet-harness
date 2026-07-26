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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
