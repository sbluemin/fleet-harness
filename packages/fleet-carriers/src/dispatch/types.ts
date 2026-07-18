import { CLI_BACKENDS, type CliType, type ProviderKey } from "@dotobokuri/core-unified-agent";
import type { TrackStatus } from "@dotobokuri/core-agent";
import type { CarrierJobFinalStatus, CarrierJobKind } from "../jobs/types.js";

export type { TrackStatus } from "@dotobokuri/core-agent";
// job kind/status는 jobs/types.ts가 단일 소유자 — 여기서는 재노출/별칭으로만 참조한다.
export type { CarrierJobKind } from "../jobs/types.js";

/**
 * dispatch/types.ts — Carrier 프레임워크 타입 정의
 *
 * 외부 확장이 커스텀 Carrier를 등록할 때 사용하는
 * 공개 타입 및 내부 상태 타입을 정의합니다.
 */

// ─── Carrier 카테고리 ─────────────────────────────────────

/** Carrier 카테고리 — 운영 계층 분류 */
export type CarrierCategory = "strategy" | "planning" | "operations";

// ─── Carrier 메타데이터 (2-Tier) ────────────────────────

/** 구조화 요청 블록 정의 */
export interface RequestBlock {
  /** 태그 이름 (e.g., "objective", "scope") */
  tag: string;
  /** 1줄 설명 */
  hint: string;
  /** 필수 여부 */
  required: boolean;
}

/** Lossless observer-only rendering of one configured request block. */
export interface CarrierRequestBlock {
  tag: string;
  hint: string;
  required: boolean;
  present: boolean;
  /** Exact, untrimmed text between the selected opening and closing tags. */
  body: string;
}

/** Lossless observer-only rendering of a Carrier dispatch request. */
export interface CarrierRequest {
  /** Configured blocks in CarrierMetadata.requestBlocks order. */
  blocks: CarrierRequestBlock[];
  /** Every source character not belonging to a selected configured block. */
  additional: string;
}

/**
 * Carrier 메타데이터 — 2-Tier 구조
 *
 * - Tier 1 (Routing): 시스템 프롬프트에 carrier당 ~4줄의 compact roster로 상주
 * - Tier 2 (Composition): 실행 시점에만 request에 자동 주입
 */
export interface CarrierMetadata {
  // ── Tier 1: Routing (→ promptGuidelines compact roster) ──
  /** 직함 (e.g., "Chief Engineer") */
  title: string;
  /** 한줄 역할+특징 요약 */
  summary: string;
  /** 운영 카테고리 — strategy | planning | operations */
  category: CarrierCategory;
  /** 긍정 호출 조건 (N개, 짧은 구문) */
  whenToUse: string[];
  /** 부정 호출 조건 (N개, 짧은 구문) */
  whenNotToUse: string[];
  /** 구조화 요청 블록 — 로스터 및 도구 가이드라인에 노출 */
  requestBlocks: RequestBlock[];
  /**
   * 이 carrier의 executor MCP 세션에 추가 노출할 opaque agent tool ID 목록.
   * prior job self-fetch가 필요한 carrier는 `carrier_jobs`를 명시적으로 열거해야 한다.
   */
  allowedExecutorTools?: readonly string[];
  /**
   * 이 carrier의 executor ACP 세션에 노출할 builtin external MCP server ID 목록.
   * 내부 fleet-tools tool ID와 섞지 않고 server 단위 allowlist로만 사용한다.
   */
  allowedBuiltinExternalMcpServers?: readonly string[];

  // ── Tier 2: Composition (→ 실행 시 request에 자동 주입) ──
  /** 권한/제약 (여러 줄) */
  permissions: string[];
  /** <output_format> 전체 블록 — framework가 request 끝에 자동 append */
  outputFormat: string;
  /** 일반 원칙 (carrier 고유 행동 지침, 2-3줄) */
  principles?: string[];
}

