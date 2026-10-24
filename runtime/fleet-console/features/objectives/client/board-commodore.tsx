import { useEffect, useSyncExternalStore } from "react";
import type { CommodoreBoardClient, CommodoreBoardObjective, CommodoreBoardSnapshot } from "../shared/commodore-board-client.js";
import type { CommodoreClientHost } from "../../commodore/shared/contracts/client.js";
export { askObjectiveTitle } from "../../commodore/shared/contracts/client-helpers.js";
import { followupsJudgeable, livePersonHold, reasonAwaits } from "../shared/board-state.js";
import { PERSON_HOLD_TARGETS, type Objective, type ObjectivePersonHold } from "../shared/types.js";
import { commanderMongleState, ObjectiveAvatar } from "./objective-avatar.js";
import { goToObjective } from "./fresh-conversation.js";
import { findFinishedObjective, finishedObjectives, finishedObjectivesLoaded, loadFinishedObjectives, noteAlive, openObjectiveFromCluster, openObjectiveOnPhone, readBoard, revealObjective, subscribeFinishedObjectivesStore, subscribeObjective, useObjectiveSummaries } from "./objectives-state.js";

/** 지휘관이 돌고 있는 목표 — 개시했고, 끝나지 않았고, 사람의 검토·인계를 기다리지 않는다. */
export function isRunningObjective(objective: Objective): boolean {
  return !objective.removed && !objective.done && objective.commander.started && !objective.awaitingReview && !objective.awaitingHandoff;
}

/**
 * 결정 요청이 누구의 차례인가 — 보드의 차례 축(`reasonAwaits`) 위에 자율 운영을 얹는다. 자율 운영이 실제로 돌지 않으면 사령관
 * 몫도 사람에게 돌아오므로 사람이다. 요청이 없거나 끝난 목표는 null. 사이드바·전환 목록·폰·레일·결정 칸이 이 하나를 읽는다.
 */
export function decisionTurn(objective: Objective, commodoreActive: boolean): "person" | "commodore" | null {
  if (objective.removed || objective.done || !objective.decisionRequest) return null;
  return !commodoreActive || reasonAwaits(objective, "decision") === "person" ? "person" : "commodore";
}

/** 사령관이 사람에게 넘겨 지금 사람이 답할 차례인 항목들 — 대상 순서(결정·기준·검토·후속)대로. */
export function livePersonHolds(objective: Objective): readonly ObjectivePersonHold[] {
  if (objective.removed) return [];
  return PERSON_HOLD_TARGETS.flatMap((target) => livePersonHold(objective, target) ?? []);
}

/**
 * 「내 결정」에 서는 시각 — 사람이 답할 결정 요청이면 그 요청 시각, 아니면 사령관이 넘긴 다른 항목(기준·검토·후속)의 가장 이른
 * 넘김 시각. 사람의 차례가 없으면 null.
 */
export function personTurnAt(objective: Objective, commodoreActive: boolean): number | null {
  if (decisionTurn(objective, commodoreActive) === "person") return objective.decisionRequest!.createdAt;
  const holds = livePersonHolds(objective);
  return holds.length ? Math.min(...holds.map((hold) => hold.at)) : null;
}

/**
 * 사령관이 맡아 기다리는 목표 — 사령관이 운영하고, 사람에게 넘기지 않은 대기 항목(출범 전·기준 제안·결정 요청·검토·후속)이 남았다.
 * 사람에게 넘긴 항목만 남은 목표는 사령관을 기다리지 않는다.
 */
export function isCommodoreWaiting(objective: Objective): boolean {
  if (objective.operator !== "commodore" || objective.removed || objective.done) return false;
  const kept = (target: (typeof PERSON_HOLD_TARGETS)[number]) => !livePersonHold(objective, target);
  // 출범 전 기준 제안을 사람에게 넘겼으면 개시는 사람의 답을 기다린다(criteria_pending) — 사령관의 일이 아니다.
  return (!objective.commenced && !(objective.criteriaProposals.length > 0 && !kept("criteria")))
    || (objective.criteriaProposals.length > 0 && kept("criteria"))
    || (objective.decisionRequest !== null && kept("decision"))
    || (objective.awaitingReview && kept("review"))
    // 진행 중의 후속 후보는 모이기만 한다 — 검토 대기에 검토와 함께 사령관을 기다린다.
    || (followupsJudgeable(objective) && objective.followups.some((followup) => followup.state === "open") && kept("followup"));
}


let host: CommodoreClientHost | undefined;
export const ownerOfContext = (theaterId: string | null) => theaterId ? host?.ownerOfContext(theaterId) ?? null : null;
export const resolveContext = (theaterId: string) => host?.resolveContext(theaterId) ?? Promise.resolve(null);
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
export const openAskTheaters = () => host?.askTheaters() ?? [];
export const commodoreLanguage = () => host?.language();
export const isCommodoreConversationActive = () => host?.conversationActive() ?? false;
export const subscribeCommodoreConversationActive = (listener: () => void) => { conversationListeners.add(listener); return () => { conversationListeners.delete(listener); }; };
export const openCommodoreConversation = (commodoreId: string, options?: Parameters<CommodoreClientHost["open"]>[1]) => host?.open(commodoreId, options) ?? false;
export const openCommodoreLog = (commodoreId: string) => { host?.open(commodoreId, { tab: "log" }); };
export const openCommodoreMobile = (tab: "log" | "directive" | "memory" | "settings" | "goals", commodoreId: string | null) => { if (commodoreId) host?.open(commodoreId, { tab, mobile: true }); };
export const renderCommodoreRowGlyph = () => host?.renderRowGlyph("", true) ?? null;
export const renderCommodoreRowGlyphOff = () => host?.renderRowGlyph("", false) ?? null;
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
  const { id, commodoreId, theaterId, title, createdAt, done, removed, commenced, awaitingReview, awaitingHandoff, decisionRequest, missions, addedBy, actions, decisions } = objective;
  const view = { id, commodoreId, theaterId, title, createdAt, done, removed, commenced, awaitingReview, awaitingHandoff, decisionRequest, missions, addedBy, actions, decisions, running: isRunningObjective(objective), waiting: isCommodoreWaiting(objective) };
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
  railEntryIds: ["objectives"],
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
};
