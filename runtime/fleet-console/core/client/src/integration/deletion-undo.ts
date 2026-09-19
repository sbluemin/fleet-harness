import type { DeferredDeletionReceipt } from "./api.js";

export function appendPendingDeletion(current: readonly DeferredDeletionReceipt[], deletion: DeferredDeletionReceipt): readonly DeferredDeletionReceipt[] {
  return [...current.filter((item) => item.deletionId !== deletion.deletionId), deletion];
}

export function latestPendingDeletion(current: readonly DeferredDeletionReceipt[], now: number): DeferredDeletionReceipt | null {
  return [...current].reverse().find((deletion) => deletion.expiresAt > now) ?? null;
}

export function deletionCountdownSeconds(deletion: DeferredDeletionReceipt, now: number): number {
  return Math.max(1, Math.ceil((deletion.expiresAt - now) / 1_000));
}