// ─── 공개 타입 ───────────────────────────────────────────

export interface CarrierCoreConfig {
  /** 고유 식별자 (carrierId) → 메시지 `{id}-user/{id}-response`, dispatch 스코프/바인딩 키 */
  id: string;
  /** 정렬 및 HUD 표시용 슬롯 번호 (키바인딩에는 사용되지 않음) */
  slot: number;
  /** 표시 이름 */
  displayName: string;
  /** carrier 메타데이터 (2-Tier: Routing + Composition) */
  carrierMetadata?: CarrierMetadata;
}

export interface CarrierCliConfig {
  /** 소스레벨 기본 CLI 타입 (사용자 변경과 무관하게 원본 유지) */
  defaultCliType: CliType;
  /** dispatch/store가 사용하는 persona 소유 기본 모델 */
  defaultModel?: string;
  /** dispatch/store가 사용하는 persona 소유 기본 reasoning effort */
  defaultEffort?: string;
}

export interface CarrierAgentProviderDefaults {
  readonly defaultModel?: string;
  readonly defaultEffort?: string;
}

export interface CarrierPersonaAgentDefaults {
  readonly dispatch: {
    readonly defaultCliType: CliType;
    readonly defaultModel?: string;
    readonly defaultEffort?: string;
  };
}

export interface CarrierPersonaDefaults {
  readonly id: string;
  readonly displayName: string;
  readonly slot: number;
  readonly agent: CarrierPersonaAgentDefaults;
}

export type CarrierConfig = CarrierCoreConfig & CarrierCliConfig;

// ─── 내부 상태 타입 ──────────────────────────────────────

/** 레지스트리 엔트리 — store/types.ts의 영속 CarrierState와 구별되는 내부 전용 타입 */
export interface CarrierRegistryEntry {
  config: CarrierConfig;
}

export interface CarrierFrameworkState {
  /** 등록된 모든 carrier */
  modes: Map<string, CarrierRegistryEntry>;
  /** slot 순으로 정렬된 carrierId 목록 */
  registeredOrder: string[];
  /** 상태바 갱신 콜백 */
  statusUpdateCallbacks: Array<() => void>;
  /** Carrier job stream 이벤트 핸들러 */
  streamHandlers: Set<CarrierJobStreamHandler>;
  /** Task Force 설정이 완료된 carrier ID 집합 */
  taskforceConfiguredCarriers: Set<string>;
}

/** 스트림 job 최종 상태 — jobs/types.ts CarrierJobFinalStatus의 별칭 */
export type CarrierJobStatus = CarrierJobFinalStatus;

export type TrackKind = "carrier" | "subtask" | "backend";

export interface TrackMeta {
  trackId: string;
  streamKey: string;
  displayCli: string;
  displayName: string;
  effort?: string;
  model?: string;
  subtitle?: string;
  startedAt?: number;
  kind: TrackKind;
  runId?: string;
}

export type CarrierJobStreamEvent = { readonly originSessionId?: string } & (
  | {
    type: "job:registered";
    jobId: string;
    kind: CarrierJobKind;
    ownerCarrierId: string;
    label: string;
    startedAt: number;
    activeJobToolCallId?: string;
    tracks: TrackMeta[];
  }
  | {
    type: "job:finalized";
    jobId: string;
    status: CarrierJobStatus;
    finishedAt: number;
    error?: string;
    summary: string;
    systemReminder?: string;
  }
  | {
    type: "track:begin";
    jobId: string;
    trackId: string;
    startedAt?: number;
    /** Exact local parse of the original executor request for observers. */
    request?: CarrierRequest;
    /** @deprecated Compatibility preview; observers must use request instead. */
    requestPreview?: string;
  }
  | {
    type: "track:status";
    jobId: string;
    trackId: string;
    status: TrackStatus;
  }
  | {
    type: "track:runId";
    jobId: string;
    trackId: string;
    runId: string;
  }
  | {
    type: "track:text";
    jobId: string;
    trackId: string;
    text: string;
  }
  | {
    type: "track:thought";
    jobId: string;
    trackId: string;
    text: string;
  }
  | {
    type: "track:tool";
    jobId: string;
    trackId: string;
    detailChars?: number;
    toolCallId?: string;
    title: string;
    status: string;
  }
  | {
    type: "track:finalized";
    jobId: string;
    trackId: string;
    status: TrackStatus;
    finishedAt?: number;
    error?: string;
    sessionId?: string;
    fallbackText?: string;
    fallbackThought?: string;
  }
);

