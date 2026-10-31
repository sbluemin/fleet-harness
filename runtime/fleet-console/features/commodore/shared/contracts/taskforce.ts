import { z } from "zod";

/**
 * TaskForce(TF) 공유 계약 — 브라우저 번들도 읽으므로 타입·zod 외의 의존성을 두지 않는다.
 *
 * 호스트 저장소는 Console 데이터의 `taskforce/<TF UUID>/`에 산다: `state.json` 한 건과
 * 덧붙이기만 하는 `ledger.jsonl`, 이미지 사본 `images/<seq>/`. 사령관 1:1 기록
 * (`commodore/<UUID>/transcript.jsonl`)에는 TF 발언을 절대 쓰지 않는다.
 */

export const TASKFORCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const taskforceIdSchema = z.string().regex(TASKFORCE_ID, "invalid_taskforce");

/** 사령관 발언 수 상한 — 마지막 사람 발언 이후의 사령관 발언이 이 수에 닿으면 체인이 멈춘다. */
export const TASKFORCE_CHAIN_LIMIT = 12;

export const MAX_TASKFORCE_NAME = 40;
export const MAX_TASKFORCE_TOPIC = 4000;
export const MAX_TASKFORCE_TEXT = 16_000;
export const MAX_TASKFORCE_MEMBERS = 32;
export const MAX_TASKFORCE_ACTIONS = 8;
export const MAX_TASKFORCE_IMAGES = 4;
export const MAX_TASKFORCE_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TASKFORCE_LEDGER_PAGE = 500;
export const DEFAULT_TASKFORCE_LEDGER_PAGE = 200;

const ids = z.string().min(1).max(128);
const memberId = z.string().regex(TASKFORCE_ID, "invalid_commodore");

/** 원장 system 항목 코드 — 최소 집합. 체인·참가·종료 전이를 가리킨다. */
export const TASKFORCE_SYSTEM_CODES = [
  "created",
  "member-added",
  "member-removed",
  "chain-paused",
  "chain-resumed",
  "closed",
  "reopened",
  "close-proposed",
] as const;
export const taskforceSystemCodeSchema = z.enum(TASKFORCE_SYSTEM_CODES);
export type TaskforceSystemCode = z.output<typeof taskforceSystemCodeSchema>;

export const taskforceSpeakerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person") }).strict(),
  z.object({ kind: z.literal("commodore"), commodoreId: memberId }).strict(),
  z.object({ kind: z.literal("system"), code: taskforceSystemCodeSchema }).strict(),
]);
export type TaskforceSpeaker = z.output<typeof taskforceSpeakerSchema>;

const taskforceImageMimeSchema = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type TaskforceImageMime = z.output<typeof taskforceImageMimeSchema>;

export const taskforceLedgerImageSchema = z.object({
  id: ids,
  mime: taskforceImageMimeSchema,
  name: z.string().min(1).max(128),
  size: z.number().int().nonnegative(),
}).strict();
export type TaskforceLedgerImage = z.output<typeof taskforceLedgerImageSchema>;

export const taskforceActionSchema = z.object({
  kind: z.string().min(1).max(64),
  objectiveId: ids,
  title: z.string().max(200),
  missionId: ids.optional(),
}).strict();
export type TaskforceAction = z.output<typeof taskforceActionSchema>;

export const taskforceLedgerEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  speaker: taskforceSpeakerSchema,
  text: z.string().max(MAX_TASKFORCE_TEXT),
  mentions: z.array(memberId).max(MAX_TASKFORCE_MEMBERS).default([]),
  replyTo: z.number().int().nonnegative().optional(),
  actions: z.array(taskforceActionSchema).max(MAX_TASKFORCE_ACTIONS).optional(),
  images: z.array(taskforceLedgerImageSchema).max(MAX_TASKFORCE_IMAGES).optional(),
}).strict();
export type TaskforceLedgerEntry = z.output<typeof taskforceLedgerEntrySchema>;

/** 쌓을 때 넘기는 모양 — seq·at 는 저장소가 찍는다. */
export type TaskforceLedgerInput = Omit<TaskforceLedgerEntry, "seq" | "at">;

/** 말 수 — 사람이 `person`, 사령관이 `commodore`. system 항목은 세지 않는다. */
export const taskforceCountsSchema = z.object({
  person: z.number().int().nonnegative(),
  commodore: z.number().int().nonnegative(),
}).strict();
export type TaskforceCounts = z.output<typeof taskforceCountsSchema>;

