import { CONSOLE_ROSTER_MAX_COMMANDERS, CONSOLE_ROSTER_PREVIEW_MAX, type ConsoleRosterCommander, type ConsoleRosterRun } from "../../../protocol/desktop/console-section.js";

const CONTROL = /[\u0000-\u001f\u007f]/u;

/**
 * 사령관 사이드바 행의 최근 응답 한 줄(`transcriptLast(..., "commodore")`)에서
 * 명부 검증기가 거절하는 제어 문자만 뺀다. 줄바꿈 접기와 160자 절단은 그 출처가 이미 한다.
 */
export function consoleRosterPreview(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const line = text.replace(CONTROL, "").trim().slice(0, CONSOLE_ROSTER_PREVIEW_MAX);
  return line.length > 0 ? line : undefined;
}

/** 지휘관 제목 — 제어 문자를 공백으로 바꾸고 계약 길이(120)에 맞춘다. 비면 그 행은 내보내지 않는다. */
export function consoleRosterTitle(text: string): string {
  return text.replace(CONTROL, " ").trim().slice(0, 120);
}

/**
 * 지휘관 행의 한 낱말. 사람의 차례가 활동보다 먼저다(사이드바 마크의 awaiting 이 running 보다 급하다).
 * `awaiting` 은 답·허가를 기다리는 세션, `running`·`background` 는 일하는 세션이다.
 */
export function consoleRosterRun(personWaiting: boolean, activities: readonly (string | null | undefined)[]): ConsoleRosterRun {
  if (personWaiting) return "waiting";
  let working = false;
  for (const activity of activities) {
    if (activity === "awaiting") return "waiting";
    if (activity === "running" || activity === "background") working = true;
  }
  return working ? "working" : "quiet";
}

/**
 * 사이드바의 진행 중 구역 — 완료·보관·정리는 빠지고, 세션 없는 시작 전은 사람의 차례일 때만 남는다.
 * `fresh` 는 사이드바 글리프와 같다: 완료·검토 대기가 아니고 지휘관 세션을 한 번도 깨운 적이 없다.
 */
export function rosterCommanderIncluded(input: {
  readonly removed: boolean;
  readonly archived: boolean;
  readonly done: boolean;
  readonly fresh: boolean;
  readonly personWaiting: boolean;
}): boolean {
  if (input.removed || input.archived || input.done) return false;
  if (input.fresh && !input.personWaiting) return false;
  return true;
}

/** 정렬에 필요한 사실만. 목표 저장 모양은 조립부가 읽고 여기로 접는다. */
export interface RosterCommanderSource {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly activityAt: number;
  readonly dueDate: string | null;
  readonly order: number;
  readonly groupId: string | null;
  readonly done: number;
  readonly total: number;
  readonly run: ConsoleRosterRun;
  /** 사람의 답을 기다리는 줄 — 정렬의 answerFirst 가 이것을 맨 위에 둔다. */
  readonly waiting: boolean;
}

export interface RosterCommanderGroup {
  readonly id: string;
  readonly order: number;
  readonly createdAt: number;
}

/** 사이드바 정렬(`general.commanderSort`)과 같은 키. 없으면 최근 활동·답 대기 먼저·그룹 없음. */
export interface RosterSort {
  readonly key: "activity" | "progress" | "remaining" | "due" | "created" | "name" | "manual";
  readonly direction: "asc" | "desc";
  readonly answerFirst: boolean;
  readonly grouped: boolean;
}

export const ROSTER_SORT_DEFAULT: RosterSort = { key: "activity", direction: "desc", answerFirst: true, grouped: false };

function clampCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, 100_000);
}

function publishable(source: RosterCommanderSource): ConsoleRosterCommander | null {
  if (source.id.length === 0 || source.id.length > 128 || CONTROL.test(source.id)) return null;
  const title = consoleRosterTitle(source.title);
  if (!title) return null;
  if (source.run !== "working" && source.run !== "waiting" && source.run !== "quiet") return null;
  const total = clampCount(source.total);
  const done = Math.min(clampCount(source.done), total);
  return { id: source.id, title, done, total, run: source.run };
}

function sortValue(source: RosterCommanderSource, key: RosterSort["key"]): number | string | undefined {
  switch (key) {
    case "activity": return source.activityAt;
    case "progress": return source.total > 0 ? source.done / source.total : undefined;
    case "remaining": return source.total > 0 ? source.total - source.done : undefined;
    case "due": return source.dueDate ?? undefined;
    case "created": return source.createdAt;
    case "name": return source.title;
    case "manual": return source.order;
  }
}

function compareSources(left: RosterCommanderSource, right: RosterCommanderSource, sort: RosterSort): number {
  if (sort.answerFirst) {
    const waiting = Number(right.waiting) - Number(left.waiting);
    if (waiting !== 0) return waiting;
  }
  const sign = sort.direction === "asc" ? 1 : -1;
  const a = sortValue(left, sort.key);
  const b = sortValue(right, sort.key);
  if (a !== undefined && b !== undefined) {
    const order = typeof a === "string" || typeof b === "string" ? String(a).localeCompare(String(b)) : (a as number) - (b as number);
    if (order !== 0) return sign * order;
  } else if (a !== undefined || b !== undefined) return a === undefined ? 1 : -1;
  return right.activityAt - left.activityAt;
}

/** 그룹을 켜면 사이드바처럼 그룹 순서 안에 정렬된 줄을 넣고, 묶이지 않은 줄은 맨 뒤다. */
function orderSources(sources: readonly RosterCommanderSource[], groups: readonly RosterCommanderGroup[], sort: RosterSort): RosterCommanderSource[] {
  const sorted = [...sources].sort((left, right) => compareSources(left, right, sort));
  if (!sort.grouped) return sorted;
  const known = new Set(groups.map((group) => group.id));
  const orderedGroups = [...groups].sort((left, right) => left.order - right.order || left.createdAt - right.createdAt);
  const out: RosterCommanderSource[] = [];
  for (const group of orderedGroups) for (const source of sorted) if (source.groupId === group.id) out.push(source);
  for (const source of sorted) if (!source.groupId || !known.has(source.groupId)) out.push(source);
  return out;
}

/** 진행 중 지휘관을 사이드바 순서로, 계약 상한까지. 넘는 수는 `moreCommanders`. */
export function consoleRosterCommanders(
  sources: readonly RosterCommanderSource[],
  groups: readonly RosterCommanderGroup[],
  sort: RosterSort,
): { readonly commanders: readonly ConsoleRosterCommander[]; readonly moreCommanders: number } {
  const ranked = orderSources(sources, groups, sort).flatMap((source) => {
    const row = publishable(source);
    return row ? [row] : [];
  });
  return { commanders: ranked.slice(0, CONSOLE_ROSTER_MAX_COMMANDERS), moreCommanders: Math.max(0, ranked.length - CONSOLE_ROSTER_MAX_COMMANDERS) };
}
