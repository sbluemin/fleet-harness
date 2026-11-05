import {
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  hasClaudeOneMillionMarker,
  normalizeCompactCeiling,
  type CompactCeiling,
} from "../downstream/harness/claude-code/context.js";
import {
  GATEWAY_MODELS,
  GATEWAY_PROVIDER_NAMES,
  GATEWAY_PROVIDERS,
  GATEWAY_REASONING_EFFORTS,
  buildGatewayModelConstraints,
  findGatewayModel,
} from "../models.js";
import { findClaudeGatewayModel, toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";
import type {
  GatewayEffortExposure,
  GatewayModel,
  GatewayProvider,
  GatewayReasoningEffort,
} from "../models.js";
import { aiGatewayModelFamilyKey, canonicalEffortSelection } from "../model-family.js";

// AI Gateway 모델 선별의 저장 형태·카탈로그 대조·검증은 이 패키지가 소유한다. 카탈로그를 아는
// 계층만이 "지금 고를 수 있는 모델·강도"를 판정할 수 있기 때문이다. 호스트는 저장 위치와 HTTP
// 표면만 배선하고, 구 카탈로그가 남긴 stale id는 소비 시점에 여기서 걸러낸다.

/**
 * 저장되는 모델 항목. `efforts` 부재 = 그 모델의 사다리 전체를 위임에 연다.
 * 켠 항목이 곧 위임 후보다. 예전의 `hostOnly`는 저장하지 않는다.
 */
export interface AiGatewayStoredModel {
  readonly id: string;
  readonly efforts?: readonly string[];
}

/** 4판 이전 파일에만 있던 표식. 정규화 입력으로만 읽고, 4판부터는 저장하지 않는다. */
interface LegacyStoredModel extends AiGatewayStoredModel {
  readonly hostOnly?: boolean;
}

/**
 * 로스터를 한 번도 고른 적 없는 설치(`models` 키 부재)에 일회 써 넣는 Claude 항목. Console의 모든 모델 선택지가
 * 이 로스터 하나를 읽으므로, 이행이 없으면 기존 설치의 선택지가 하루아침에 빈다. 써 넣은 항목은 AI Gateway
 * 화면에 그대로 보이고 사용자가 끌 수 있다.
 */
export const DEFAULT_ROSTER_SEED_MODEL_IDS: readonly string[] = ["claude--fable-1m", "claude--opus-1m", "claude--sonnet-1m"];

/**
 * 모델 로스터 이행 판(版). 저장 파일의 `rosterSeedVersion`이 이 값에 닿으면 이행은 끝났다 — 다시 기동해도, 사용자가 그 뒤
 * Claude를 끄거나 호스트 전용으로 다시 지정해도 되돌리지 않는다. 이 판을 올리는 것은 새 이행을 한 번 더 돌리겠다는 결정이다.
 *
 * - 1: 로스터를 고른 적 없는 설치에 Claude 항목을 써 넣는다.
 * - 2: Claude 호스트 전용이 무시되던 시기(2026-09-22~)의 저장값 `hostOnly:true`를 한 번 해제한다 — 그 시기 화면은 그 값을
 *   꺼진 것으로 보였으므로, 되살리면 사용자가 모르는 사이 Claude가 위임에서 빠진다.
 * - 3: Claude 가족이 모두 1M 단일 항목이 된 뒤, 저장값에 남은 bare/200k scoped id(`claude--sonnet`)를 가족의 1M id로 접어
 *   영속한다. 같은 가족의 두 좌표는 한 행으로 합친다({@link normalizeAiGatewaySettings}). 끈 Claude·빈 로스터는 되살리지 않는다.
 * - 4: 켠 목록이 곧 위임 후보가 된다. `hostOnly: true` 항목은 켠 목록에서 빼고, 한 계열의 변형은 컨텍스트 창이 가장 큰
 *   것 하나만 남기며(같으면 저장 순서상 먼저), 강도는 low·medium·high를 합치고 켜 둔 xhigh·max만 유지한다.
 */
export const ROSTER_SEED_VERSION = 4;

/**
 * 카탈로그 모델의 컨텍스트 창. Claude 가족 항목은 모두 카탈로그에 1M 창이 있다 — 창 없는 Claude 항목이 생기면 Claude Code의
 * 기본 200k 좌표로 읽는다. 다른 공급자는 카탈로그 값을 그대로 쓴다. Models 응답(설정 카탈로그·`fleet gateway models`·Console 로스터)이 Claude를
 * 다른 모델과 같은 정보로 내리도록 이 한 곳에서 정한다.
 */
export function gatewayModelContextWindow(model: GatewayModel): number | null {
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) return model.contextWindow;
  return model.provider === "claude" ? CLAUDE_DEFAULT_CONTEXT_WINDOW : null;
}