/**
 * 판단 스냅샷 — 지금 판단 중인 성원(`judging`)과 성원별 마지막 결과(`outcomes`).
 * `outcomes`는 판단이 끝난 성원만 든다: 말했으면 `spoke`, 말 없이 턴을 끝냈으면
 * `silent`, 턴이 오류·취소로 끝나 항목이 다시 줄을 섰으면 `failed`. 휘발성이라
 * 재시작하면 비어 있을 수 있다.
 */
export const taskforceJudgingSnapshotSchema = z.object({
  judging: z.array(memberId).max(MAX_TASKFORCE_MEMBERS),
  outcomes: z.record(z.string(), z.object({ outcome: z.enum(["spoke", "silent", "failed"]), at: z.number().int().nonnegative() }).strict()).default({}),
  at: z.number().int().nonnegative(),
}).strict();
export type TaskforceJudgingSnapshot = z.output<typeof taskforceJudgingSnapshotSchema>;

export const taskforceStateSchema = z.object({
  id: taskforceIdSchema,
  name: z.string().trim().min(1).max(MAX_TASKFORCE_NAME),
  topic: z.string().trim().min(1).max(MAX_TASKFORCE_TOPIC),
  members: z.array(memberId).max(MAX_TASKFORCE_MEMBERS),
  status: z.enum(["open", "closed"]),
  createdAt: z.number().int().nonnegative(),
  closedAt: z.number().int().nonnegative().optional(),
  readSeq: z.record(z.string(), z.number().int().nonnegative()),
  chain: z.object({
    count: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    paused: z.boolean(),
  }).strict(),
  lastSeq: z.number().int().nonnegative(),
  /** 말 수 — 없는 옛 state.json은 읽을 때 0으로 둔다(그 전 말은 세지 않는다). */
  counts: taskforceCountsSchema.default({ person: 0, commodore: 0 }),
  /** 판단 스냅샷 — 런타임이 남긴 마지막 모습. 읽을 때만 쓰고 판단은 사건으로 따라간다. */
  judging: taskforceJudgingSnapshotSchema.optional(),
}).strict();
export type TaskforceState = z.output<typeof taskforceStateSchema>;

export type TaskforceStateChange =
  | "created"
  | "updated"
  | "member-added"
  | "member-removed"
  | "continued"
  | "closed"
  | "reopened"
  | "read"
  /** 원장 append로 lastSeq·chain·readSeq 가 전진했다 — 원장 사건과 함께 나간다. */
  | "ledger";

/** 사이드바·목록이 그리는 한 줄 요약. 미리보기는 마지막 원장 항목이다. */
export interface TaskforceSummary {
  readonly id: string;
  readonly name: string;
  readonly topic: string;
  readonly members: readonly string[];
  readonly status: "open" | "closed";
  readonly lastSeq: number;
  readonly createdAt: number;
  readonly closedAt?: number;
  /** 말 수 — 개요 탭이 「발언 N개 (사람 a · 사령관 b)」를 원장 paging 없이 그린다. */
  readonly counts: TaskforceCounts;
  /** 지금 판단 중인 성원 — 사이드바의 pulsing dot이 이것만 본다. */
  readonly judging: readonly string[];
  readonly preview?: { readonly seq: number; readonly at: number; readonly text: string; readonly speaker: TaskforceSpeaker };
}

export interface TaskforceLedgerPage {
  readonly entries: readonly TaskforceLedgerEntry[];
  /** 더 오래된 항목이 남아 있다 — 첫 항목의 seq 를 `before` 로 넘겨 이어 읽는다. */
  readonly hasMore: boolean;
}

/** 판단 중 표시 — 지금 판단 중인 사령관 id 목록. 침묵을 택한 사령관은 목록에서 빠지고 흔적을 남기지 않는다. */
export interface TaskforceJudgingStatus {
  readonly taskforceId: string;
  readonly judging: readonly string[];
  readonly outcomes: Readonly<Record<string, { readonly outcome: "spoke" | "silent" | "failed"; readonly at: number }>>;
  readonly at: number;
}

/**
 * `commodore` 채널로 함께 나가는 TF 사건 — 화면은 응답이 아니라 이 사건으로 갱신되므로
 * 라우트 응답은 확인용이다. 런타임(판단·깨움)은 판단 상태 사건을 여기서 낸다.
 */
