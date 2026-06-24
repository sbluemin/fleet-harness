export function dropIndexFromPoint(clientX: number, orderedIds: readonly string[], chipsElement: HTMLDivElement | null, sourceId?: string): number {
  if (!chipsElement) return 0;
  const chipElements = Array.from(chipsElement.querySelectorAll<HTMLElement>("[data-dock-chip-id]"));
  for (const chip of chipElements) {
    const id = chip.dataset.dockChipId;
    if (!id || id === sourceId) continue;
    const rect = chip.getBoundingClientRect();
    if (clientX <= rect.left + rect.width / 2) return Math.max(0, orderedIds.indexOf(id));
  }
  return orderedIds.length;
}
