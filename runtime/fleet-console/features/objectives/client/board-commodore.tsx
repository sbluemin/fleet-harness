import { useEffect, useSyncExternalStore } from "react";
import type { CommodoreBoardClient, CommodoreBoardObjective, CommodoreBoardSnapshot } from "../shared/commodore-board-client.js";
import type { CommodoreClientHost } from "../../commodore/shared/contracts/client.js";
export { askObjectiveTitle } from "../../commodore/shared/contracts/client-helpers.js";
import { livePersonHold } from "../shared/board-state.js";
import { PERSON_HOLD_TARGETS, type Objective, type ObjectivePersonHold } from "../shared/types.js";
import { commanderMongleState, ObjectiveAvatar } from "./objective-avatar.js";
import { goToObjective } from "./fresh-conversation.js";
import { HandedFollowupCard } from "./handed-followups.js";
import { consultDelivery } from "./conversation.js";
import { findFinishedObjective, finishedObjectives, finishedObjectivesLoaded, loadFinishedObjectives, noteAlive, openObjectiveFromCluster, openObjectiveOnPhone, readBoard, revealObjective, subscribeFinishedObjectivesStore, subscribeObjective, useObjectiveSummaries } from "./objectives-state.js";

/** 지휘관이 돌고 있는 목표 — 개시했고, 끝나지 않았고, 사람의 검토·인계를 기다리지 않는다. */
export function isRunningObjective(objective: Objective): boolean {
  return !objective.removed && !objective.done && objective.commander.started && !objective.awaitingReview && !objective.awaitingHandoff;
}

/** 넘긴 후속 후보도 사령관 대화에서 답한다 — 후보에 답하는 표면이라 완료한 목표에도 선다. */
export function followupInCommodoreConversation(objective: Objective): boolean {
  return !objective.removed && !!livePersonHold(objective, "followup");
}

/** 사령관이 사람에게 넘겨 지금 사람이 답할 차례인 항목들 — 대상 순서(기준·검토·후속)대로. */
export function livePersonHolds(objective: Objective): readonly ObjectivePersonHold[] {
  if (objective.removed) return [];
  return PERSON_HOLD_TARGETS.flatMap((target) => livePersonHold(objective, target) ?? []);
}

/**
 * 줄이 읽는 사령관 별칭 — 호스트가 준 스냅샷의 사령관 UUID 속성이다. 없거나 아직 읽지 않았으면 null.
 * 사이드바 줄·전환 목록·폰과 말풍선 머리가 이 하나로 별칭을 읽는다.
 */
export function commodoreAliasOf(commodoreId: string): string | null {
  return commodoreBoardOf(commodoreId).view?.state.alias ?? null;
}

/**
 * 사람이 답할 차례인 기준·검토·후속의 가장 이른 넘김 시각. 사람의 차례가 없으면 null.
 */
export function personTurnAt(objective: Objective): number | null {
  const holds = livePersonHolds(objective);
  return holds.length ? Math.min(...holds.map((hold) => hold.at)) : null;
}

/**
 * 사령관이 맡아 기다리는 목표 — 사람에게 넘기지 않은 대기 항목(출범 전·기준 제안·검토·후속)이 남았다.
 * 사람에게 넘긴 항목만 남은 목표는 사령관을 기다리지 않는다.
 */
export { isCommodoreWaiting } from "../shared/board-state.js";
import { isCommodoreWaiting } from "../shared/board-state.js";


let host: CommodoreClientHost | undefined;
export const commodoreIds = () => host?.ids() ?? [];
let revision = 0;
const listeners = new Set<() => void>();
const conversationListeners = new Set<() => void>();
const changed = () => { revision += 1; for (const listener of listeners) listener(); };
const conversationChanged = () => { for (const listener of conversationListeners) listener(); };
export function installCommodoreHost(next: CommodoreClientHost | undefined): () => void {
  host = next;
  const off = next?.subscribe(changed);
  const offConversation = next?.subscribeConversation(conversationChanged);
  changed(); conversationChanged();
  return () => { off?.(); offConversation?.(); if (host === next) host = undefined; changed(); conversationChanged(); };
}
export const subscribeCommodore = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const commodoreRevision = () => revision;
const EMPTY = { commodoreId: "", active: false, stalled: [] as readonly string[], enabled: false, peek: false, view: null, asks: [] };
export const commodoreBoardOf = (commodoreId: string) => host?.read(commodoreId) ?? EMPTY;
export const readCommodore = commodoreBoardOf;
export const openAsks = (commodoreId: string | null) => commodoreId ? host?.read(commodoreId).asks ?? EMPTY.asks : EMPTY.asks;
export const commodoreLanguage = () => host?.language();
export const isCommodoreConversationActive = () => host?.conversationActive() ?? false;
export const subscribeCommodoreConversationActive = (listener: () => void) => { conversationListeners.add(listener); return () => { conversationListeners.delete(listener); }; };
export const openCommodoreConversation = (commodoreId: string, options?: Parameters<CommodoreClientHost["open"]>[1]) => host?.open(commodoreId, options) ?? false;
export const openCommodoreLog = (commodoreId: string) => { host?.open(commodoreId, { tab: "log" }); };
export const openCommodoreMobile = (tab: "log" | "info" | "settings" | "goals", commodoreId: string | null) => { if (commodoreId) host?.open(commodoreId, { tab, mobile: true }); };
const boards = new Map<string, { readonly key: string; readonly value: { readonly active: boolean; readonly stalled: readonly string[] } }>();
function boardSnapshot(commodoreId: string) {
  const { active, stalled } = commodoreBoardOf(commodoreId);
  const key = `${active}:${stalled.join(",")}`;
  const hit = boards.get(commodoreId);
  if (hit?.key === key) return hit.value;
  const value = { active, stalled }; boards.set(commodoreId, { key, value }); return value;
}
export function useCommodoreBoard(commodoreId: string) {
  const result = useSyncExternalStore(subscribeCommodore, () => boardSnapshot(commodoreId), () => boardSnapshot(commodoreId));
  const enabled = useSyncExternalStore(subscribeCommodore, () => commodoreBoardOf(commodoreId).enabled, () => commodoreBoardOf(commodoreId).enabled);
  useEffect(() => { if (enabled && commodoreId) void host?.load(commodoreId); }, [enabled, commodoreId]);
  return result;
}

