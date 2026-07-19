export function commandBandRenameCommitTarget(capturedOperationId: string | null, activeOperationId: string | null): string | null {
  return capturedOperationId !== null && capturedOperationId === activeOperationId ? capturedOperationId : null;
}
