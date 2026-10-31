/**
 * 부관 Console Use 가 Objective 을 보관하거나 지우면, 사람이 누른 것과 같은 되돌리기 창을 연다.
 * 감싸기 제스처(펄스·시선 말풍선)는 없다.
 */

import type { ObjectiveArchiveReceipt } from "../../objectives/shared/records/archive.js";

export const OBJECTIVE_CLOSING_CHANNEL = "objective:closing";

/**
 * 에이전트가 Objective을 치웠다는 알림. Console Use의 닫기는 이제 보관이라 `archive`로 오고,
 * 보관 도입 전 서버가 보내던 삭제 receipt는 `deletion`으로 계속 받는다.
 */
export type ClosingByAgent =
  | {
    readonly kind: "archive";
    readonly receipt: ObjectiveArchiveReceipt;
    readonly targetTitle: string;
    readonly by: { readonly kind: "objectiveRecord"; readonly objectiveId: string; readonly title?: string } | { readonly kind: "plugin"; readonly pluginId: string; readonly title?: string };
  }
  | {
    readonly kind: "deletion";
    readonly receipt: { readonly deletionId: string; readonly kind: "objectiveRecord" | "theater"; readonly targetId: string; readonly expiresAt: number };
    readonly targetTitle: string;
    readonly by: { readonly kind: "objectiveRecord"; readonly objectiveId: string; readonly title?: string } | { readonly kind: "plugin"; readonly pluginId: string; readonly title?: string };
  };

const closingListeners = new Set<(closing: ClosingByAgent) => void>();

export function subscribeClosingByAgent(listener: (closing: ClosingByAgent) => void): () => void {
  closingListeners.add(listener);
  return () => { closingListeners.delete(listener); };
}

function readClosingByAgent(value: unknown): ClosingByAgent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const receipt = record.receipt as Record<string, unknown> | undefined;
  if (!receipt || typeof receipt !== "object" || !record.by || typeof record.by !== "object" || typeof receipt.targetId !== "string") return null;
  const by = record.by as ClosingByAgent["by"];
  const targetTitle = typeof record.targetTitle === "string" ? record.targetTitle : receipt.targetId;
  if (typeof receipt.archiveId === "string" && Array.isArray(receipt.objectiveIds) && typeof receipt.rootObjectiveId === "string") {
    return { kind: "archive", receipt: receipt as unknown as ObjectiveArchiveReceipt, targetTitle, by };
  }
  if (typeof receipt.deletionId === "string" && typeof receipt.expiresAt === "number" && (receipt.kind === "objectiveRecord" || receipt.kind === "theater")) {
    return { kind: "deletion", receipt: { deletionId: receipt.deletionId, kind: receipt.kind, targetId: receipt.targetId, expiresAt: receipt.expiresAt }, targetTitle, by };
  }
  return null;
}

let installed = false;
/** 앱이 한 번 부른다 — 보관·삭제 알림만 되돌리기 창에 잇는다. */
export function installConsoleUseGestures(services: {
  readonly subscribeConsoleChannel: (channel: string, listener: (payload: unknown) => void) => () => void;
}): () => void {
  if (installed) return () => undefined;
  installed = true;
  const disposeClosing = services.subscribeConsoleChannel(OBJECTIVE_CLOSING_CHANNEL, (payload) => {
    const closing = readClosingByAgent(payload);
    if (!closing) return;
    for (const listener of closingListeners) listener(closing);
  });
  return () => { installed = false; disposeClosing(); };
}
