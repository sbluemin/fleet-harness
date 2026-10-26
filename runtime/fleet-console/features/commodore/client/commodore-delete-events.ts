import type { CommodoreEvent } from "../shared/contracts/types.js";

export interface CommodoreDeletionNotice {
  readonly commodoreId: string;
  readonly message: string;
  readonly warning?: string;
  readonly focusId: string | null;
}
const removed = new Set<string>();
const flows = new Set<string>();
const listeners = new Set<(event: CommodoreEvent) => void>();
const completions = new Set<(notice: CommodoreDeletionNotice) => void>();
const leaves = new Map<string, (run: () => void) => void>();

export const wasCommodoreRemoved = (id: string) => removed.has(id);
export const isCommodoreDeletionOpen = (id: string) => flows.has(id);
export function holdCommodoreDeletion(id: string): () => void { flows.add(id); return () => { flows.delete(id); }; }
export function publishCommodoreLifecycle(event: CommodoreEvent): void {
  if (event.op === "removed") removed.add(event.commodoreId);
  for (const listener of [...listeners]) listener(event);
}
export function subscribeCommodoreLifecycle(listener: (event: CommodoreEvent) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function announceCommodoreDeletion(notice: CommodoreDeletionNotice): void { for (const listener of [...completions]) listener(notice); }
export function subscribeCommodoreDeletionComplete(listener: (notice: CommodoreDeletionNotice) => void): () => void { completions.add(listener); return () => { completions.delete(listener); }; }
/** 폰 상세의 history 깊이를 접는 능력만 등록한다. 다른 화면은 그 내부 상태를 고치지 않는다. */
export function registerCommodoreDeparture(id: string, leave: (run: () => void) => void): () => void {
  leaves.set(id, leave);
  return () => { if (leaves.get(id) === leave) leaves.delete(id); };
}
export function leaveCommodore(id: string, run: () => void): void { const leave = leaves.get(id); if (leave) leave(run); else run(); }
