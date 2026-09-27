/**
 * 후속 후보 — 서버 DTO(member-1 v1 확정)를 읽는 클라 전용 모양.
 *
 * 서버가 아직 필드를 주지 않으면(옛 서버) 빈 배열·null 로 읽혀 기존 띠·목록 그대로 둔다.
 * 선택은 완료를 누르기 전까지 서버에 보내지 않는 로컬 초안이라 탭 메모리에만 둔다(초안과 같은 규칙).
 * 호스트·플러그인 번들이 모듈을 따로 들고 있어도 되게 단일 진실이 아니라 탭 안 편의 상태로만 쓴다.
 */

import { useSyncExternalStore } from "react";

import type { Objective } from "../server/types.js";

export type FollowupState = "open" | "selected" | "discarded";

/**
 * 근거의 화면 모양 — 서버가 종류별 필드를 한 모양으로 펴서 준다(경로는 저장 때 이미 Theater 상대로 검사됐다).
 * 절대경로·홈·`..` 가 오면 그리지 않는다.
 */
export interface FollowupEvidence {
  readonly kind: "file" | "command" | "artifact";
  readonly path: string | null;
  readonly line: number | null;
  readonly text: string | null;
  readonly note: string | null;
}

export interface FollowupCandidate {
  readonly id: string;
  readonly rev: number;
  readonly state: FollowupState;
  readonly title: string;
  readonly summary: string;
  /** 사용자가 무엇을 다르게 겪는지 한 줄 — 폐기 흔적은 빈 문자열. */
  readonly userImpact: string;
  /** 이 후보를 낳은 임무 id — 그 임무가 지워졌으면 보드에 없을 수 있다. */
  readonly fromMission: string;
  readonly brief: string;
  readonly criteria: readonly string[];
  readonly evidence: readonly FollowupEvidence[];
  readonly at: number;
  readonly updatedAt: number;
  readonly batchId: string | null;
  /** 폐기 흔적 — 누가·언제. open·selected면 null 이다. */
  readonly discarded: { readonly at: number; readonly by: "human" } | null;
}

export type FollowupBatchItemState = "creating" | "confirming" | "created" | "failed" | "deleted" | "abandoned";

export interface FollowupBatchItem {
  readonly candidateId: string;
  readonly rev: number;
  readonly snapshot: {
    readonly title: string;
    readonly summary: string;
    readonly userImpact: string;
    readonly fromMission: string;
    readonly brief: string;
    readonly criteria: readonly string[];
    readonly evidence: readonly FollowupEvidence[];
  };
  readonly state: FollowupBatchItemState;
  readonly operationId: string | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly settledAt: number | null;
}

export interface FollowupBatch {
  readonly id: string;
  readonly at: number;
  readonly items: readonly FollowupBatchItem[];
}

export interface FollowupHistory {
  readonly batches: number;
  readonly created: number;
  readonly deleted: number;
  readonly abandoned: number;
}

export interface FollowupOrigin {
  readonly objectiveId: string;
  readonly title: string | null;
  readonly candidateId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function asEvidence(value: unknown): FollowupEvidence | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "file" && value.kind !== "command" && value.kind !== "artifact") return null;
  const path = typeof value.path === "string" ? value.path : null;
  // 저장소 상대 경로만 그린다 — 절대·홈·역슬래시·`..` 구간은 버린다.
  if ((value.kind === "file" || value.kind === "artifact") && (!path || /^[/~\\]/.test(path) || /^[A-Za-z]:/.test(path) || path.includes("\\") || path.split("/").some((segment) => segment === ".."))) return null;
  const text = typeof value.text === "string" ? value.text : null;
  if (value.kind === "command" && !text) return null;
  return {
    kind: value.kind,
    path: value.kind === "command" ? null : path,
    line: value.kind === "file" && typeof value.line === "number" ? value.line : null,
    text: value.kind === "command" ? text : null,
    note: typeof value.note === "string" ? value.note : null,
  };
}

