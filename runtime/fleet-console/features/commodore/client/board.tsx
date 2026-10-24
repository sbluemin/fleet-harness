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
export const readTheater = (commodoreId: string | null) => commodoreId ? board?.read(commodoreId) ?? EMPTY : EMPTY;
export const subscribeObjective = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useObjectiveTheater(commodoreId: string | null) {
  return useSyncExternalStore(subscribeObjective, () => readTheater(commodoreId), () => readTheater(commodoreId));
}
export const finishedObjectives = (commodoreId: string) => board?.finished(commodoreId) ?? NO_OBJECTIVES;
export const finishedObjectivesLoaded = (commodoreId: string) => board?.finishedLoaded(commodoreId) ?? false;
export const loadFinishedObjectives = (commodoreId: string) => board?.loadFinished(commodoreId);
export const subscribeFinishedObjectivesStore = (listener: () => void) => { finishedListeners.add(listener); return () => { finishedListeners.delete(listener); }; };
export const findFinishedObjective = (id: string) => board?.findFinished(id) ?? null;
export const goToObjective = (id: string, theaterId: string, done?: boolean) => board?.openObjective(id, theaterId, done);
export const openObjectiveFromCluster = (theaterId?: string, objectiveId?: string) => board?.openObjectiveFromCluster(theaterId, objectiveId);
export const openObjectiveOnPhone = (objectiveId: string, theaterId?: string) => board?.openObjectiveOnPhone(objectiveId, theaterId);
export const revealObjective = (input: { readonly objectiveId: string }) => board?.revealObjective(input);
export const renderObjectiveAvatar = (commodoreId: string, objectiveId: string, size: number) => board?.renderObjectiveAvatar(commodoreId, objectiveId, size) ?? null;
export const isRunningObjective = (objective: CommodoreBoardObjective) => objective.running;
export const isCommodoreWaiting = (objective: CommodoreBoardObjective) => objective.waiting;

/** 목표 자체의 장소를 표시 문맥으로 쓰되, 소유 UUID를 Theater 자리로 넘기지 않는다. */
export function openOwnedObjectiveOnPhone(commodoreId: string, objectiveId: string): void {
  const objective = board?.read(commodoreId).objectives.find((row) => row.id === objectiveId) ?? board?.findFinished(objectiveId);
  board?.openObjectiveOnPhone(objectiveId, objective?.theaterId);
}
