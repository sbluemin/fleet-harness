import { z } from "zod";

import type { Objective } from "./types.js";

/**
 * 지난 역할 — 한 Theater 의 목표들에서 구성원이 맡았던 역할과 그 사실(쓰인 목표 수·임무·인계 평가).
 * 저장하지 않고 읽을 때 목표들에서 파생한다. 서버(빈 명단 지휘관의 보드 보기)와 화면(명단의 「지난 역할」)이 같은 함수를 쓴다.
 * 목표 제목·기록 원문·구성원 설명·모델은 싣지 않는다 — 다른 목표에서 넘어오는 것은 역할 이름과 숫자, 평가 한 줄뿐이다.
 *
 * 사람의 정리(`RoleCuration`)만 Theater 에 저장한다: 숨긴 역할과 합친 역할(이 이름 → 저 이름).
 */

export const MAX_ROLE_NAME = 40;
/** 평가 한 줄 — 회고 칸과 같은 한도. */
export const MAX_RATING_NOTE = 100;
/** 역할마다 싣는 최근 평가 줄 수. */
export const ROLE_NOTES = 5;
/** 사람의 정리 항목 상한 — 숨김·합침 각각. */
export const MAX_CURATION = 200;
export const ROLES_FILE = "roles.json";

export type RatingValue = "well" | "short";

/** 인계 때 지휘관이 구성원 하나에 남긴 평가. role 은 그때의 역할 이름, as 는 지난 역할 목록에서 묶일 이름(역할과 다를 때만). */
export interface MemberRating {
  readonly memberId: string;
  readonly role: string;
  readonly as?: string;
  readonly rating: RatingValue;
  readonly note: string;
}

/** 사람의 정리 — 숨긴 역할 이름, 합친 역할(이 이름 → 저 이름). */
export interface RoleCuration {
  readonly hidden: readonly string[];
  readonly merged: Readonly<Record<string, string>>;
}

export const EMPTY_CURATION: RoleCuration = { hidden: [], merged: {} };

export interface PastRole {
  readonly role: string;
  /** 이 역할로 묶인 다른 이름들(역할 이름·평가의 as·사람이 합친 이름). */
  readonly aliases: readonly string[];
  readonly objectives: number;
  readonly members: number;
  /** 한 목표에서 같은 역할로 세어진(끝낸 임무나 평가가 있는) 구성원 수의 최대. */
  readonly maxParallel: number;
  readonly missions: { readonly assigned: number; readonly done: number };
  readonly well: number;
  readonly short: number;
  /** 최근 평가 줄 — 새것부터. */
  readonly notes: readonly { readonly rating: RatingValue; readonly note: string }[];
  readonly hidden: boolean;
  /** 가장 최근에 쓰인 목표의 시각(인계 시각, 없으면 목표를 만든 시각). */
  readonly lastAt: number;
}

const roleName = z.string().trim().min(1).max(MAX_ROLE_NAME);
const oneLine = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\r\n]/.test(value), { message: "one_line" });

/** hand_off 의 평가 입력 — 구성원은 id 또는 역할 이름으로 가리킨다. */
export const memberRatingInputSchema = z.object({
  member: z.string().trim().min(1).max(128),
  rating: z.enum(["well", "short"]),
  note: oneLine(MAX_RATING_NOTE),
  as: roleName.optional(),
}).strict();
export const memberRatingsSchema = z.array(memberRatingInputSchema).max(40);

export const roleCurateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hide"), role: roleName }).strict(),
  z.object({ kind: z.literal("show"), role: roleName }).strict(),
  z.object({ kind: z.literal("merge"), role: roleName, into: roleName }).strict(),
  z.object({ kind: z.literal("unmerge"), role: roleName }).strict(),
]);
export type RoleCurateInput = z.output<typeof roleCurateSchema>;

