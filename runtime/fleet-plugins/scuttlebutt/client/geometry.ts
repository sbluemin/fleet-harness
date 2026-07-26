export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly left: number;
  readonly top: number;
}

export type CardPlacement =
  | { readonly side: "above"; readonly left: number; readonly bottom: number; readonly maxHeight: number }
  | { readonly side: "below" | "beside"; readonly left: number; readonly top: number; readonly maxHeight: number };

const EDGE = 8;
const GAP = 10;

export function clampPoint(point: Point, viewport: Size, widget: Size, inset = 4): Point {
  return {
    left: clamp(point.left, inset, Math.max(inset, viewport.width - widget.width - inset)),
    top: clamp(point.top, inset, Math.max(inset, viewport.height - widget.height - inset)),
  };
}

export function snapPoint(
  corner: "bottom-right" | "bottom-left" | "top-right",
  viewport: Size,
  widget: Size,
): Point {
  if (corner === "bottom-left") return clampPoint({ left: 16, top: viewport.height - widget.height - 12 }, viewport, widget);
  if (corner === "top-right") return clampPoint({ left: viewport.width - widget.width - 16, top: 12 }, viewport, widget);
  return clampPoint({ left: viewport.width - widget.width - 16, top: viewport.height - widget.height - 12 }, viewport, widget);
}

export function placeCard(viewport: Size, mascot: Rect, card: Size): CardPlacement {
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
