import type { AgentEffort } from "@fleet-console/sdk/agent";
import { isExperimentModelId } from "@fleet-console/sdk/settings";
import { z } from "zod";

/**
 * 사령관(Commodore) — Theater 마다 하나, Objectives 플러그인이 소유하는 자율 운영 세션의 Theater 상태.
 *
 * 보드와 같은 Theater 작업 디렉터리에 `objectives/commodore/` 로 산다: `state.json` 한 건(자율 운영·지시·정보·정보 출처·
 * Theater 별 모델 좌표)과 `transcript.jsonl`(사령관 기록). 사람의 「지시」와 「정보」는 사령관 전용 도구로만 읽히고 시스템
 * 프롬프트나 깨움 턴에는 실리지 않는다 — 그래서 상태의 진실은 이 파일이고, 세션은 매번 여기서 다시 읽는다.
 */

export const COMMODORE_CHANNEL = "objectives:commodore";

/** 지시 원문 상한. 사령관 도구가 통째로 돌려주므로 한 턴에 읽히는 크기여야 한다. */
export const MAX_DIRECTIVE = 8_000;
/** 정보 항목 하나의 본문 상한. */
export const MAX_INTEL_TEXT = 4_000;
/** 보관하는 정보 항목 수 — 넘치면 오래된 것부터 떨어진다(정보는 근거이지 명령이 아니라 유실이 상태를 깨지 않는다). */
export const MAX_INTEL_ITEMS = 500;
export const MAX_SOURCES = 32;
export const MAX_SOURCE_LABEL = 120;
export const MAX_SOURCE_LOCATOR = 512;
/** 기록 읽기의 한 쪽 상한. */
export const MAX_TRANSCRIPT_PAGE = 500;
/** 기록 본문 조각 상한 — 한 항목의 text 는 이 길이로 잘린다. */
export const MAX_TRANSCRIPT_TEXT = 16_000;

/**
 * 순찰 간격(분) — 사람이 서랍에서 고르는 사다리. 사령관은 `next_wake` 로 이보다 일찍 깨어날 수 있지만 넘기지 못하고,
 * 예약 없이 턴을 마치면 이 간격 뒤에 깨어난다. 보드 사건·지시·정보·메시지는 간격과 무관하게 바로 깨운다.
 */
export const COMMODORE_PATROL_MINUTES = [15, 30, 60, 120, 240, 480] as const;
export const DEFAULT_PATROL_MINUTES = 60;
export type CommodorePatrolMinutes = (typeof COMMODORE_PATROL_MINUTES)[number];
export const commodorePatrolSchema = z.literal(COMMODORE_PATROL_MINUTES);

const ids = z.string().min(1).max(128);
/** Theater 별 강도는 세션이 받는 사다리 전체다 — 지휘관 LaunchControl 의 강도 트랙과 같다. 실험 기능 행의 기본값은 3단으로 남는다. */
export const COMMODORE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly AgentEffort[];
const effort = z.enum(COMMODORE_EFFORTS);
const modelId = z.string().refine(isExperimentModelId, "invalid_model");

export const commodoreSourceSchema = z.object({
  id: ids,
  /** 사령관의 읽기 전용 도구가 아는 종류 — GitHub 이슈 목록 또는 URL 한 개. */
  kind: z.enum(["github-issues", "url"]),
  label: z.string().trim().min(1).max(MAX_SOURCE_LABEL),
  /** 종류에 따라 `owner/repo` 또는 URL. 자격증명은 두지 않는다. */
  locator: z.string().trim().min(1).max(MAX_SOURCE_LOCATOR),
}).strict();

export const commodoreIntelSchema = z.object({
  id: ids,
  at: z.number().int().nonnegative(),
  /** 누가 넣었는가 — 사람이 추가하면 `person`, 사령관이 출처에서 읽어 오면 그 출처 id. */
  source: z.string().min(1).max(128),
  text: z.string().min(1).max(MAX_INTEL_TEXT),
}).strict();