/** 저장된 정리를 읽는다 — 모양이 어긋난 항목은 버린다(파일 전체를 버리지 않는다). */
export function parseCuration(raw: unknown): RoleCuration {
  if (!raw || typeof raw !== "object") return EMPTY_CURATION;
  const value = raw as { hidden?: unknown; merged?: unknown };
  const name = (entry: unknown): string | null => { const parsed = roleName.safeParse(entry); return parsed.success ? parsed.data : null; };
  const hidden = Array.isArray(value.hidden) ? [...new Set(value.hidden.map(name).filter((entry): entry is string => entry !== null))].slice(0, MAX_CURATION) : [];
  const merged: Record<string, string> = {};
  if (value.merged && typeof value.merged === "object" && !Array.isArray(value.merged)) {
    for (const [rawFrom, rawInto] of Object.entries(value.merged as Record<string, unknown>).slice(0, MAX_CURATION)) {
      const from = name(rawFrom);
      const into = name(rawInto);
      if (from && into && from !== into) merged[from] = into;
    }
  }
  return { hidden, merged };
}

/** 합침을 따라간 최종 이름 — 고리가 있으면 처음 돌아온 자리에서 멈춘다. */
export function resolveRole(curation: RoleCuration, name: string): string {
  const seen = new Set<string>();
  let current = name;
  while (Object.hasOwn(curation.merged, current) && !seen.has(current)) {
    seen.add(current);
    current = curation.merged[current]!;
  }
  return current;
}

/** 정리 한 건을 적용한 새 정리. 합침이 고리를 만들거나 자기 자신을 가리키면 null. */
export function curate(curation: RoleCuration, input: RoleCurateInput): RoleCuration | null {
  const hidden = new Set(curation.hidden);
  const merged = { ...curation.merged };
  if (input.kind === "hide") hidden.add(input.role);
  else if (input.kind === "show") hidden.delete(input.role);
  else if (input.kind === "unmerge") delete merged[input.role];
  else {
    if (input.role === input.into || resolveRole(curation, input.into) === input.role) return null;
    merged[input.role] = input.into;
    // 합친 이름은 합쳐진 쪽의 숨김을 따른다 — 제 숨김 표시는 거둔다.
    hidden.delete(input.role);
  }
  if (hidden.size > MAX_CURATION || Object.keys(merged).length > MAX_CURATION) return null;
  return { hidden: [...hidden], merged };
}

type RatingShape = { memberId?: unknown; role?: unknown; as?: unknown; rating?: unknown; note?: unknown };
/** 목표의 인계 평가 — 저장된 모양을 믿지 않고 한 건씩 확인한다. */
function ratingsOf(objective: Pick<Objective, "handoff">): ReadonlyMap<string, Pick<MemberRating, "as" | "rating" | "note"> & { readonly role?: string }> {
  const raw = (objective.handoff as { ratings?: unknown } | null)?.ratings;
  const map = new Map<string, Pick<MemberRating, "as" | "rating" | "note"> & { readonly role?: string }>();
  if (!Array.isArray(raw)) return map;
  for (const entry of raw as RatingShape[]) {
    if (!entry || typeof entry.memberId !== "string" || (entry.rating !== "well" && entry.rating !== "short") || typeof entry.note !== "string") continue;
    map.set(entry.memberId, { rating: entry.rating, note: entry.note, ...(typeof entry.role === "string" && entry.role.trim() ? { role: entry.role.trim() } : {}), ...(typeof entry.as === "string" && entry.as.trim() ? { as: entry.as.trim() } : {}) });
  }
  return map;
}

/**
 * 지난 역할 — exclude(보고 있는 목표)를 뺀 목표들의 구성원을 역할별로 모은다. 끝낸 임무도 평가도 없는 구성원
 * (구상만 됐거나 아직 아무것도 끝내지 않은 명단)은 쓰인 것이 아니라서 세지 않는다. 숨긴 역할은 includeHidden 일 때만 hidden: true 로 싣는다.
 * 순서는 쓰인 목표 수, 평가(잘됨−아쉬움), 최근 사용, 이름.
 */
