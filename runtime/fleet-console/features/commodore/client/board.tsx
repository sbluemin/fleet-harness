import { useSyncExternalStore } from "react";
import type { CommodoreBoardClient, CommodoreBoardObjective, CommodoreBoardSnapshot } from "../../objectives/shared/commodore-board-client.js";

let board: CommodoreBoardClient | null = null;
const EMPTY: CommodoreBoardSnapshot = { loaded: false, objectives: [] };
const NO_OBJECTIVES: readonly CommodoreBoardObjective[] = [];
const listeners = new Set<() => void>();
const finishedListeners = new Set<() => void>();
const announce = () => { for (const listener of listeners) listener(); };
const announceFinished = () => { for (const listener of finishedListeners) listener(); };
export function installCommodoreBoard(next: CommodoreBoardClient | null): () => void {
  board = next;
  const off = next?.subscribe(announce);
  const offFinished = next?.subscribeFinished(announceFinished);
  announce(); announceFinished();
  return () => { off?.(); offFinished?.(); if (board === next) { board = null; announce(); announceFinished(); } };
}
export const serverReached = () => board?.serverReached();
export const readTheater = (theaterId: string | null) => theaterId ? board?.read(theaterId) ?? EMPTY : EMPTY;
export const subscribeObjective = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useObjectiveTheater(theaterId: string | null) {
  return useSyncExternalStore(subscribeObjective, () => readTheater(theaterId), () => readTheater(theaterId));
}
export const finishedObjectives = (theaterId: string) => board?.finished(theaterId) ?? NO_OBJECTIVES;
export const finishedObjectivesLoaded = (theaterId: string) => board?.finishedLoaded(theaterId) ?? false;
export const loadFinishedObjectives = (theaterId: string) => board?.loadFinished(theaterId);
export const subscribeFinishedObjectivesStore = (listener: () => void) => { finishedListeners.add(listener); return () => { finishedListeners.delete(listener); }; };
export const findFinishedObjective = (id: string) => board?.findFinished(id) ?? null;
export const goToObjective = (id: string, theaterId: string, done?: boolean) => board?.openObjective(id, theaterId, done);
export const openObjectiveFromCluster = (theaterId?: string, objectiveId?: string) => board?.openObjectiveFromCluster(theaterId, objectiveId);
export const openObjectiveOnPhone = (objectiveId: string, theaterId?: string) => board?.openObjectiveOnPhone(objectiveId, theaterId);
export const revealObjective = (input: { readonly objectiveId: string }) => board?.revealObjective(input);
export const renderObjectiveAvatar = (theaterId: string, objectiveId: string, size: number) => board?.renderObjectiveAvatar(theaterId, objectiveId, size) ?? null;
export const isRunningObjective = (objective: CommodoreBoardObjective) => objective.running;
export const isCommodoreWaiting = (objective: CommodoreBoardObjective) => objective.waiting;
