import { createHash } from "node:crypto";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import type { Objective } from "./types.js";
import { createBoardViews } from "./views.js";

/** 토큰 수의 환산값이 아니라 파일 fallback을 피하기 위한 Console 도구의 직렬화 예산이다. */
const RESPONSE_BYTES = 8_000;
export const OBJECTIVE_READ_SECTIONS = ["objective", "brief", "criteria", "missions", "members", "decisionRequest", "decisions", "handoffs", "extensions", "actions", "followups", "criteriaProposals", "followupBatches", "sessions"] as const;
export type ObjectiveReadSection = typeof OBJECTIVE_READ_SECTIONS[number];
type Row = Record<string, unknown> & { readonly id: string; readonly title: string };
const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8") <= RESPONSE_BYTES;
const splitsPair = (value: string, offset: number) => offset > 0 && offset < value.length
  && value.charCodeAt(offset - 1) >= 0xd800 && value.charCodeAt(offset - 1) <= 0xdbff
  && value.charCodeAt(offset) >= 0xdc00 && value.charCodeAt(offset) <= 0xdfff;
const preview = (value: string, limit: number) => value.slice(0, splitsPair(value, limit) ? limit - 1 : limit);

/** 큰 행 하나도 읽을 수 있다. 생략 표시와 상세 입구를 남겨 다음 행으로의 진행을 막지 않는다. */
function compactRow(row: Row): Row {
  const keys = ["id", "title", "operation", "done", "awaitingHandoff", "awaitingReview", "dueDate", "today", "missions", "mode", "operator", "removed", "mergedInto", "criteriaCount", "criteriaMet", "decisionRequested", "failedMembers", "reasons", "self"];
  return { ...Object.fromEntries(keys.filter((key) => key in row).map((key) => [key, row[key]])), id: row.id, title: row.title, rowTruncated: true, detailSection: "objective" };
}

/** 행 개수와 전체 JSON 바이트를 함께 제한한다. nextOffset은 실제 반환한 행 수로만 전진한다. */
export function consoleObjectivePage(rows: readonly Row[], options: { readonly theaterId: string; readonly offset?: number; readonly limit?: number; readonly today?: string }) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  const objectives: Row[] = [];
  const frame = (entries: readonly Row[]) => ({ theaterId: options.theaterId, ...(options.today ? { today: options.today } : {}), total: rows.length, offset,
    nextOffset: offset + entries.length < rows.length ? offset + entries.length : null, objectives: entries });
  for (const row of rows.slice(offset, offset + limit)) {
    if (fits(frame([...objectives, row]))) { objectives.push(row); continue; }
    if (objectives.length) break;
    const compact = compactRow(row);
    if (!fits(frame([compact]))) throw new ObjectiveStoreError("response_budget_exceeded");
    objectives.push(compact);
  }
  return frame(objectives);
}

/** Console 도구에만 쓰는 뷰. 사람 HTTP/SSE와 지휘관·구성원의 read/mine은 원래 보드를 보존한다. */
export function createConsoleBoardViews(ctx: FleetPluginServerContext, store: ObjectiveStore) {
  const views = createBoardViews(ctx, store);
  const counts = (objective: Objective) => ({ criteriaCount: objective.criteria.length, criteriaMet: objective.criteria.filter((criterion) => !!criterion.met).length,
    decisionRequested: !!objective.decisionRequest, failedMembers: objective.members.filter((member) => member.outcome === "failed" || !!member.failure).length });
  const rowView = (objective: Objective): Row => {
    const { criteria: _criteria, brief: _brief, briefTruncated: _truncated, ...row } = views.rowView(objective);
    return { ...row, ...counts(objective), ...(objective.note ? { brief: preview(objective.note, 120), briefTruncated: objective.note.length > 120 } : {}) };
  };
  const historyView = (objective: Objective): Row => {
    const history = views.historyView(objective);
    return { ...rowView(objective), completed: objective.done, boardUpdatedAt: objective.boardUpdatedAt,
      handoffCount: history.handoffs.length, handoffs: history.handoffs.slice(-1).map((handoff) => ({ by: handoff.by, at: handoff.at, hasRetrospective: "retrospective" in handoff && !!handoff.retrospective })),
      decisionCount: objective.decisions.length, extensionCount: objective.extensions.length, actionCounts: objective.actionCounts,
      reopenCount: history.reopenCount, rework: history.rework };
  };
  const detailRead = (objective: Objective, section?: ObjectiveReadSection, givenOffset = 0) => {
    const full = { ...views.objectiveView(objective), decisionRequest: objective.decisionRequest };
    if (!section) {
      if (givenOffset) throw new ObjectiveStoreError("section_required");
      const complete = { objective: { ...full, ...counts(objective) }, sections: OBJECTIVE_READ_SECTIONS };
      if (fits(complete)) return complete;
      const summary = { objective: { ...compactRow(rowView(objective)), theaterId: objective.theaterId, boardUpdatedAt: objective.boardUpdatedAt,
        graph: { commander: full.graph.commander }, decisionRequestRevision: objective.decisionRequestRevision,
        criteriaProposalsCount: objective.criteriaProposals.length, followupCount: objective.followups.length, detailTruncated: true }, sections: OBJECTIVE_READ_SECTIONS };
      if (!fits(summary)) throw new ObjectiveStoreError("response_budget_exceeded");
      return summary;
    }
    let value: unknown;
    switch (section) {
      case "objective": value = full; break;
      case "brief": value = objective.note; break;
      case "missions": value = full.graph.missions; break;
      case "decisionRequest": value = objective.decisionRequest; break;
      case "handoffs": value = views.historyView(objective).handoffs; break;
      case "sessions": value = views.sessions(objective); break;
      default: value = full[section as keyof typeof full] ?? []; break;
    }
    const source = section === "brief" ? objective.note : JSON.stringify(value);
    if (splitsPair(source, givenOffset)) throw new ObjectiveStoreError("invalid_offset");
    const revision = createHash("sha256").update(source).digest("hex");
    const frame = (end: number) => ({ objectiveId: objective.id, section, format: section === "brief" ? "text" : "json", revision,
      text: source.slice(givenOffset, end), offset: givenOffset, totalCharacters: source.length, nextOffset: end < source.length ? end : null });
    // JSON escape 이후의 바이트 수로 자른다. 탐색 중 UTF-16 위치는 마지막에 문자 경계로 돌린다.
    let low = Math.min(givenOffset, source.length), high = source.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(frame(middle))) low = middle;
      else high = middle - 1;
    }
    const end = splitsPair(source, low) ? low - 1 : low;
    if (!fits(frame(end)) || (givenOffset < source.length && end <= givenOffset)) throw new ObjectiveStoreError("response_budget_exceeded");
    return frame(end);
  };
  return { rowView, historyView, detailRead };
}