function asCandidate(value: unknown): FollowupCandidate | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (value.state !== "open" && value.state !== "selected" && value.state !== "discarded") return null;
  const evidence = Array.isArray(value.evidence) ? value.evidence.map(asEvidence).filter((entry): entry is FollowupEvidence => entry !== null) : [];
  const discarded = isRecord(value.discarded) && typeof value.discarded.at === "number" ? { at: value.discarded.at, by: "human" as const } : null;
  return {
    id: value.id,
    rev: typeof value.rev === "number" ? value.rev : 1,
    state: value.state,
    title: asString(value.title),
    summary: asString(value.summary),
    userImpact: value.state === "discarded" ? "" : asString(value.userImpact),
    fromMission: asString(value.fromMission),
    brief: value.state === "discarded" ? "" : asString(value.brief),
    criteria: value.state === "discarded" ? [] : asStringArray(value.criteria),
    evidence: value.state === "discarded" ? [] : evidence,
    at: typeof value.at === "number" ? value.at : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : (typeof value.at === "number" ? value.at : 0),
    batchId: typeof value.batchId === "string" ? value.batchId : null,
    discarded,
  };
}

function asBatchItem(value: unknown): FollowupBatchItem | null {
  if (!isRecord(value)) return null;
  if (typeof value.candidateId !== "string" || !value.candidateId) return null;
  if (value.state !== "creating" && value.state !== "confirming" && value.state !== "created" && value.state !== "failed" && value.state !== "deleted" && value.state !== "abandoned") return null;
  const snapshot = isRecord(value.snapshot) ? value.snapshot : {};
  const evidence = Array.isArray(snapshot.evidence) ? snapshot.evidence.map(asEvidence).filter((entry): entry is FollowupEvidence => entry !== null) : [];
  return {
    candidateId: value.candidateId,
    rev: typeof value.rev === "number" ? value.rev : 1,
    snapshot: {
      title: asString(snapshot.title),
      summary: asString(snapshot.summary),
      userImpact: asString(snapshot.userImpact),
      fromMission: asString(snapshot.fromMission),
      brief: asString(snapshot.brief),
      criteria: asStringArray(snapshot.criteria),
      evidence,
    },
    state: value.state,
    operationId: typeof value.operationId === "string" ? value.operationId : null,
    error: typeof value.error === "string" ? value.error : null,
    attempts: typeof value.attempts === "number" ? value.attempts : 0,
    settledAt: typeof value.settledAt === "number" ? value.settledAt : null,
  };
}

function asBatch(value: unknown): FollowupBatch | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (!Array.isArray(value.items)) return null;
  const items = value.items.map(asBatchItem).filter((entry): entry is FollowupBatchItem => entry !== null);
  return { id: value.id, at: typeof value.at === "number" ? value.at : 0, items };
}

/** 서버가 주기 전에도 깨지지 않게 — 후보가 없으면 빈 배열이다. */
export function readFollowups(objective: Objective): readonly FollowupCandidate[] {
  const raw = (objective as unknown as { followups?: unknown }).followups;
  if (!Array.isArray(raw)) return [];
  return raw.map(asCandidate).filter((entry): entry is FollowupCandidate => entry !== null);
}

export function readBatches(objective: Objective): readonly FollowupBatch[] {
  const raw = (objective as unknown as { followupBatches?: unknown }).followupBatches;
  if (!Array.isArray(raw)) return [];
  return raw.map(asBatch).filter((entry): entry is FollowupBatch => entry !== null);
}

export function readHistory(objective: Objective): FollowupHistory | null {
  const raw = (objective as unknown as { followupHistory?: unknown }).followupHistory;
  if (!isRecord(raw)) return null;
  if (typeof raw.batches !== "number" || typeof raw.created !== "number" || typeof raw.deleted !== "number" || typeof raw.abandoned !== "number") return null;
  return { batches: raw.batches, created: raw.created, deleted: raw.deleted, abandoned: raw.abandoned };
}

/**
 * 후속으로 태어난 목표의 출처 — 원본 목표와 후보. 원본이 사라졌으면 title 은 null 이다.
 * 상세 브리핑 아래 한 줄로만 쓴다(R4 최소 표시).
 */