export interface TaskforceJudgingEvent extends TaskforceJudgingStatus {
  readonly op: "taskforce-judging";
}
export type TaskforceEvent =
  | { readonly op: "taskforce-state"; readonly taskforceId: string; readonly state: TaskforceState; readonly change: TaskforceStateChange }
  | { readonly op: "taskforce-ledger"; readonly taskforceId: string; readonly entry: TaskforceLedgerEntry }
  | TaskforceJudgingEvent
  | { readonly op: "taskforce-removed"; readonly taskforceId: string };

/** 라우트 이름 — Console 서버에는 `/api/v1/<이름>` 으로 걸린다. */
export const TASKFORCE_ROUTE_NAMES = {
  list: "taskforce/list",
  create: "taskforce/create",
  read: "taskforce/read",
  post: "taskforce/post",
  update: "taskforce/update",
  addMembers: "taskforce/members/add",
  removeMembers: "taskforce/members/remove",
  continue: "taskforce/continue",
  close: "taskforce/close",
  reopen: "taskforce/reopen",
  delete: "taskforce/delete",
  image: "taskforce/image",
} as const;

/** 브라우저가 부르는 주소. */
export const TASKFORCE_ROUTES = {
  list: "/api/v1/taskforce/list",
  create: "/api/v1/taskforce/create",
  read: "/api/v1/taskforce/read",
  post: "/api/v1/taskforce/post",
  update: "/api/v1/taskforce/update",
  addMembers: "/api/v1/taskforce/members/add",
  removeMembers: "/api/v1/taskforce/members/remove",
  continue: "/api/v1/taskforce/continue",
  close: "/api/v1/taskforce/close",
  reopen: "/api/v1/taskforce/reopen",
  delete: "/api/v1/taskforce/delete",
  image: "/api/v1/taskforce/image",
} as const;

const uniqueMembers = (members: readonly string[]): boolean => new Set(members).size === members.length;

export const taskforceCreateSchema = z.object({
  name: z.string().trim().min(1).max(MAX_TASKFORCE_NAME),
  topic: z.string().trim().min(1).max(MAX_TASKFORCE_TOPIC),
  members: z.array(memberId).min(2).max(MAX_TASKFORCE_MEMBERS).refine(uniqueMembers, "duplicate_members"),
}).strict();
export type TaskforceCreateInput = z.output<typeof taskforceCreateSchema>;

export const taskforceReadSchema = z.object({
  taskforceId: taskforceIdSchema,
  limit: z.number().int().min(1).max(MAX_TASKFORCE_LEDGER_PAGE).optional(),
  before: z.number().int().nonnegative().optional(),
}).strict();

const taskforcePostImageSchema = z.object({
  name: z.string().trim().min(1).max(128),
  mime: taskforceImageMimeSchema,
  dataBase64: z.string().min(1).max(16 * 1024 * 1024),
}).strict();

export const taskforcePostSchema = z.object({
  taskforceId: taskforceIdSchema,
  text: z.string().trim().min(1).max(MAX_TASKFORCE_TEXT),
  mentions: z.array(memberId).max(MAX_TASKFORCE_MEMBERS).optional(),
  replyTo: z.number().int().nonnegative().optional(),
  images: z.array(taskforcePostImageSchema).max(MAX_TASKFORCE_IMAGES).optional(),
}).strict();
export type TaskforcePostInput = z.output<typeof taskforcePostSchema>;

export const taskforceUpdateSchema = z.object({
  taskforceId: taskforceIdSchema,
  name: z.string().trim().min(1).max(MAX_TASKFORCE_NAME).optional(),
  topic: z.string().trim().min(1).max(MAX_TASKFORCE_TOPIC).optional(),
}).strict().refine((value) => value.name !== undefined || value.topic !== undefined, "empty_update");
export type TaskforceUpdateInput = z.output<typeof taskforceUpdateSchema>;

export const taskforceMembersAddSchema = z.object({
  taskforceId: taskforceIdSchema,
  commodoreIds: z.array(memberId).min(1).max(MAX_TASKFORCE_MEMBERS).refine(uniqueMembers, "duplicate_members"),
}).strict();

export const taskforceMembersRemoveSchema = z.object({
  taskforceId: taskforceIdSchema,
  commodoreId: memberId,
}).strict();

export const taskforceIdOnlySchema = z.object({ taskforceId: taskforceIdSchema }).strict();

export const taskforceImageQuerySchema = z.object({
  taskforceId: taskforceIdSchema,
  seq: z.coerce.number().int().nonnegative(),
  imageId: ids,
}).strict();