/**
 * AI Gateway 설정 파일에 저장되는 형태. models 부재 = 한 번도 고르지 않음(기본 로스터 이행 대상),
 * 빈 배열 = 사용자가 모두 끔. 둘 다 노출은 없다.
 */
export interface AiGatewayStoredSettings {
  readonly version: 1;
  readonly models?: readonly AiGatewayStoredModel[];
  /**
   * 마지막으로 끝난 모델 로스터 이행 판({@link ROSTER_SEED_VERSION}). 부재는 이행 전이다. 이행은 이 표식으로 한 번만 돈다.
   */
  readonly rosterSeedVersion?: number;
  /**
   * 부재는 env(`FLEET_GATEWAY_WIRE_LOG`) 폴백, true/false는 호스트가 강제하는 On/Off다.
   * **false를 정규형에서 지우면 안 된다** — env를 켜 둔 설치에서
   * 사용자가 UI로 Off한 뒤 재시작하면 부재가 다시 env 상속으로 읽혀 로깅이 되살아나고,
   * 토글이 꺼지지 않는 결함이 된다.
   */
  readonly wireLogEnabled?: boolean;
  /** AI 판단은 명시적으로 켠 경우에만 사용한다. 부재·false는 로컬 규칙 기반 fallback이다. */
  readonly delegationRoutingEnabled?: boolean;
  /**
   * How delegated runs are assigned a model when {@link delegationRoutingEnabled}
   * is on. Absent means AI model — Console asks the selected model
   * using the complete model data. `"jev"` opts into TypeSafe/Jev choice selection;
   * The default mode is "model"; the default decision model is Sonnet.
   */
  readonly delegationRoutingMode?: DelegationRoutingMode;
  readonly delegationRoutingModel?: string;
  /**
   * Reasoning effort of the routing judge. Absent keeps the default: `low` when
   * the launched model's ladder has it, otherwise that ladder's first rung.
   * A rung the launched model does not offer is clamped when the turn starts, not here,
   * so a later model change does not discard the stored choice.
   */
  readonly delegationRoutingEffort?: GatewayReasoningEffort;
  /**
   * The user's opt-in ordered preference for which provider allowances to spend
   * first. It weights the allowance axis of run distribution only and never
   * overrides quality evidence; absent means no preference.
   */
  readonly providerPriority?: readonly GatewayProvider[];
  /**
   * Global compact-timing policy. Absent is Auto (window − 16k).
   * `"early"` / `"late"` are 88 / 97 percent of the catalog window.
   * A number is a Custom percent, 70–99.
   */
  readonly compactCeiling?: CompactCeiling;
  /**
   * Which xAI endpoint every subscription turn uses. Absent is
   * {@link DEFAULT_XAI_ENDPOINT_PREFERENCE}.
   *
   * Both endpoints serve the same subscription and the same credential, and a turn never
   * crosses between them: they do not share a prompt cache, so a crossing re-prefills the whole
   * conversation. `direct` answers a warm request slightly faster but is the shared
   * standard-tier pool — measured 2026-08-20 it refused outright with `"The model is currently
   * at capacity"` and, on other samples, parked 10.6s and 68.7s before `response.created`.
   * `cli-proxy` is the Grok CLI's own pool, whose worst sample in the same run was 1.5s, which
   * is why it is the default.
   */
  readonly xaiEndpoint?: XaiEndpointPreference;
}