export function pastRoles(objectives: readonly Objective[], curation: RoleCuration, options: { readonly exclude?: string; readonly includeHidden?: boolean } = {}): readonly PastRole[] {
  type Acc = { role: string; aliases: Set<string>; objectives: Set<string>; members: number; maxParallel: number; assigned: number; done: number; well: number; short: number; notes: { rating: RatingValue; note: string; at: number }[]; lastAt: number };
  const roles = new Map<string, Acc>();
  const hidden = new Set(curation.hidden);
  for (const objective of objectives) {
    if (objective.id === options.exclude) continue;
    const ratings = ratingsOf(objective);
    const at = objective.handoff?.at ?? objective.createdAt;
    const parallel = new Map<string, number>();
    // 평가는 인계 때의 기록이다 — 그 뒤 사람이 구성원 이름을 바꾸거나 빼도(완료 전에는 둘 다 된다) 평가 당시의 역할로
    // 묶고, 빠진 구성원의 평가도 남긴다. 임무는 지금 명단에 남은 구성원만 잇는다(빠진 구성원의 임무는 지휘관 직접으로 돌아갔다).
    const people = [...objective.members.map((member) => ({ id: member.id, role: member.role })),
      ...[...ratings].flatMap(([id, rating]) => (rating.role && !objective.members.some((member) => member.id === id) ? [{ id, role: rating.role }] : []))];
    for (const member of people) {
      const missions = objective.missions.filter((mission) => mission.member === member.id);
      const rating = ratings.get(member.id);
      if (!rating && !missions.some((mission) => mission.done)) continue;
      const filed = rating?.as ?? rating?.role ?? member.role;
      const role = resolveRole(curation, filed);
      const entry = roles.get(role) ?? { role, aliases: new Set<string>(), objectives: new Set<string>(), members: 0, maxParallel: 1, assigned: 0, done: 0, well: 0, short: 0, notes: [], lastAt: 0 };
      for (const name of [member.role, filed]) if (name !== role) entry.aliases.add(name);
      entry.objectives.add(objective.id);
      entry.members += 1;
      entry.assigned += missions.length;
      entry.done += missions.filter((mission) => mission.done).length;
      if (rating) {
        if (rating.rating === "well") entry.well += 1; else entry.short += 1;
        entry.notes.push({ rating: rating.rating, note: rating.note, at });
      }
      entry.lastAt = Math.max(entry.lastAt, at);
      parallel.set(role, (parallel.get(role) ?? 0) + 1);
      roles.set(role, entry);
    }
    for (const [role, count] of parallel) { const entry = roles.get(role)!; entry.maxParallel = Math.max(entry.maxParallel, count); }
  }
  // 합친 이름은 쓰인 적이 없어도 합쳐진 쪽의 다른 이름으로 보인다 — 사람이 풀 수 있게.
  for (const from of Object.keys(curation.merged)) { const entry = roles.get(resolveRole(curation, from)); if (entry && from !== entry.role) entry.aliases.add(from); }
  return [...roles.values()]
    .filter((entry) => options.includeHidden || !hidden.has(entry.role))
    .map((entry): PastRole => ({
      role: entry.role, aliases: [...entry.aliases].sort(), objectives: entry.objectives.size, members: entry.members, maxParallel: entry.maxParallel,
      missions: { assigned: entry.assigned, done: entry.done }, well: entry.well, short: entry.short,
      notes: entry.notes.sort((a, b) => b.at - a.at).slice(0, ROLE_NOTES).map(({ rating, note }) => ({ rating, note })),
      hidden: hidden.has(entry.role), lastAt: entry.lastAt,
    }))
    .sort((a, b) => b.objectives - a.objectives || (b.well - b.short) - (a.well - a.short) || b.lastAt - a.lastAt || a.role.localeCompare(b.role));
}
