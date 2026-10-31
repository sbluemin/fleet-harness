import { z } from "zod";

import type { Objective, Retrospective } from "../shared/types.js";

/**
 * 보드 검색 — 사령관(`fleet-commodore` objectives search)과 지휘관(`fleet-objectives` search)이 같은 입력과 같은 함수로 부른다.
 * 원본은 한 사령관의 목표 기록(보관 포함, 정리된 목표 제외)이고, 범위는 호출하는 도구가 정한 사령관 하나다.
 * 단어는 모두(AND) 부분 문자열로 들어 있어야 하며, 목표 하나에 대표 칸 하나를 최신순·결정적으로 돌려준다. 자세한 것은 read 로 읽는다.
 */

export const SEARCH_PARTS = ["title", "brief", "mission", "criteria", "decision", "remark", "handoff", "ref", "followup"] as const;
export type SearchPart = typeof SEARCH_PARTS[number];
/** 동률인 대표 칸을 고르는 순서 — 결정·회고처럼 짧고 판단이 담긴 칸이 긴 브리핑보다 앞선다. */
const PART_PRIORITY: readonly SearchPart[] = ["title", "decision", "handoff", "criteria", "mission", "remark", "ref", "followup", "brief"];
export const SEARCH_STATUSES = ["open", "done", "archived", "any"] as const;
type SearchStatus = Exclude<typeof SEARCH_STATUSES[number], "any">;

const SNIPPET = 160;
const RESPONSE_BYTES = 8_000;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 두 도구가 그대로 싣는 입력 모양. 범위(사령관)는 입력이 아니라 도구가 정한다. */
export const searchInputShape = {
  query: z.string().trim().min(1).max(200).describe("Words, all required (AND), each matched as a case-insensitive substring."),
  parts: z.array(z.enum(SEARCH_PARTS)).min(1).max(SEARCH_PARTS.length).optional().describe("Omitted, all. remark: plan/extension context, hand-to-person reasons. ref: PR, artifact, evidence results."),
  status: z.enum(SEARCH_STATUSES).optional().describe("open: not done, not archived. Default any, archived included."),
  since: day.optional().describe("YYYY-MM-DD, inclusive, on each objective's last-updated date (UTC)."),
  until: day.optional().describe("YYYY-MM-DD, inclusive."),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().regex(/^\d{1,6}$/).optional().describe("nextCursor from the previous page of the same search."),
};
const searchInput = z.object(searchInputShape);
export type SearchInput = z.output<typeof searchInput>;

interface Cell { readonly part: SearchPart; readonly where: string; readonly text: string; readonly at: number }

export interface SearchHit {
  readonly objectiveId: string;
  readonly title: string;
  readonly status: SearchStatus;
  readonly date: string;
  readonly part: SearchPart;
  readonly where: string;
  readonly snippet: string;
  readonly matchedParts: readonly SearchPart[];
  readonly prs: readonly { readonly number: number; readonly url: string }[];
}

export interface SearchPage {
  readonly query: string;
  readonly total: number;
  readonly hits: readonly SearchHit[];
  readonly nextCursor: string | null;
}

const fold = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US");
const statusOf = (objective: Objective): SearchStatus => objective.archived ? "archived" : objective.done ? "done" : "open";
const updatedAt = (objective: Objective) => objective.boardUpdatedAt ?? objective.done?.at ?? objective.createdAt;
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** 목표 하나의 검색 칸 — 저장된 값 하나가 칸 하나다. 시각이 없는 칸은 목표의 시각을 쓴다. */
function cellsOf(objective: Objective): readonly Cell[] {
  const at = updatedAt(objective);
  const cells: Cell[] = [];
  const add = (part: SearchPart, where: string, value: string | null | undefined, when = at) => { if (value?.trim()) cells.push({ part, where, text: value, at: when }); };
  add("title", "title", objective.title);
  add("brief", "brief", objective.note);
  objective.missions.forEach((mission, index) => {
    const where = `mission ${index + 1}`;
    add("mission", where, [mission.title, mission.text].filter(Boolean).join(" — "));
    for (const record of mission.records) add("mission", `${where} record`, record.lines.join("\n"), record.at);
  });
  objective.criteria.forEach((criterion, index) => {
    add("criteria", `criterion ${index + 1}`, criterion.text);
    add("criteria", `criterion ${index + 1} evidence`, criterion.met);
  });
  for (const proposal of objective.criteriaProposals) add("criteria", "criterion proposal", proposal.text ?? proposal.reason);
  for (const decision of objective.decisions) {
    const chosen = decision.question.options.filter((option) => decision.answer.selectedOptionIds.includes(option.id)).map((option) => option.label);
    add("decision", "decision", [decision.question.header, decision.question.text, chosen.length ? `→ ${chosen.join(", ")}` : null, decision.answer.text || null].filter(Boolean).join(" "), decision.at);
  }
  add("remark", "plan request", objective.planRequest);
  for (const round of objective.extensions) add("remark", `extension ${round.n}`, round.context, round.at);
  for (const hold of objective.personHolds) add("remark", `hand to person (${hold.target})`, hold.reason, hold.at);
  add("remark", "removal reason", objective.removed?.reason);
  const retrospective = (where: string, handoff: { readonly at: number; readonly retrospective?: Retrospective | null } | null | undefined) => {
    if (!handoff?.retrospective) return;
    const { wentWell, fellShort } = handoff.retrospective;
    add("handoff", where, [...wentWell.map((pair) => `${pair.point} — ${pair.because}`), ...fellShort.map((pair) => `${pair.point} — ${pair.ifOnly}`)].join("\n"), handoff.at);
  };
  retrospective("handoff", objective.handoff);
  for (const round of objective.extensions) retrospective(`handoff before extension ${round.n}`, round.previousHandoff);
  for (const result of objective.results) {
    const ref = result.kind === "pr" ? `PR #${result.number} ${result.url}` : result.kind === "artifact" ? result.url : result.name;
    add("ref", result.kind, [ref, result.label, result.note].filter(Boolean).join(" "), result.createdAt);
  }
  for (const followup of objective.followups) add("followup", "followup", [followup.title, followup.summary, followup.userImpact, followup.brief].filter(Boolean).join(" — "));
  return cells;
}