/** Where an xAI subscription turn is sent first. */
/** How Fleet assigns a model to each delegated run when routing is on. */
export type DelegationRoutingMode = "jev" | "model";

export const DELEGATION_ROUTING_MODES: readonly DelegationRoutingMode[] = ["jev", "model"];

export type XaiEndpointPreference = "direct" | "cli-proxy";

export const XAI_ENDPOINT_PREFERENCES: readonly XaiEndpointPreference[] = ["direct", "cli-proxy"];

export const DEFAULT_XAI_ENDPOINT_PREFERENCE: XaiEndpointPreference = "cli-proxy";

function sanitizeXaiEndpoint(value: unknown): XaiEndpointPreference | undefined {
  return typeof value === "string" && XAI_ENDPOINT_PREFERENCES.includes(value as XaiEndpointPreference)
    ? value as XaiEndpointPreference
    : undefined;
}

export interface AiGatewayUpdateValue {
  readonly models?: readonly AiGatewayStoredModel[];
  /**
   * The user's opt-in ordered spend preference. An empty array explicitly clears
   * it; an absent key preserves the stored value because the store carries it over.
   */
  readonly providerPriority?: readonly GatewayProvider[];
}

export function normalizeAiGatewaySettings(value: unknown): AiGatewayStoredSettings {
  if (!isRecord(value) || value.version !== 1) return { version: 1 };
  const rosterSeedVersion = typeof value.rosterSeedVersion === "number"
    && Number.isInteger(value.rosterSeedVersion)
    && value.rosterSeedVersion > 0
    ? value.rosterSeedVersion
    : 0;
  const models = Array.isArray(value.models)
    ? canonicalizeStoredModels(value.models.filter((entry): entry is LegacyStoredModel =>
      isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0), rosterSeedVersion)
    : [];
  // 레거시 defaultModel 키는 조용히 버린다 — 저장하지도, 보존하지도 않는다.
  const providerPriority = sanitizeProviderPriority(value.providerPriority);
  const compactCeiling = normalizeCompactCeiling(value.compactCeiling);
  // The default value is kept rather than folded away: absence means "never chosen", and a
  // later default change must not silently move an installation the user deliberately pinned.
  const xaiEndpoint = sanitizeXaiEndpoint(value.xaiEndpoint);
  return {
    version: 1,
    // 빈 배열도 보존한다 — 「모델을 모두 껐다」는 사용자의 선택이고, 키 부재(한 번도 고른 적 없음)와 달리
    // 기본 로스터 이행(seedDefaultModels)의 대상이 아니다.
    ...(Array.isArray(value.models) ? { models } : {}),
    ...(rosterSeedVersion > 0 ? { rosterSeedVersion } : {}),
    ...(typeof value.wireLogEnabled === "boolean" ? { wireLogEnabled: value.wireLogEnabled } : {}),
    // 라우팅 모델은 카탈로그가 아는 id(정준 실행 id·scoped·레거시 `claude-gateway--` 표기)만 남긴다. 켰는지는
    // 실행 시점에 로스터가 정한다 — 끈 모델의 저장값을 지우면 다시 켰을 때 사용자의 선택이 돌아오지 않는다.
    ...(typeof value.delegationRoutingModel === "string" && findClaudeGatewayModel(value.delegationRoutingModel)
      ? { delegationRoutingModel: canonicalRoutingModel(value.delegationRoutingModel) }
      : {}),
    ...(isGatewayReasoningEffort(value.delegationRoutingEffort)
      ? { delegationRoutingEffort: value.delegationRoutingEffort }
      : {}),
    ...(value.delegationRoutingEnabled === true ? { delegationRoutingEnabled: true } : {}),
    ...((value.delegationRoutingMode === "jev" || value.delegationRoutingMode === "model") ? { delegationRoutingMode: value.delegationRoutingMode } : {}),
    ...(providerPriority ? { providerPriority: [...providerPriority] } : {}),
    ...(compactCeiling !== undefined ? { compactCeiling } : {}),
    ...(xaiEndpoint !== undefined ? { xaiEndpoint } : {}),
  };
}