const projected = new WeakMap<Objective, CommodoreBoardObjective>();
function project(objective: Objective): CommodoreBoardObjective {
  const hit = projected.get(objective); if (hit) return hit;
  const { id, commodoreId, theaterId, title, createdAt, done, removed, commenced, awaitingReview, awaitingHandoff, missions, addedBy, actions, decisions } = objective;
  const consults = objective.consultations.map(({ id: consultId, question, at, reply, delivery }) => ({ id: consultId, question, at,
    ...(reply ? { reply: { text: reply.kind === "advice" ? reply.text : null, at: reply.at, ...(delivery ? { delivery: consultDelivery(delivery) } : {}) } } : {}) }));
  const view = { id, commodoreId, theaterId, title, createdAt, done, removed, commenced, awaitingReview, awaitingHandoff, followupHanded: followupInCommodoreConversation(objective), missions, addedBy, actions, decisions, consults, running: isRunningObjective(objective), waiting: isCommodoreWaiting(objective) };
  projected.set(objective, view); return view;
}
const lists = new WeakMap<readonly Objective[], readonly CommodoreBoardObjective[]>();
function projectList(source: readonly Objective[]) { let hit = lists.get(source); if (!hit) { hit = source.map(project); lists.set(source, hit); } return hit; }
const snapshots = new WeakMap<ReturnType<typeof readBoard>, CommodoreBoardSnapshot>();
const NO_FINISHED: readonly CommodoreBoardObjective[] = [];
function ObjectiveMark({ commodoreId, objectiveId, size }: { readonly commodoreId: string; readonly objectiveId: string; readonly size: number }) {
  const source = useSyncExternalStore(subscribeObjective, () => readBoard(commodoreId), () => readBoard(commodoreId));
  const readFinished = () => finishedObjectivesLoaded(commodoreId) ? finishedObjectives(commodoreId) : NO_FINISHED;
  useSyncExternalStore(subscribeFinishedObjectivesStore, readFinished, readFinished);
  const objectiveRecords = useObjectiveSummaries();
  const objective = source.objectives.find((candidate) => candidate.id === objectiveId) ?? finishedObjectives(commodoreId).find((candidate) => candidate.id === objectiveId);
  if (!objective) return null;
  const activity = objectiveRecords.find((objectiveRecord) => objectiveRecord.id === objectiveId)?.activity ?? "closed";
  return <ObjectiveAvatar objectiveId={objectiveId} role="commander" state={commanderMongleState(objective, activity === "background" ? "running" : activity)} size={size} />;
}
export const commodoreBoard: CommodoreBoardClient = {
  serverReached: noteAlive,
  read(commodoreId) { const source = readBoard(commodoreId); let hit = snapshots.get(source); if (!hit) { hit = { loaded: source.loaded, objectives: projectList(source.objectives) }; snapshots.set(source, hit); } return hit; },
  subscribe: subscribeObjective,
  finished: (commodoreId) => finishedObjectivesLoaded(commodoreId) ? projectList(finishedObjectives(commodoreId)) : NO_FINISHED,
  finishedLoaded: finishedObjectivesLoaded,
  loadFinished: loadFinishedObjectives,
  subscribeFinished: subscribeFinishedObjectivesStore,
  findFinished: (id) => { const objective = findFinishedObjective(id); return objective ? project(objective) : null; },
  openObjective: goToObjective,
  openObjectiveFromCluster,
  openObjectiveOnPhone,
  revealObjective,
  renderObjectiveAvatar: (commodoreId, objectiveId, size) => <ObjectiveMark commodoreId={commodoreId} objectiveId={objectiveId} size={size} />,
  renderHandedFollowup: (objectiveId, { language, phone, open }) => <HandedFollowupCard objectiveId={objectiveId} language={language} phone={phone} open={open} />,
};
