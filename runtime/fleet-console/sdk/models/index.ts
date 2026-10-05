import type { OperationLaunchVariantGroup, OperationLaunchVariantRow } from "../operations/types.js";

/**
 * 모델 로스터 계약 — Console의 모든 모델 선택지가 읽는 유일한 원천의 모양과 해석 규칙.
 *
 * 원천은 Settings › AI Gateway에서 켠 로스터 하나다. 호스트가 그것을 `OperationLaunchVariantGroup[]`
 * 모양으로 투영해 내놓고, 선택기·서버 해석·플러그인은 이 모듈의 순수 함수로만 읽는다. 서버와 브라우저가
 * 같은 규칙을 나눠 쓰므로 Node·DOM 의존이 없다.
 */

/**
 * 로스터를 소비하는 실행 대상.
 *
 * - `launch`: Agent CLI Operation(지휘관·구성원·Quick Launch). 사다리 끝에 하네스 능력 `ultra`가 선다.
 * - `agent`: Agent SDK 세션(Cowork·Analyst·Scuttlebutt·Commodore). Agent SDK는 `ultra`를 받지 않으므로
 *   사다리는 모델이 내놓는 low…max까지이고, 게이트 없이 전부 열린다.
 */
export type ModelRosterTarget = "launch" | "agent";

export const MODEL_ROSTER_TARGETS: readonly ModelRosterTarget[] = ["launch", "agent"];

export function isModelRosterTarget(value: unknown): value is ModelRosterTarget {
  return value === "launch" || value === "agent";
}

/** 공급자 밴드별 행. 행의 `launch.model`이 정준 모델 id(실행 id)다. */
export type ModelRoster = readonly OperationLaunchVariantGroup[];

/** Agent SDK 세션이 받는 강도 사다리. `ultra`는 Claude Code 하네스 센티넬이라 여기 없다. */
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === "string" && (AGENT_EFFORTS as readonly string[]).includes(value);
}

/** 강도의 높낮이 비교에 쓰는 전체 순서. launch 대상의 `ultra`가 맨 위다. */
const EFFORT_ORDER: readonly string[] = [...AGENT_EFFORTS, "ultra"];

/**
 * 로스터가 비었을 때 실행이 서는 최후 좌표. 라우터가 Claude 네이티브 별칭을 호출자 자격증명으로
 * Anthropic에 원문 중계하므로, Gateway에서 아무것도 켜지 않아도 이 모델은 돈다.
 */
export const ROSTER_FALLBACK_MODEL = "sonnet";

/** 서버 브로드캐스트 채널 — 로스터가 바뀌면 값 없이 울린다. 받은 쪽이 다시 읽는다. */
export const MODEL_ROSTER_CHANGED_CHANNEL = "models:roster-changed";

/** 로스터 HTTP 표면. `?target=launch|agent`. */
export const MODEL_ROSTER_PATH = "/api/v1/models/roster";

const LEGACY_GATEWAY_PREFIX = "claude-gateway--";
const ONE_MILLION_MARKER = "[1m]";
const CLAUDE_SCOPE = "claude--";
const CLAUDE_ONE_MILLION_SUFFIX = "-1m";

/**
 * 저장값에 남은 옛 문법을 정준 id(실행 id)로 접는다. 읽을 때만 쓰고, 다음 저장이 정준 id로 바꾼다.
 *
 * - `claude-gateway--codex--gpt-6-luna[1m]` → `codex--gpt-6-luna` (Claude Code 디스커버리 표기)
 * - `claude--opus-1m` → `opus[1m]`, `claude--sonnet` → `sonnet` (Gateway scoped Claude 항목)
 * - 그 밖(`opus[1m]`, `codex--gpt-6-luna`)은 이미 정준 id다.
 */
export function canonicalModelId(id: string): string {
  let value = id.trim();
  if (value.startsWith(LEGACY_GATEWAY_PREFIX)) {
    value = value.slice(LEGACY_GATEWAY_PREFIX.length);
    if (value.endsWith(ONE_MILLION_MARKER)) value = value.slice(0, -ONE_MILLION_MARKER.length);
  }
  if (value.startsWith(CLAUDE_SCOPE)) {
    const alias = value.slice(CLAUDE_SCOPE.length);
    return alias.endsWith(CLAUDE_ONE_MILLION_SUFFIX)
      ? `${alias.slice(0, -CLAUDE_ONE_MILLION_SUFFIX.length)}${ONE_MILLION_MARKER}`
      : alias;
  }
  return value;
}

export function rosterRows(roster: ModelRoster | null | undefined): readonly OperationLaunchVariantRow[] {
  return roster ? roster.flatMap((group) => group.rows) : [];
}

