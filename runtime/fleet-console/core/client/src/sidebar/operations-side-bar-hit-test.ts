export function dropIndexFromPoint(
  clientY: number,
  orderedIds: readonly string[],
  container: HTMLOListElement | null,
  sourceId?: string,
): number {
  if (!container) return 0;
  const chipElements = Array.from(container.querySelectorAll<HTMLElement>("[data-side-bar-chip-id]"));
  for (const chip of chipElements) {
    const id = chip.dataset.sideBarChipId;
    if (!id || id === sourceId) continue;
    const rect = chip.getBoundingClientRect();
    if (clientY <= rect.top + rect.height / 2) return Math.max(0, orderedIds.indexOf(id));
  }
  return orderedIds.length;
}
