import { useEffect, useMemo } from "react";

import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import type { CoreMessageKey } from "../../../../core/client/src/i18n/messages/index.js";
import { CONVERSATION_REFERENCE_MARK } from "../../../execution/shared/conversation/references.js";
import { resolveObjectiveActivity } from "../../../execution/client/objective-activity.js";
import { commodoreSectionLabel, useCommodoreList, useCommodoreSidebarLayout, useSidebarOrder } from "../../../commodore/client/commodore-list.js";
import { commodoreSidebarBuckets } from "../../../commodore/client/sidebar-sections.js";
import { messageCommodore } from "../../../commodore/client/commodore-state.js";
import { MAX_COMMODORE_REFERENCES } from "../../../commodore/client/commodore-reference-input.js";
import type { ConsoleCommodoreSummary } from "../../../commodore/shared/contracts/theaters.js";
import { loadBoard, objectivesApi, useAllObjectives } from "../../../objectives/client/objectives-state.js";
import { livePersonHolds } from "../../../objectives/client/board-commodore.js";
import { openFollowups } from "../../../objectives/client/followups.js";
import type { Objective } from "../../../objectives/shared/types.js";
import type { ObjectiveCluster } from "../../../objectives/shared/objective-clusters.js";
import type { MongleState } from "../../shared/avatars.js";
import { useClusterIndex } from "../objective-clusters.js";

export type CommandBoardColumnId = "fresh" | "active" | "review" | "done";

export const COMMAND_BOARD_COLUMNS: readonly {
  readonly id: CommandBoardColumnId;
  readonly labelKey: CoreMessageKey;
  readonly descKey: CoreMessageKey;
}[] = [
  { id: "fresh", labelKey: "commandBoard.col.fresh", descKey: "commandBoard.col.freshDesc" },
  { id: "active", labelKey: "commandBoard.col.active", descKey: "commandBoard.col.activeDesc" },
  { id: "review", labelKey: "commandBoard.col.review", descKey: "commandBoard.col.reviewDesc" },
  { id: "done", labelKey: "commandBoard.col.done", descKey: "commandBoard.col.doneDesc" },
];

export interface CommandBoardPreset {
  readonly id: string;
  readonly labelKey: CoreMessageKey;
  readonly promptKey: CoreMessageKey;
}

/** 컬럼별 의도 프리셋 — 구상·개시 같은 내부 절차 대신 결과·의도만 전달하면 사령관이 자율 수행한다. */
export const COMMAND_BOARD_PRESETS: Readonly<Record<CommandBoardColumnId, readonly CommandBoardPreset[]>> = {
  fresh: [
    { id: "start", labelKey: "commandBoard.preset.fresh.start", promptKey: "commandBoard.preset.fresh.startPrompt" },
    { id: "reschedule", labelKey: "commandBoard.preset.fresh.reschedule", promptKey: "commandBoard.preset.fresh.reschedulePrompt" },
    { id: "hold", labelKey: "commandBoard.preset.fresh.hold", promptKey: "commandBoard.preset.fresh.holdPrompt" },
  ],
  active: [
    { id: "check", labelKey: "commandBoard.preset.active.check", promptKey: "commandBoard.preset.active.checkPrompt" },
    { id: "steer", labelKey: "commandBoard.preset.active.steer", promptKey: "commandBoard.preset.active.steerPrompt" },
    { id: "wrap", labelKey: "commandBoard.preset.active.wrap", promptKey: "commandBoard.preset.active.wrapPrompt" },
  ],
  review: [
    { id: "complete", labelKey: "commandBoard.preset.review.complete", promptKey: "commandBoard.preset.review.completePrompt" },
    { id: "revise", labelKey: "commandBoard.preset.review.revise", promptKey: "commandBoard.preset.review.revisePrompt" },
  ],
  done: [
    { id: "followup", labelKey: "commandBoard.preset.done.followup", promptKey: "commandBoard.preset.done.followupPrompt" },
    { id: "archive", labelKey: "commandBoard.preset.done.archive", promptKey: "commandBoard.preset.done.archivePrompt" },
  ],
};

