export function focusCommandBandToggleWhenPanelContainsActiveElement(panel: HTMLElement | null, toggleSelector: string): void {
  const activeElement = document.activeElement;
  if (panel === null || !(activeElement instanceof Node) || !panel.contains(activeElement)) return;
  document.querySelector<HTMLButtonElement>(toggleSelector)?.focus();
}
