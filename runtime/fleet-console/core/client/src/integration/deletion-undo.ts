import type { OperationArchiveReceipt } from "@fleet-console/sdk/operations/browser";

import type { DeferredDeletionReceipt } from "./api.js";

/**
 * 토스트와 ⌘Z가 되돌릴 수 있는 일 하나. 사람이 Operation을 치우면 보관(archive), Theater 잊기는 유예
 * 삭제(deletion)다. 삭제의 창은 서버 유예가 정하고, 보관의 창은 보여 주는 동안만이다 — 보관은 그 뒤에도
 * 보관함에서 복원할 수 있다.
 */
export type PendingUndo =
  | { readonly kind: "deletion"; readonly key: string; readonly expiresAt: number; readonly deletion: DeferredDeletionReceipt }
  | { readonly kind: "archive"; readonly key: string; readonly expiresAt: number; readonly receipt: OperationArchiveReceipt };

export function deletionUndo(deletion: DeferredDeletionReceipt): PendingUndo {
  return { kind: "deletion", key: `deletion:${deletion.deletionId}`, expiresAt: deletion.expiresAt, deletion };
}

export function archiveUndo(receipt: OperationArchiveReceipt, expiresAt: number): PendingUndo {
  return { kind: "archive", key: `archive:${receipt.archiveId}`, expiresAt, receipt };
}

export function appendPendingUndo(current: readonly PendingUndo[], entry: PendingUndo): readonly PendingUndo[] {
  return [...current.filter((item) => item.key !== entry.key), entry];
}

export function latestPendingUndo(current: readonly PendingUndo[], now: number): PendingUndo | null {
  return [...current].reverse().find((entry) => entry.expiresAt > now) ?? null;
}

export function undoCountdownSeconds(entry: PendingUndo, now: number): number {
  return Math.max(1, Math.ceil((entry.expiresAt - now) / 1_000));
}