/** 저장할 모델 id. Claude 가족은 bare·200k scoped·1M 어느 표기든 가족의 단일 1M id(`claude--sonnet-1m`)다. */
function storedModelId(model: GatewayModel, id: string): string {
  return model.provider === "claude" ? model.id : id;
}

/** 라우팅 판정 모델의 저장값. Claude 가족은 실행 정준 alias(`sonnet[1m]`)로 접고, 다른 공급자의 표기는 그대로 둔다. */
function canonicalRoutingModel(id: string): string {
  const model = findClaudeGatewayModel(id);
  return model?.provider === "claude" ? toClaudeGatewayModelId(model) : id;
}

/**
 * 같은 id를 가리키는 저장 항목을 먼저 나온 자리 한 행으로 합친다 — 구 Claude 200k·1M 두 좌표가 한 항목으로 접힐 때다.
 * 강도는 어느 한쪽이 전체면 전체, 둘 다 좁혔으면 합집합을 사다리 순으로 남긴다. 4판 이전의 `hostOnly`는
 * 어느 한쪽이라도 켰으면 유지한다 — 한 행이 두 좌표의 다른 위임 권한을 모두 담을 수는 없다.
 */
function mergeStoredModels(entries: readonly LegacyStoredModel[], keepHostOnly: boolean): LegacyStoredModel[] {
  const merged: LegacyStoredModel[] = [];
  for (const entry of entries) {
    const index = merged.findIndex((existing) => existing.id === entry.id);
    if (index < 0) {
      merged.push(entry);
      continue;
    }
    const existing = merged[index]!;
    const model = findGatewayModel(entry.id);
    const efforts = existing.efforts && entry.efforts && model
      ? narrowEffortLadder(model, [...existing.efforts, ...entry.efforts])
      : undefined;
    const hostOnly = keepHostOnly && (existing.hostOnly === true || entry.hostOnly === true);
    merged[index] = {
      id: existing.id,
      ...(efforts ? { efforts: [...efforts] } : {}),
      ...(hostOnly ? { hostOnly: true } : {}),
    };
  }
  return merged;
}

/**
 * 저장 모델을 카탈로그에 접고, 4판부터는 계열당 하나·low–high 합집합으로 정규화한다.
 * 4판 이전에는 `hostOnly`를 보존한다 — 시드가 그 표식을 보고 항목을 빼기 전에 정규화가 지우면 안 된다.
 */
function canonicalizeStoredModels(entries: readonly LegacyStoredModel[], rosterSeedVersion: number): AiGatewayStoredModel[] {
  const keepHostOnly = rosterSeedVersion < 4;
  const folded = mergeStoredModels(entries.flatMap((entry) => {
    const model = findGatewayModel(entry.id);
    if (!model) return [];
    const efforts = Array.isArray(entry.efforts)
      ? entry.efforts.filter((level): level is string => typeof level === "string" && level.length > 0)
      : [];
    // 카탈로그에 대조해 지금 고를 수 있는 단계만 남긴다. 빈 배열은 부재(사다리 전체)로 접는다.
    const exposed = efforts.length > 0 ? narrowEffortLadder(model, efforts) : undefined;
    return [{
      id: storedModelId(model, entry.id),
      ...(exposed ? { efforts: [...exposed] } : {}),
      ...(keepHostOnly && entry.hostOnly === true ? { hostOnly: true as const } : {}),
    }];
  }), keepHostOnly);
  // 4판 이전에는 hostOnly를 객체에 남겨 시드가 읽게 한다. 타입에는 그 키를 싣지 않는다.
  if (keepHostOnly) return folded as unknown as AiGatewayStoredModel[];
  return collapseStoredFamilies(folded).map((entry) => withCanonicalEfforts(entry));
}

function collapseStoredFamilies(entries: readonly LegacyStoredModel[]): LegacyStoredModel[] {
  const kept: LegacyStoredModel[] = [];
  const index = new Map<string, number>();
  for (const entry of entries) {
    const key = aiGatewayModelFamilyKey(entry.id);
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, kept.length);
      kept.push(entry);
      continue;
    }
    const current = kept[at]!;
    if (contextTokens(entry.id) > contextTokens(current.id)) kept[at] = entry;
  }
  return kept;
}

