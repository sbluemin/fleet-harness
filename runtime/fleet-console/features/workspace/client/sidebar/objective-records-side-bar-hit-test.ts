/** 사령관 머리 끌기의 놓을 자리 — 포인터가 지난 머리의 가운데를 기준으로 그 앞에 놓는다. */
export function theaterDropIndexFromPoint(
  clientY: number,
  orderedTheaterIds: readonly string[],
  container: HTMLOListElement | null,
  sourceTheaterId?: string,
): number {
  if (!container) return 0;
  const theaterElements = Array.from(container.querySelectorAll<HTMLElement>("[data-theater-id]"));
  for (const theaterEl of theaterElements) {
    const id = theaterEl.dataset.theaterId;
    if (!id || id === sourceTheaterId) continue;
    const index = orderedTheaterIds.indexOf(id);
    if (index === -1) continue;
    const rect = theaterEl.getBoundingClientRect();
    if (clientY <= rect.top + rect.height / 2) return index;
  }
  return orderedTheaterIds.length;
}

export function reorderTheaterIds(
  orderedTheaterIds: readonly string[],
  sourceTheaterId: string,
  dropIndex: number,
): string[] {
  const sourceIndex = orderedTheaterIds.indexOf(sourceTheaterId);
  if (sourceIndex === -1) return [...orderedTheaterIds];
  const next = orderedTheaterIds.filter((id) => id !== sourceTheaterId);
  const adjusted = dropIndex > sourceIndex ? dropIndex - 1 : dropIndex;
  const bounded = Math.max(0, Math.min(adjusted, next.length));
  next.splice(bounded, 0, sourceTheaterId);
  return next;
}

/**
 * 점이 요소 안 글자 위에 있는지 — 이름 칸은 줄 폭을 다 받아 늘어나 있으므로 칸이 아니라 글자가 그려진 자리로 판정한다.
 * 말줄임으로 칸 밖까지 이어지는 글자 자리는 칸에서 자른다.
 */
export function pointOnText(element: Element, clientX: number, clientY: number): boolean {
  const box = element.getBoundingClientRect();
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  for (const rect of Array.from(range.getClientRects())) {
    const left = Math.max(rect.left, box.left);
    const right = Math.min(rect.right, box.right);
    if (clientX >= left && clientX <= right && clientY >= Math.max(rect.top, box.top) && clientY <= Math.min(rect.bottom, box.bottom)) return true;
  }
  return false;
}