/** 첫 일치 주변 — 앞을 조금 남겨 문맥을 보이고, 줄바꿈은 공백으로 편다. */
function snippetOf(text: string, terms: readonly string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const folded = fold(flat);
  const first = Math.min(...terms.map((term) => folded.indexOf(term)).filter((index) => index >= 0));
  // NFKC 가 길이를 바꾼 칸은 위치가 어긋날 수 있다 — 그때는 앞에서부터 보인다.
  const anchor = Number.isFinite(first) && folded.length === flat.length ? first : 0;
  const start = Math.max(0, Math.min(anchor - 40, flat.length - SNIPPET));
  // 대리 쌍의 반쪽으로 끝나거나 시작하지 않게 경계를 한 칸 안쪽으로 당긴다.
  const body = flat.slice(start, start + SNIPPET).replace(/^[\udc00-\udfff]|[\ud800-\udbff]$/g, "");
  return `${start > 0 ? "…" : ""}${body}${start + SNIPPET < flat.length ? "…" : ""}`;
}

/** 일치하는 목표마다 대표 칸 하나. 대표: 맞은 단어 수 → 부분 우선순위 → 칸 시각 최신 → 원본 순서. */
function hitOf(objective: Objective, terms: readonly string[], parts: ReadonlySet<SearchPart>): SearchHit | null {
  const cells = cellsOf(objective).filter((cell) => parts.has(cell.part));
  const folded = cells.map((cell) => fold(cell.text));
  if (!terms.every((term) => folded.some((value) => value.includes(term)))) return null;
  let best = -1, bestScore = 0;
  const matchedParts = new Set<SearchPart>();
  cells.forEach((cell, index) => {
    const score = terms.filter((term) => folded[index]!.includes(term)).length;
    if (!score) return;
    matchedParts.add(cell.part);
    const current = cells[best];
    const better = score > bestScore || (score === bestScore && current !== undefined && (PART_PRIORITY.indexOf(cell.part) < PART_PRIORITY.indexOf(current.part)
      || (cell.part === current.part && cell.at > current.at)));
    if (best < 0 || better) { best = index; bestScore = score; }
  });
  const cell = cells[best]!;
  return {
    objectiveId: objective.id, title: objective.title, status: statusOf(objective), date: dayOf(updatedAt(objective)),
    part: cell.part, where: cell.where, snippet: snippetOf(cell.text, terms),
    matchedParts: PART_PRIORITY.filter((part) => matchedParts.has(part)),
    prs: objective.results.flatMap((result) => result.kind === "pr" ? [{ number: result.number, url: result.url }] : []),
  };
}

/** 한 사령관의 목표 기록을 찾는다. 호출자가 그 사령관의 목표만 넘긴다 — 이 함수는 범위를 넓히지 않는다. */
export function searchObjectives(objectives: readonly Objective[], input: SearchInput): SearchPage {
  // 받은 단어는 모두 맞춘다 — 단어 수는 query 길이(200자)가 묶는다.
  const terms = [...new Set(fold(input.query).split(/\s+/).filter(Boolean))];
  const parts = new Set<SearchPart>(input.parts ?? SEARCH_PARTS);
  const status = input.status ?? "any";
  const matched = objectives
    .filter((objective) => !objective.removed && (status === "any" || statusOf(objective) === status))
    .filter((objective) => { const date = dayOf(updatedAt(objective)); return (!input.since || date >= input.since) && (!input.until || date <= input.until); })
    .sort((a, b) => updatedAt(b) - updatedAt(a) || a.id.localeCompare(b.id))
    .flatMap((objective) => { const hit = hitOf(objective, terms, parts); return hit ? [hit] : []; });
  const offset = Math.min(Number(input.cursor ?? 0), matched.length);
  const limit = input.limit ?? 10;
  const hits: SearchHit[] = [];
  const frame = (entries: readonly SearchHit[]): SearchPage => ({ query: input.query, total: matched.length, hits: entries, nextCursor: offset + entries.length < matched.length ? String(offset + entries.length) : null });
  for (const hit of matched.slice(offset, offset + limit)) {
    const next = frame([...hits, hit]);
    // 대표 칸 하나는 조각 길이로 묶여 예산 안에 든다 — 넘치면 다음 쪽으로 미룬다.
    if (hits.length && Buffer.byteLength(JSON.stringify(next), "utf8") > RESPONSE_BYTES) break;
    hits.push(hit);
  }
  return frame(hits);
}