/** 저장 id(정준·레거시 어느 쪽이든)에 해당하는 행. 로스터 밖이면 null. */
export function findRosterRow(roster: ModelRoster | null | undefined, id: string | null | undefined): OperationLaunchVariantRow | null {
  if (!id) return null;
  const wanted = canonicalModelId(id);
  return rosterRows(roster).find((row) => canonicalModelId(row.launch.model ?? row.id) === wanted) ?? null;
}

/** 행이 실제로 내놓는 강도 단(사다리 순). launch 행이면 끝에 `ultra`가 있다. */
export function rosterRowEfforts(row: OperationLaunchVariantRow | null | undefined): readonly string[] {
  return row?.chips?.map((chip) => chip.id) ?? [];
}

/**
 * 실행 시점 강도 클램프. 저장값은 고쳐 쓰지 않는다 — 사다리가 다시 넓어지면 그대로 돌아온다.
 *
 * - 사다리에 있으면 그대로.
 * - 없으면 사다리 안에서 저장값 이하인 가장 높은 단, 그것도 없으면 첫 단.
 * - 사다리가 비면(강도를 받지 않는 모델) 생략.
 */
export function clampRosterEffort(ladder: readonly string[], wanted: string | null | undefined): string | undefined {
  if (ladder.length === 0) return undefined;
  if (wanted && ladder.includes(wanted)) return wanted;
  const rank = wanted ? EFFORT_ORDER.indexOf(wanted) : -1;
  if (rank >= 0) {
    for (let index = ladder.length - 1; index >= 0; index -= 1) {
      const rung = EFFORT_ORDER.indexOf(ladder[index]!);
      if (rung >= 0 && rung <= rank) return ladder[index];
    }
  }
  return ladder[0];
}

export interface ModelCoordinate {
  readonly model?: string | null;
  readonly effort?: string | null;
}

/**
 * 로스터에 대조해 정한 실행 좌표.
 *
 * `fallback`이 true면 저장값을 그대로 쓸 수 없었다는 뜻이다(로스터 밖이거나 로스터가 비었다). 선택기는
 * 이것을 「꺼짐」 표식으로, 서버는 실행 기록의 `fallback:true`로 드러낸다.
 */
export interface ResolvedModelCoordinate {
  /** 실행할 모델의 정준 id. */
  readonly model: string;
  readonly effort?: string;
  /** 해석된 행. 로스터가 비어 최후 폴백으로 섰으면 null. */
  readonly row: OperationLaunchVariantRow | null;
  readonly fallback: boolean;
  /** `model_off`: 저장된 모델이 로스터 밖. `roster_empty`: 로스터에 아무것도 없다. */
  readonly reason?: "model_off" | "roster_empty";
}

/**
 * 저장 좌표를 로스터에 대조한다. 저장 모델이 비어 있으면 `fallback` 좌표(기본값)를 쓰고, 그것은 폴백이
 * 아니다. 저장 모델이 로스터 밖이면 `fallback` 좌표 → `sonnet` → 첫 행 순으로 서고 `fallback:true`다.
 */
export function resolveRosterCoordinate(
  roster: ModelRoster | null | undefined,
  stored: ModelCoordinate,
  fallback: ModelCoordinate = {},
): ResolvedModelCoordinate {
  const storedModel = stored.model?.trim() || null;
  const wantedEffort = stored.effort ?? fallback.effort;
  const direct = storedModel ? findRosterRow(roster, storedModel) : null;
  if (direct) return seat(direct, wantedEffort, false);
  const defaultRow = findRosterRow(roster, fallback.model ?? null)
    ?? findRosterRow(roster, ROSTER_FALLBACK_MODEL)
    ?? rosterRows(roster)[0]
    ?? null;
  const missed = storedModel !== null;
  if (defaultRow) {
    const resolved = seat(defaultRow, wantedEffort, missed);
    return missed ? { ...resolved, reason: "model_off" } : resolved;
  }
  const effort = isAgentEffort(wantedEffort) || wantedEffort === "ultra" ? wantedEffort : undefined;
  return {
    model: ROSTER_FALLBACK_MODEL,
    ...(effort ? { effort } : {}),
    row: null,
    fallback: true,
    reason: "roster_empty",
  };
}

function seat(row: OperationLaunchVariantRow, wantedEffort: string | null | undefined, fallback: boolean): ResolvedModelCoordinate {
  const effort = clampRosterEffort(rosterRowEfforts(row), wantedEffort);
  return {
    model: canonicalModelId(row.launch.model ?? row.id),
    ...(effort ? { effort } : {}),
    row,
    fallback,
  };
}

/** 서버 포트가 돌려주는 실행 좌표. `wireModel`은 Agent SDK 세션에 그대로 넘기는 모델 문자열이다. */
export interface ResolvedWireCoordinate extends ResolvedModelCoordinate {
  readonly wireModel: string;
}