export function readOrigin(objective: Objective): { readonly objectiveId: string; readonly title: string | null; readonly userImpact: string } | null {
  const raw = (objective as unknown as { origin?: unknown }).origin;
  if (!isRecord(raw)) return null;
  if (typeof raw.objectiveId !== "string" || !raw.objectiveId) return null;
  return { objectiveId: raw.objectiveId, title: typeof raw.title === "string" ? raw.title : null, userImpact: asString(raw.userImpact) };
}

export function openFollowups(objective: Objective): readonly FollowupCandidate[] {
  return readFollowups(objective).filter((candidate) => candidate.state === "open");
}

export function discardedFollowups(objective: Objective): readonly FollowupCandidate[] {
  return readFollowups(objective).filter((candidate) => candidate.state === "discarded");
}

/**
 * 스티어링 대상 편집 — choose()와 같은 정의다. 한 번도 깨지 않은 지휘관은 보드를 처음부터 읽으므로
 * 그 전의 편집은 알릴 것이 없고, 후속 고르기도 막지 않는다. started 뒤의 편집만 스티어링이 먼저다.
 */
export function steeredEdits(objective: Objective): boolean {
  return objective.commander.started && (objective.edited?.kinds.length ?? 0) > 0;
}

/**
 * 고를 수 있음 — 서버와 같은 조건(awaitingReview && 스티어링 대상 편집 없음 && 기준 제안 없음 && 미완료).
 * 작업 중·edited(깨운 뒤)·gated에서는 읽기·폐기만 한다.
 */
export function isFollowupSelectable(objective: Objective): boolean {
  if (objective.done) return false;
  if (!objective.awaitingReview) return false;
  if (steeredEdits(objective)) return false;
  if (objective.criteriaProposals.length > 0) return false;
  return true;
}

/** 고를 수 없을 때 본문 한 줄이 가리키는 이유 — 스티어링 우선과 기준 잠금을 우회하지 않는다. */
export function followupGate(objective: Objective): "steer" | "criteria" | null {
  if (steeredEdits(objective)) return "steer";
  if (objective.criteriaProposals.length > 0) return "criteria";
  return null;
}

// ── 탭 안 편의 상태 (초안과 같은 규칙: 접어도, 다른 목표를 보다 와도 남는다) ──

const selections = new Map<string, Map<string, number>>();
const selectionListeners = new Set<() => void>();
const compOpens = new Map<string, boolean>();
const compListeners = new Set<() => void>();
const seenCandidates = new Map<string, Set<string>>();

/**
 * getSnapshot용 불변 스냅샷 — useSyncExternalStore 는 스냅샷의 참조가 같아야 멈춘다.
 * 호출마다 새 Set/Map 을 만들면 스냅샷이 매번 달라 무한 렌더(React #185)에 빠지므로,
 * toggle·prune·clear 때만 교체하고 그 사이에는 같은 참조를 돌려준다.
 */
const EMPTY_SELECTION: ReadonlySet<string> = new Set();
const EMPTY_SELECTION_REVS: ReadonlyMap<string, number> = new Map();
const selectionSnapshots = new Map<string, ReadonlySet<string>>();
const selectionRevSnapshots = new Map<string, ReadonlyMap<string, number>>();

function notifySelections(): void {
  for (const listener of selectionListeners) listener();
}

function notifyComp(): void {
  for (const listener of compListeners) listener();
}

export function readSelection(objectiveId: string): ReadonlySet<string> {
  return selectionSnapshots.get(objectiveId) ?? EMPTY_SELECTION;
}

/** 선택 순간의 rev — 보낼 때 이 값으로 보내 서버가 followup_changed 로 판정한다. */
export function readSelectionRevs(objectiveId: string): ReadonlyMap<string, number> {
  return selectionRevSnapshots.get(objectiveId) ?? EMPTY_SELECTION_REVS;
}

