export function commandBandRenameCommitTarget(capturedOperationId: string | null, activeOperationId: string | null): string | null {
  return capturedOperationId !== null && capturedOperationId === activeOperationId ? capturedOperationId : null;
}

export function shouldCloseCommandBandContextDeck(isBandDeckOpen: boolean, isRailDeckOpen: boolean): boolean {
  return isBandDeckOpen && isRailDeckOpen;
}

export function railPathContextDeckOpenAfterCommandBandToggle(isBandDeckOpen: boolean, isRailDeckOpen: boolean): boolean {
  return isBandDeckOpen ? false : isRailDeckOpen;
}
