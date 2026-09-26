export interface TourCardPosition {
  readonly left: number;
  readonly top: number;
  readonly centered: boolean;
}

type Rect = Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width">;
type BoundaryRect = Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">;

/**
 * 투어 카드 자리. 경계가 있으면 경계 옆(오른쪽 → 왼쪽 → 아래 → 위), 없으면 앵커 아래(모자라면 위)에 선다.
 *
 * alignToAnchor는 경계 옆에 서되 세로를 앵커 높이에 맞춘다. 키 큰 패널 안에서 구획을 차례로 짚을 때 경계 가운데에
 * 서면 카드와 가리키는 구획이 멀어진다. 좌우 어디에도 자리가 없으면 경계 위아래가 아니라 앵커 기준 배치로
 * 돌아간다 — 화면을 거의 채운 경계의 위아래에는 카드가 들어갈 틈이 없다.
 */
export function resolveTourCardPosition(options: {
  readonly anchor: Rect;
  readonly boundary: BoundaryRect | null;
  readonly alignToAnchor?: boolean;
  readonly cardWidth: number;
  readonly cardHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}): TourCardPosition {
  const { anchor, boundary, alignToAnchor = false, cardWidth, cardHeight, viewportWidth, viewportHeight } = options;
  const gap = 12;
  const margin = 12;
  const clampLeft = (left: number) => Math.min(viewportWidth - cardWidth - margin, Math.max(margin, left));
  const clampTop = (top: number) => Math.min(viewportHeight - cardHeight - margin, Math.max(margin, top));
  if (boundary) {
    const besideTop = alignToAnchor
      ? clampTop(Math.max(anchor.top, boundary.top) - 8)
      : clampTop(boundary.top + boundary.height / 2 - cardHeight / 2);
    if (boundary.right + gap + cardWidth <= viewportWidth - margin) {
      return { left: boundary.right + gap, top: besideTop, centered: false };
    }
    if (boundary.left - gap - cardWidth >= margin) {
      return { left: boundary.left - gap - cardWidth, top: besideTop, centered: false };
    }
    if (alignToAnchor) return resolveTourCardPosition({ ...options, boundary: null });
    const centeredLeft = clampLeft(boundary.left + boundary.width / 2 - cardWidth / 2);
    if (boundary.bottom + gap + cardHeight <= viewportHeight - margin) {
      return { left: centeredLeft, top: boundary.bottom + gap, centered: false };
    }
    return { left: centeredLeft, top: Math.max(margin, boundary.top - cardHeight - gap), centered: false };
  }
  const below = anchor.bottom + gap;
  const top = below + cardHeight <= viewportHeight - margin
    ? below
    : Math.max(margin, anchor.top - cardHeight - gap);
  return {
    left: clampLeft(anchor.left + anchor.width / 2 - cardWidth / 2),
    top,
    centered: false,
  };
}