export interface CommandBoardCommodore {
  readonly id: string;
  readonly name: string;
  readonly sectionId: string | null;
  readonly sectionName: string | null;
  readonly autonomous: boolean;
  readonly running: boolean;
  readonly theaterPath: string | null;
  readonly summary: ConsoleCommodoreSummary;
}

export interface CommandBoardSectionBucket {
  readonly id: string | null | undefined;
  readonly name: string | null;
  readonly commodores: readonly CommandBoardCommodore[];
}

export interface CommandBoardCardItem {
  readonly id: string;
  readonly commodoreId: string;
  readonly title: string;
  readonly note: string;
  readonly column: CommandBoardColumnId;
  readonly due: { readonly date: string; readonly overdue: boolean } | null;
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly doneAt: number | null;
  readonly updatedAt: number;
  readonly hasSession: boolean;
  readonly needsAttention: boolean;
  readonly reviewNote: string | null;
  readonly activityLine: string | null;
  readonly mongleState: MongleState;
  readonly objective: Objective;
  readonly cluster: ObjectiveCluster | null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 목표를 4열(시작 전 · 진행 중 · 검토 대기 · 완료) 중 하나로 분류한다. */
export function classifyObjectiveColumn(objective: Objective, cluster: ObjectiveCluster | null, hasLiveRecord: boolean): CommandBoardColumnId {
  if (objective.done !== null) return "done";
  const holds = livePersonHolds(objective);
  if (objective.awaitingReview || cluster?.row?.glyph === "review" || holds.length > 0 || cluster?.row?.personTurnAt !== undefined) {
    return "review";
  }
  const hasSession = objective.hasSession === true || hasLiveRecord;
  if (!objective.commander.started && !hasSession) return "fresh";
  return "active";
}

function compareCards(a: CommandBoardCardItem, b: CommandBoardCardItem): number {
  if (a.column === "done" && b.column === "done") {
    return (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt);
  }
  const aOverdue = a.due?.overdue === true;
  const bOverdue = b.due?.overdue === true;
  if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
  if (a.due && b.due && a.due.date !== b.due.date) return a.due.date.localeCompare(b.due.date);
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  return b.updatedAt - a.updatedAt;
}

export function formatShortDueDate(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

export function formatRelativeTime(timestamp: number, language: "en" | "ko"): string {
  const diffMs = Math.max(0, Date.now() - timestamp);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return language === "ko" ? "방금" : "Just now";
  if (mins < 60) return language === "ko" ? `${mins}분 전` : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return language === "ko" ? `${hours}시간 전` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return language === "ko" ? `${days}일 전` : `${days}d ago`;
}

export function formatDoneStamp(timestamp: number, language: "en" | "ko"): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) {
    const time = date.toLocaleTimeString(language === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return language === "ko" ? `오늘 ${time}` : `Today ${time}`;
  }
  return formatRelativeTime(timestamp, language);
}

/** 사령관 목록의 보드를 모두 적재하고, 4열 지휘판에 필요한 모든 사령관·목표를 단일 스냅샷으로 엮는다. */
export function useCommandBoardData(hydrate = true): {
  readonly commodores: readonly CommandBoardCommodore[];
  readonly sectionBuckets: readonly CommandBoardSectionBucket[];
  readonly items: readonly CommandBoardCardItem[];
  readonly counts: { readonly fresh: number; readonly active: number; readonly review: number; readonly done: number; readonly overdue: number; readonly totalOpen: number };
} {
  const t = useT();
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const rawCommodores = useCommodoreList();
  const sidebarOrder = useSidebarOrder();
  const sidebarLayout = useCommodoreSidebarLayout();
  const objectives = useAllObjectives();
  const clusterIndex = useClusterIndex();
  const consoleState = useConsoleState();

  // 지휘판이 열리면 모든 사령관의 보드를 한 번씩 적재해 시작 전·완료 목표가 빠지지 않게 한다.
  useEffect(() => {
    if (!hydrate) return;
    const api = objectivesApi();
    if (!api) return;
    for (const row of rawCommodores) {
      void loadBoard(api, row.commodoreId);
    }
  }, [hydrate, rawCommodores]);

  const commodores = useMemo<readonly CommandBoardCommodore[]>(() => {
    const rank = (id: string) => {
      const index = sidebarOrder.indexOf(id);
      return index === -1 ? sidebarOrder.length : index;
    };
    const sectionNameMap = new Map(sidebarLayout.sections.map((section) => [section.id, section.name]));
    const fallbackName = t("sidebar.commodore.fallback");
    return [...rawCommodores]
      .sort((left, right) => rank(left.commodoreId) - rank(right.commodoreId))
      .map((row) => {
        const sectionId = sidebarLayout.membership[row.commodoreId] ?? null;
        const firstTheater = row.theaters.find((theater) => theater.status === "available") ?? row.theaters[0] ?? null;
        return {
          id: row.commodoreId,
          name: commodoreSectionLabel(row, fallbackName),
          sectionId,
          sectionName: sectionId ? sectionNameMap.get(sectionId) ?? null : null,
          autonomous: row.active,
          running: row.run.phase === "turn",
          theaterPath: firstTheater?.label ?? null,
          summary: row,
        };
      });
  }, [rawCommodores, sidebarLayout, sidebarOrder, t]);

  const sectionBuckets = useMemo<readonly CommandBoardSectionBucket[]>(() => {
    const rawBuckets = commodoreSidebarBuckets(sidebarLayout, commodores, (item) => item.id);
    const sectionNameMap = new Map(sidebarLayout.sections.map((section) => [section.id, section.name]));
    return rawBuckets.map((bucket) => ({
      id: bucket.id,
      name: bucket.id === undefined ? null : bucket.id === null ? t("sidebar.commodoreSection.none") : sectionNameMap.get(bucket.id) ?? null,
      commodores: bucket.rows,
    }));
  }, [commodores, sidebarLayout, t]);

  const items = useMemo<readonly CommandBoardCardItem[]>(() => {
    const commodoreIds = new Set(commodores.map((c) => c.id));
    const recordsById = new Map(consoleState.objectiveRecords.map((record) => [record.id, record]));
    const clusterByObjectiveId = new Map<string, ObjectiveCluster>();
    for (const cluster of clusterIndex.clusters) {
      const key = cluster.root ?? cluster.avatarObjectiveId;
      if (key) clusterByObjectiveId.set(key, cluster);
    }
    const today = todayIso();
    const out: CommandBoardCardItem[] = [];

    for (const objective of objectives) {
      if (!commodoreIds.has(objective.commodoreId)) continue;
      const cluster = clusterByObjectiveId.get(objective.id) ?? null;
      const record = recordsById.get(objective.id) ?? null;
      const column = classifyObjectiveColumn(objective, cluster, record !== null);
      const doneMissions = objective.missions.filter((mission) => mission.done).length;
      const totalMissions = objective.missions.length;
      const overdue = column !== "done" && !!objective.dueDate && objective.dueDate < today;
      const due = column !== "done" && objective.dueDate ? { date: objective.dueDate, overdue } : null;

      const holds = livePersonHolds(objective);
      const followups = openFollowups(objective).length;
      let reviewNote: string | null = null;
      if (column === "review") {
        if (holds.length > 0 && holds[0]?.reason) reviewNote = holds[0].reason;
        else if (followups > 0) reviewNote = language === "ko" ? `검토 대기 · 후속 후보 ${followups}건` : `Awaiting review · ${followups} follow-ups`;
        else reviewNote = t("commanderTab.status.review");
      }

      const recordActivity = record ? resolveObjectiveActivity(record, consoleState.objectiveRecordRuntime) : null;
      let mongleState: MongleState = "idle";
      let activityLine: string | null = null;
      if (column === "fresh") {
        mongleState = "fresh";
      } else if (column === "done") {
        mongleState = "done";
      } else if (column === "review") {
        mongleState = "review";
      } else {
        if (recordActivity === "awaiting") {
          mongleState = "awaiting";
          activityLine = t("commanderTab.status.awaiting");
        } else if (recordActivity === "running") {
          mongleState = "running";
          activityLine = t("cluster.picker.activity.running");
        } else if (objective.awaitingHandoff) {
          mongleState = "idle";
          activityLine = language === "ko" ? "임무 완료 · 인계 대기" : "Missions done · awaiting hand-off";
        } else {
          mongleState = "idle";
          activityLine = t("cluster.picker.activity.idle");
        }
      }

      const needsAttention = column === "review" || overdue || recordActivity === "awaiting" || objective.awaitingHandoff;
      out.push({
        id: objective.id,
        commodoreId: objective.commodoreId,
        title: objective.title,
        note: objective.note.trim(),
        column,
        due,
        progress: totalMissions > 0 ? { done: doneMissions, total: totalMissions } : null,
        doneAt: objective.done?.at ?? null,
        updatedAt: objective.boardUpdatedAt ?? objective.createdAt,
        hasSession: objective.hasSession === true || record !== null,
        needsAttention,
        reviewNote,
        activityLine,
        mongleState,
        objective,
        cluster,
      });
    }

    return out.sort(compareCards);
  }, [clusterIndex.clusters, commodores, consoleState.objectiveRecordRuntime, consoleState.objectiveRecords, language, objectives, t]);

  const counts = useMemo(() => {
    let fresh = 0;
    let active = 0;
    let review = 0;
    let done = 0;
    let overdue = 0;
    for (const item of items) {
      if (item.column === "fresh") fresh += 1;
      else if (item.column === "active") active += 1;
      else if (item.column === "review") review += 1;
      else done += 1;
      if (item.due?.overdue) overdue += 1;
    }
    return { fresh, active, review, done, overdue, totalOpen: fresh + active + review };
  }, [items]);

  return { commodores, sectionBuckets, items, counts };
}

/** 좌측 사이드바 고정 행이 쓰는 가벼운 카운트 요약(별도 강제 fetch 없이 로드된 보드 상태를 구독). */
export function useCommandBoardCounts() {
  return useCommandBoardData(false).counts;
}

/** 단일 목표를 @참조로 붙여 소유 사령관에게 지시를 전송한다. */
export async function dispatchObjectivePrompt(commodoreId: string, objectiveId: string, rawText: string): Promise<void> {
  const clean = rawText.split(CONVERSATION_REFERENCE_MARK).join("").trim();
  if (!clean) throw new Error("empty_prompt");
  await messageCommodore(commodoreId, `${CONVERSATION_REFERENCE_MARK} ${clean}`, undefined, [objectiveId]);
}

/** 완료 목표 여러 건을 사령관별로 묶어 참조 상한(MAX_COMMODORE_REFERENCES) 단위로 정리 지시를 전송한다. */
export async function dispatchBatchDonePrompt(items: readonly CommandBoardCardItem[], rawText: string): Promise<number> {
  const clean = rawText.split(CONVERSATION_REFERENCE_MARK).join("").trim();
  if (!clean) throw new Error("empty_prompt");
  const byCommodore = new Map<string, CommandBoardCardItem[]>();
  for (const item of items) {
    const list = byCommodore.get(item.commodoreId) ?? [];
    list.push(item);
    byCommodore.set(item.commodoreId, list);
  }
  for (const [commodoreId, group] of byCommodore) {
    for (let offset = 0; offset < group.length; offset += MAX_COMMODORE_REFERENCES) {
      const chunk = group.slice(offset, offset + MAX_COMMODORE_REFERENCES);
      const marks = chunk.map(() => CONVERSATION_REFERENCE_MARK).join(" ");
      await messageCommodore(commodoreId, `${marks} ${clean}`, undefined, chunk.map((item) => item.id));
    }
  }
  return byCommodore.size;
}