export type CarrierJobStreamHandler = (event: CarrierJobStreamEvent) => void;

export type TaskForceCliType = CliType;

export interface BackendProgress {
  status: "queued" | "connecting" | "streaming" | "done" | "error";
  toolCallCount: number;
  lineCount: number;
}

export interface TaskForceResult {
  cliType: TaskForceCliType;
  displayName: string;
  status: "done" | "error" | "aborted";
  responseText: string;
  error?: string;
  thinking?: string;
  toolCalls?: { title: string; status: string }[];
}

export interface TaskForceState {
  carrierId: string;
  requestKey: string;
  backends: Map<TaskForceCliType, BackendProgress>;
  startedAt: number;
  finishedAt?: number;
}

export type CarrierCliType = ProviderKey;

export interface ModelSelection {
  model: string;
  effort?: string;
}

export interface ModelEffort {
  supported: boolean;
  levels?: readonly string[];
  default?: string;
}

export interface ModelInfo {
  modelId: string;
  name: string;
  effort?: ModelEffort;
}

export interface CliModelInfo {
  readonly [legacyField: string]: unknown;
  defaultModel: string;
  models: ModelInfo[];
}

export interface ResolvedCliSelection {
  model: string;
  effort: string | null;
  isDefault: boolean;
}

export interface CliTypeChangeResult {
  carrierId: string;
  newCliType: CarrierCliType;
  selection: ResolvedCliSelection;
}

export interface CliTypeChangeSettledResult {
  status: "fulfilled" | "rejected";
  carrierId: string;
  result?: CliTypeChangeResult;
  error?: string;
}

export interface CarrierStatusEntry {
  carrierId: string;
  slot: number;
  cliType: CarrierCliType;
  defaultCliType: CarrierCliType;
  displayName: string;
  model: string;
  isDefault: boolean;
  effort: string | null;
  role: string | null;
  roleDescription: string | null;
  taskForceBackendCount: number;
  category?: CarrierCategory;
}

export interface CarrierOverlayCallbacks {
  getEntries(): CarrierStatusEntry[];
  changeCliType(carrierId: string, newCliType: CarrierCliType): Promise<ResolvedCliSelection>;
  changeCliTypes(updates: Array<{ carrierId: string; newCliType: CarrierCliType }>): Promise<CliTypeChangeSettledResult[]>;
  resetCliTypesToDefault(): Promise<CliTypeChangeSettledResult[]>;
  saveModelSelection(carrierId: string, selection: ModelSelection): Promise<void>;
  openTaskForce(carrierId: string): void;
  getAvailableModels(cliType: CarrierCliType): CliModelInfo;
  getDefaultCliType(): CarrierCliType;
}

// ─── Carrier ID 검증 상수 ─────────────────────────────────

/** 도구 네임스페이스 충돌 방지를 위한 예약 ID */
export const RESERVED_CARRIER_IDS = new Set(["jobs", "taskforce"]);

/** Carrier ID 허용 형식: 소문자 시작, 소문자/숫자/밑줄만 허용 */
export const CARRIER_ID_FORMAT_REGEX = /^[a-z][a-z0-9_]*$/;

export const TASKFORCE_CLI_TYPES = Object.keys(CLI_BACKENDS) as CliType[];