export const commodoreDirectiveSchema = z.object({
  text: z.string().max(MAX_DIRECTIVE),
  /** 본문이 바뀔 때마다 1 씩 오른다. 사령관은 rev 로 "지난번 이후 바뀌었는가" 를 안다. */
  rev: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const commodoreStateSchema = z.object({
  /** 자율 운영 — 사이드바 사령관 줄의 글리프. 실험 기능이 꺼져 있으면 저장값과 무관하게 돌지 않는다. */
  autonomy: z.boolean(),
  directive: commodoreDirectiveSchema,
  intel: z.array(commodoreIntelSchema).max(MAX_INTEL_ITEMS),
  sources: z.array(commodoreSourceSchema).max(MAX_SOURCES),
  /** Theater 별 모델·강도. 없으면 실험 기능 행의 기본 좌표. 다음 턴부터 적용된다. */
  model: modelId.optional(),
  effort: effort.optional(),
  /**
   * 사령관이 만드는 목표(직접 추가·후속 선택)의 지휘관 모델·강도. 없으면 보드의 지휘관 기본값이다. 강도는 모델 행의 사다리에서
   * 고르므로 낱말만 검사한다(보드의 지휘관 프리셋과 같은 경계).
   */
  commanderModel: z.string().trim().min(1).max(128).optional(),
  commanderEffort: z.string().trim().min(1).max(32).optional(),
  /** 순찰 간격(분). 없으면 기본 60분이다. */
  patrolMinutes: commodorePatrolSchema.optional(),
  /** 사람이 이 Theater 를 보는 언어 — 서랍의 요청이 남긴다. 사령관 기록의 언어이고, 없으면 목표의 언어·영어 순이다. */
  language: z.enum(["en", "ko"]).optional(),
  /** 누적 운영 셈 — 세션 번호(교대·재시작마다 1 씩), 누적 비용, 보드에 쓴 행위 수. 감독자가 올린다. */
  run: z.object({
    session: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    actions: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();

export type CommodoreSource = z.output<typeof commodoreSourceSchema>;
export type CommodoreIntel = z.output<typeof commodoreIntelSchema>;
export type CommodoreDirective = z.output<typeof commodoreDirectiveSchema>;
export type CommodoreState = z.output<typeof commodoreStateSchema>;
export type CommodoreRunTotals = NonNullable<CommodoreState["run"]>;

export const EMPTY_RUN_TOTALS: CommodoreRunTotals = Object.freeze({ session: 0, costUsd: 0, actions: 0 });

/**
 * 감독자가 말하는 지금 상태 — 저장되지 않는다. `off` 는 실험 기능이나 자율 운영이 꺼진 것, `idle` 은 다음 깨움을 기다리는 것,
 * `turn` 은 사령관이 일하는 중, `retrying` 은 턴 오류 뒤 재시도 대기(`reason`·`retryAt`), `error` 는 재시도로도 못 푼 상태.
 */
export interface CommodoreRunStatus {
  readonly phase: "off" | "idle" | "turn" | "retrying" | "error";
  readonly reason?: string;
  /** 다음 깨움(순찰 또는 재시도)의 예정 시각(ms). */
  readonly nextWakeAt?: number;
  /** 감독자가 지금 정체로 보는 목표 id — 지휘관이 임무를 남긴 채 오래 쉰다. 목표가 다시 움직이면 빠진다. */
  readonly stalled?: readonly string[];
  readonly totals: CommodoreRunTotals;
}

export const EMPTY_COMMODORE_STATE: CommodoreState = Object.freeze({
  autonomy: false,
  directive: Object.freeze({ text: "", rev: 0, updatedAt: 0 }),
  intel: Object.freeze([]) as unknown as CommodoreIntel[],
  sources: Object.freeze([]) as unknown as CommodoreSource[],
}) as CommodoreState;

/** Theater 별 좌표 — null 은 실험 기능 기본값으로 되돌린다는 뜻이다. */
export interface CommodoreCoordinates {
  readonly model: string;
  readonly effort: AgentEffort;
}

/**
 * 사령관 기록 한 줄. 세션의 onEvent 를 플러그인이 정제해 쌓는다 — 프로바이더 세션 id·원시 경로는 들어오지 않는다.
 * `seq` 는 Theater 안에서 단조 증가하고, 페이지 커서다.
 */
export type CommodoreTranscriptEntry =
  | CommodoreTranscriptBase & { readonly kind: "wake"; readonly reasons: readonly string[] }
  | CommodoreTranscriptBase & { readonly kind: "text"; readonly text: string }
  | CommodoreTranscriptBase & { readonly kind: "thinking"; readonly text: string }
  | CommodoreTranscriptBase & { readonly kind: "tool"; readonly name: string; readonly summary?: string; readonly ok?: boolean; readonly action?: string; readonly objectiveId?: string; readonly title?: string; readonly error?: string }
  | CommodoreTranscriptBase & { readonly kind: "result"; readonly outcome: "ok" | "error" | "cancelled"; readonly costUsd?: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly error?: string }
  | CommodoreTranscriptBase & { readonly kind: "session"; readonly event: "opened" | "replaced" | "restarted" | "stopped"; readonly reason?: string }
  | CommodoreTranscriptBase & { readonly kind: "message"; readonly text: string }
  | CommodoreTranscriptBase & { readonly kind: "error"; readonly code: string; readonly retryAt?: number };

export interface CommodoreTranscriptBase {
  readonly seq: number;
  readonly at: number;
}

/** 쌓을 때 넘기는 모양 — seq·at 는 저장소가 찍는다. */
export type CommodoreTranscriptInput = CommodoreTranscriptEntry extends infer E ? E extends CommodoreTranscriptBase ? Omit<E, "seq" | "at"> : never : never;

const transcriptBase = { seq: z.number().int().nonnegative(), at: z.number().int().nonnegative() };
const text = z.string().max(MAX_TRANSCRIPT_TEXT);
export const commodoreTranscriptEntrySchema = z.discriminatedUnion("kind", [
  z.object({ ...transcriptBase, kind: z.literal("wake"), reasons: z.array(z.string().max(200)).max(32) }).strict(),
  z.object({ ...transcriptBase, kind: z.literal("text"), text }).strict(),
  z.object({ ...transcriptBase, kind: z.literal("thinking"), text }).strict(),
  // 보드 행위는 action·objectiveId·title 로 서랍이 「목표 X 를 완료」 한 줄로 그린다 — 도구 인자 전체는 싣지 않는다.
  // 거절은 코드 한 낱말만(`error`) — 도구 결과의 나머지(입력·힌트)는 싣지 않는다.
  z.object({ ...transcriptBase, kind: z.literal("tool"), name: z.string().max(128), summary: z.string().max(1_000).optional(), ok: z.boolean().optional(), action: z.string().max(64).optional(), objectiveId: z.string().max(128).optional(), title: z.string().max(200).optional(), error: z.string().max(64).optional() }).strict(),
  z.object({ ...transcriptBase, kind: z.literal("result"), outcome: z.enum(["ok", "error", "cancelled"]), costUsd: z.number().nonnegative().optional(), inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), error: z.string().max(200).optional() }).strict(),
  z.object({ ...transcriptBase, kind: z.literal("session"), event: z.enum(["opened", "replaced", "restarted", "stopped"]), reason: z.string().max(200).optional() }).strict(),
  z.object({ ...transcriptBase, kind: z.literal("message"), text }).strict(),
  z.object({ ...transcriptBase, kind: z.literal("error"), code: z.string().max(64), retryAt: z.number().int().nonnegative().optional() }).strict(),
]);

/** 브라우저·감독자 양쪽으로 나가는 사건 — `objectives:commodore` 채널. */
export type CommodoreEvent =
  | { readonly op: "state"; readonly theaterId: string; readonly state: CommodoreState; readonly change: CommodoreStateChange }
  | { readonly op: "transcript"; readonly theaterId: string; readonly entry: CommodoreTranscriptEntry }
  | { readonly op: "run"; readonly theaterId: string; readonly run: CommodoreRunStatus };

export type CommodoreStateChange = "autonomy" | "directive" | "intel" | "sources" | "coordinates" | "commander" | "patrol" | "language" | "run";

/** Theater 의 순찰 간격(ms) — 저장값, 없으면 기본. */
export function patrolIntervalMs(state: Pick<CommodoreState, "patrolMinutes"> | null | undefined): number {
  return (state?.patrolMinutes ?? DEFAULT_PATROL_MINUTES) * 60_000;
}