function commitSelection(objectiveId: string, next: Map<string, number> | null): void {
  const current = selections.get(objectiveId) ?? null;
  const same =
    (current === null && next === null) ||
    (current !== null && next !== null && current.size === next.size && [...current].every(([id, rev]) => next.get(id) === rev));
  if (same) return;
  if (next === null || next.size === 0) {
    selections.delete(objectiveId);
    selectionSnapshots.delete(objectiveId);
    selectionRevSnapshots.delete(objectiveId);
  } else {
    selections.set(objectiveId, next);
    selectionSnapshots.set(objectiveId, new Set(next.keys()));
    selectionRevSnapshots.set(objectiveId, new Map(next));
  }
  notifySelections();
}

export function toggleFollowupSelection(objectiveId: string, candidateId: string, checked: boolean, rev: number): void {
  const next = new Map(selections.get(objectiveId) ?? []);
  if (checked) next.set(candidateId, rev);
  else next.delete(candidateId);
  commitSelection(objectiveId, next.size > 0 ? next : null);
}

/**
 * 목록에서 사라진(폐기·선택 확정·삭제) id 는 초안에서 거두고, rev 가 바뀐 id 는 선택을 푼다.
 * 사람이 rev1 을 보고 골랐는데 지휘관이 rev2 로 고쳤다면 rev2 를 묵시 승인해 만들지 않는다 —
 * 선택을 풀어 새로 고친 본문을 확인한 뒤 다시 고르게 한다. 다시 고르면 그때의 rev 로 기억된다.
 */
export function pruneSelection(objectiveId: string, openRevs: ReadonlyMap<string, number>): void {
  const current = selections.get(objectiveId);
  if (!current) return;
  const next = new Map<string, number>();
  for (const [id, rev] of current) {
    if (openRevs.get(id) === rev) next.set(id, rev);
  }
  commitSelection(objectiveId, next.size > 0 ? next : null);
}

export function clearSelection(objectiveId: string): void {
  commitSelection(objectiveId, null);
}

export function subscribeSelection(listener: () => void): () => void {
  selectionListeners.add(listener);
  return () => { selectionListeners.delete(listener); };
}

export function useFollowupSelection(objectiveId: string): ReadonlySet<string> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 모듈 스토어 구독(기존 objectives-state 와 같은 문법)
  return useSyncExternalStore(subscribeSelection, () => readSelection(objectiveId), () => readSelection(objectiveId));
}

export function isFollowupOpen(objectiveId: string): boolean {
  return compOpens.get(objectiveId) ?? false;
}

export function setFollowupOpen(objectiveId: string, open: boolean): void {
  if ((compOpens.get(objectiveId) ?? false) === open) return;
  if (open) compOpens.set(objectiveId, true);
  else compOpens.delete(objectiveId);
  notifyComp();
}

function subscribeComp(listener: () => void): () => void {
  compListeners.add(listener);
  return () => { compListeners.delete(listener); };
}

export function useFollowupOpen(objectiveId: string): boolean {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 모듈 스토어 구독
  return useSyncExternalStore(subscribeComp, () => isFollowupOpen(objectiveId), () => isFollowupOpen(objectiveId));
}

/** 본문 구획 머리의 새 후보 점 — 본 적 없는 open id 가 있으면 찍힌다. 펼치면 읽음으로 친다. */
export function unseenFollowupCount(objectiveId: string, openIds: readonly string[]): number {
  const seen = seenCandidates.get(objectiveId);
  if (!seen) return openIds.length;
  return openIds.filter((id) => !seen.has(id)).length;
}

export function markFollowupsSeen(objectiveId: string, openIds: readonly string[]): void {
  seenCandidates.set(objectiveId, new Set(openIds));
}

/** 완료 멱등 키 — 서버가 UUID 로 받는다. 같은 batchId 를 다시 보내면 멱등이다. */
export function newBatchId(): string {
  const random = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (random?.randomUUID) return random.randomUUID();
  const hex = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${((parseInt(hex().slice(0, 1), 16) & 0x3) | 0x8).toString(16)}${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}