function contextTokens(id: string): number {
  const model = findGatewayModel(id);
  if (!model) return -1;
  return gatewayModelContextWindow(model) ?? -1;
}

function withCanonicalEfforts(entry: LegacyStoredModel): AiGatewayStoredModel {
  const model = findGatewayModel(entry.id);
  if (!model) return { id: entry.id, ...(entry.efforts ? { efforts: entry.efforts } : {}) };
  const efforts = canonicalEffortSelection(exposableEffortLadder(model), entry.efforts);
  return { id: entry.id, ...(efforts ? { efforts: [...efforts] } : {}) };
}

function sanitizeProviderPriority(value: unknown): readonly GatewayProvider[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<GatewayProvider>();
  const cleaned: GatewayProvider[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (!GATEWAY_PROVIDERS.includes(entry as GatewayProvider)) continue;
    const provider = entry as GatewayProvider;
    if (seen.has(provider)) continue;
    seen.add(provider);
    cleaned.push(provider);
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

function isGatewayReasoningEffort(value: unknown): value is GatewayReasoningEffort {
  return typeof value === "string" && (GATEWAY_REASONING_EFFORTS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Gateway 설정을 카탈로그에 대조해 해석한 결과. */
export interface AiGatewaySelection {
  /**
   * 켠 모델. 위임 후보와 같다. Console 메뉴와 `/model`은 이 목록이 아니라
   * 로그인된 공급자의 카탈로그를 본다.
   */
  readonly models: readonly GatewayModel[];
  /**
   * 위임 배정 후보. 켠 목록과 같다 — `models`와 같은 배열이다.
   */
  readonly delegationModels: readonly GatewayModel[];
  /**
   * 모델 id → 위임에 줄 강도. 부재는 그 모델의 사다리 전체.
   * 메뉴·수동 실행의 강도 축은 이 맵이 아니라 카탈로그 사다리다.
   */
  readonly effortExposure: GatewayEffortExposure;
  /** Opt-in provider allowance spend order; absent means no preference. */
  readonly providerPriority: readonly GatewayProvider[] | undefined;
  /** AI 판단 활성화 여부. Off여도 로컬 fallback은 모델을 배정한다. */
  readonly delegationRoutingEnabled: boolean;
  /** Resolved routing mode when delegation is on. Absent stored value uses the AI model. */
  readonly delegationRoutingMode: DelegationRoutingMode;
}

export function resolveAiGatewaySelection(settings: AiGatewayStoredSettings | undefined): AiGatewaySelection {
  const enabled: GatewayModel[] = [];
  const effortExposure: Record<string, readonly GatewayReasoningEffort[]> = {};
  // 정규화를 거치지 않은 저장값도 같은 규칙으로 읽는다. 4판 이전이면 hostOnly를 보존한 채 두고,
  // 시드가 빼기 전에는 켠 목록에 남긴다(표식은 위임에서 더 이상 갈라내지 않는다).
  const entries = canonicalizeStoredModels((settings?.models ?? []) as readonly LegacyStoredModel[], settings?.rosterSeedVersion ?? 0);
  for (const entry of entries) {
    const model = findGatewayModel(entry.id);
    if (!model || enabled.includes(model)) continue;
    enabled.push(model);
    const exposed = entry.efforts;
    if (exposed && exposed.length > 0) effortExposure[model.id] = exposed as readonly GatewayReasoningEffort[];
  }
  const models = sortGatewayModelsByProvider(enabled);
  return {
    models,
    delegationModels: models,
    effortExposure,
    providerPriority: settings?.providerPriority,
    delegationRoutingEnabled: settings?.delegationRoutingEnabled === true,
    delegationRoutingMode: settings?.delegationRoutingMode ?? "model",
  };
}

/**
 * 저장된 강도 선택을 그 모델이 실제로 내보낼 수 있는 사다리로 좁힌다.
 * 사다리 순서를 유지하고, 좁히지 않는 선택(전체이거나 겹치는 게 없음)은
 * `undefined`를 돌려 노출 맵에서 아예 빠지게 한다.
 */
function narrowEffortLadder(
  model: GatewayModel,
  efforts: readonly string[] | undefined,
): readonly GatewayReasoningEffort[] | undefined {
  if (!efforts || efforts.length === 0) return undefined;
  const ladder = buildGatewayModelConstraints(model).effortLadder;
  const narrowed = ladder.filter((rung) => efforts.includes(rung));
  if (narrowed.length === 0 || narrowed.length === ladder.length) return undefined;
  return narrowed;
}

/** 설정 UI와 검증기가 공유하는 "사용자가 고를 수 있는 강도" — Anthropic 와이어가 살려내는 사다리. */
export function exposableEffortLadder(model: GatewayModel): readonly GatewayReasoningEffort[] {
  return buildGatewayModelConstraints(model).effortLadder;
}

/** Stable provider clusters in {@link GATEWAY_PROVIDERS} order, then catalog order within each. */
function sortGatewayModelsByProvider(models: readonly GatewayModel[]): GatewayModel[] {
  return [...models].sort((left, right) => {
    const providerDelta =
      GATEWAY_PROVIDERS.indexOf(left.provider) - GATEWAY_PROVIDERS.indexOf(right.provider);
    if (providerDelta !== 0) return providerDelta;
    return GATEWAY_MODELS.indexOf(left) - GATEWAY_MODELS.indexOf(right);
  });
}

/** 설정 PUT 본문의 aiGateway 값을 카탈로그에 대조 검증한다. `undefined` 값은 설정 해제를 뜻한다. */
export function parseAiGatewayUpdate(value: unknown):
  | { readonly ok: true; readonly value: AiGatewayUpdateValue | undefined }
  | { readonly ok: false } {
  if (value === null) return { ok: true, value: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const record = value as {
    readonly models?: unknown;
    readonly defaultModel?: unknown;
    readonly providerPriority?: unknown;
  };
  const extraKeys = Object.keys(record).filter(
    (key) => key !== "models" && key !== "defaultModel" && key !== "providerPriority",
  );
  if (extraKeys.length > 0) return { ok: false };

  const models: AiGatewayStoredModel[] = [];
  const rawIds = new Set<string>();
  if (record.models !== undefined) {
    if (!Array.isArray(record.models)) return { ok: false };
    for (const raw of record.models) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
      const entry = raw as { readonly id?: unknown; readonly efforts?: unknown; readonly hostOnly?: unknown };
      // 옛 클라이언트의 hostOnly는 어떤 값이든 버린다. 그 키만으로 400을 주지 않고, 항목은 켠 채로 남긴다.
      if (Object.keys(entry).some((key) => key !== "id" && key !== "efforts" && key !== "hostOnly")) {
        return { ok: false };
      }
      if (typeof entry.id !== "string") return { ok: false };
      const model = findGatewayModel(entry.id);
      if (!model) return { ok: false };
      // 같은 모델을 두 번 보내는 것은 거부한다. 다만 구 Claude 좌표(`claude--sonnet`)와 1M id처럼 표기만 다른 같은 가족은
      // 옛 화면이 보낸 값이므로 아래에서 한 행으로 합친다. 계열의 다른 변형(창·Fast)은 정규화가 하나 남긴다.
      if (models.some((existing) => existing.id === model.id) && (model.provider !== "claude" || rawIds.has(entry.id))) {
        return { ok: false };
      }
      rawIds.add(entry.id);
      const efforts = parseExposedEfforts(model, entry.efforts);
      if (efforts === null) return { ok: false };
      models.push({
        id: model.id,
        ...(efforts ? { efforts } : {}),
      });
    }
  }
  const mergedModels = canonicalizeStoredModels(models, 4);

  // 레거시 defaultModel 키는 허용하되 무시한다 — 저장하지도, extra key로 거부하지도 않는다.

  let providerPriority: GatewayProvider[] | undefined;
  const hasProviderPriority = Object.prototype.hasOwnProperty.call(record, "providerPriority");
  if (hasProviderPriority) {
    if (!Array.isArray(record.providerPriority)) return { ok: false };
    providerPriority = [];
    for (const raw of record.providerPriority) {
      if (typeof raw !== "string") return { ok: false };
      if (!GATEWAY_PROVIDERS.includes(raw as GatewayProvider)) return { ok: false };
      const provider = raw as GatewayProvider;
      if (providerPriority.includes(provider)) return { ok: false };
      providerPriority.push(provider);
    }
  }

  if (record.models === undefined && providerPriority === undefined) {
    return { ok: true, value: undefined };
  }
  return {
    ok: true,
    value: {
      // 명시한 빈 배열은 「모두 끔」이라는 선택이다. 부재로 접으면 다음 기동의 기본 로스터 이행이 되살린다.
      ...(record.models !== undefined ? { models: mergedModels } : {}),
      ...(providerPriority !== undefined ? { providerPriority } : {}),
    },
  };
}

/**
 * 모델 항목의 `efforts`를 그 모델의 사다리에 대조한다.
 * `null` = 거부, `undefined` = 좁히지 않음(전체 노출과 같으므로 저장하지 않는다).
 */
function parseExposedEfforts(
  model: GatewayModel,
  value: unknown,
): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const ladder = exposableEffortLadder(model);
  const seen: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    if (!ladder.includes(raw as GatewayReasoningEffort)) return null;
    if (seen.includes(raw)) return null;
    seen.push(raw);
  }
  // 사다리가 없는 모델에 강도를 붙이는 것도, 하나도 남기지 않는 것도 거부한다.
  if (seen.length === 0) return null;
  const ordered = ladder.filter((rung) => seen.includes(rung));
  return ordered.length === ladder.length ? undefined : ordered;
}

/** 설정 UI가 소비하는 카탈로그 투영. 모델 노출 여부와 무관하게 전체 카탈로그를 담는다. */
export interface AiGatewayCatalog {
  readonly providers: readonly AiGatewayCatalogProvider[];
}

export interface AiGatewayCatalogProvider {
  readonly id: GatewayProvider;
  readonly models: readonly AiGatewayCatalogModel[];
}

export interface AiGatewayCatalogModel {
  /** Scoped gateway model id, e.g. `codex--gpt-6.1-sol`. */
  readonly id: string;
  /** Bare model label without the provider prefix. */
  readonly name: string;
  readonly contextWindow: number | null;
  /** True when Claude Code accounts this model on its 1M coordinate (`[1m]` alias). */
  readonly oneMillion: boolean;
  /** Fast variants are separate catalog models paired by the `-fast` id suffix. */
  readonly fast: boolean;
  readonly description: string | null;
  /**
   * The rungs this model can be exposed at. Not the raw catalog ladder: a level
   * the Anthropic wire cannot carry is dropped upstream with no signal, so
   * offering it here would let the user pick a rung that never becomes an
   * identity. Effort inside a session stays Claude Code's own (`/effort`).
   */
  readonly effort: { readonly levels: readonly string[] } | null;
}

export function buildAiGatewayCatalog(models: readonly GatewayModel[] = GATEWAY_MODELS): AiGatewayCatalog {
  return {
    providers: GATEWAY_PROVIDERS.map((provider) => ({
      id: provider,
      models: models
        .filter((model) => model.provider === provider)
        .map((model) => toCatalogModel(model)),
    })),
  };
}

function toCatalogModel(model: GatewayModel): AiGatewayCatalogModel {
  const levels = exposableEffortLadder(model);
  return {
    id: model.id,
    name: bareModelName(model),
    contextWindow: gatewayModelContextWindow(model),
    oneMillion: hasClaudeOneMillionMarker(toClaudeGatewayModelId(model)),
    fast: model.id.endsWith("-fast"),
    description: model.description ?? null,
    effort: levels.length > 0 ? { levels } : null,
  };
}

// displayName은 Claude Code /model picker용 provider-접두 라벨이다. Settings·launch menus는
// provider 그룹 안에서 표시하므로 접두를 벗긴 소재 이름을 쓴다.
export function bareModelName(model: GatewayModel): string {
  const prefix = `${GATEWAY_PROVIDER_NAMES[model.provider]}-`;
  return model.displayName.startsWith(prefix) ? model.displayName.slice(prefix.length) : model.displayName;
}
