import {
  hasClaudeOneMillionMarker,
  normalizeCompactCeiling,
  type CompactCeiling,
} from "../downstream/harness/claude-code/context.js";
import {
  GATEWAY_MODELS,
  GATEWAY_PROVIDER_NAMES,
  GATEWAY_PROVIDERS,
  buildGatewayModelConstraints,
  findGatewayModel,
} from "../models.js";
import { findClaudeGatewayModel, toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";
import type {
  GatewayCapabilityClass,
  GatewayEffortExposure,
  GatewayModel,
  GatewayProvider,
  GatewayReasoningEffort,
} from "../models.js";

// AI Gateway 모델 선별의 저장 형태·카탈로그 대조·검증은 이 패키지가 소유한다. 카탈로그를 아는
// 계층만이 "지금 고를 수 있는 모델·강도"를 판정할 수 있기 때문이다. 호스트는 저장 위치와 HTTP
// 표면만 배선하고, 구 카탈로그가 남긴 stale id는 소비 시점에 여기서 걸러낸다.

/** 저장되는 모델 항목. `efforts` 부재 = 그 모델의 사다리 전체를 노출한다. */
export interface AiGatewayStoredModel {
  readonly id: string;
  readonly efforts?: readonly string[];
  /**
   * true면 모델은 와이어(`/v1/models`, `/v1/messages` 노출 게이트, 실행 선택기)에 남지만
   * 위임 배정 후보에서는 빠진다. 부재는 위임 가능이며, 저장 정규형은 true만 보존한다.
   * Claude family는 Claude Code 네이티브 모델이라 이 표식이 위임에서 빼지 않는다.
   */
  readonly hostOnly?: boolean;
}

/** 위임 후보에서만 본다. Claude 저장 hostOnly는 지우지 않고 위임에서도 빼지 않는다. */
function retainStoredHostOnly(model: GatewayModel, hostOnly: unknown): boolean {
  return hostOnly === true && model.provider !== "claude";
}

/**
 * 로스터를 한 번도 고른 적 없는 설치(`models` 키 부재)에 일회 써 넣는 Claude 항목. Console의 모든 모델 선택지가
 * 이 로스터 하나를 읽으므로, 이행이 없으면 기존 설치의 선택지가 하루아침에 빈다. 써 넣은 항목은 AI Gateway
 * 화면에 그대로 보이고 사용자가 끌 수 있다.
 */
export const DEFAULT_ROSTER_SEED_MODEL_IDS: readonly string[] = ["claude--fable-1m", "claude--opus-1m", "claude--sonnet"];

/**
 * 모델 로스터 이행 판(版). 저장 파일의 `rosterSeedVersion`이 이 값에 닿으면 이행은 끝났다 — 다시 기동해도, 사용자가 그 뒤
 * Claude를 꺼도 되살리지 않는다. 이 판을 올리는 것은 새 이행을 한 번 더 돌리겠다는 결정이다.
 */
export const ROSTER_SEED_VERSION = 1;

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
  const models = Array.isArray(value.models)
    ? value.models
      .filter((entry): entry is AiGatewayStoredModel =>
        isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0)
      .flatMap((entry) => {
        const model = findGatewayModel(entry.id);
        // 카탈로그에서 제거된 모델은 저장 선택에서도 제거한다.
        if (!model) return [];
        const efforts = Array.isArray(entry.efforts)
          ? entry.efforts.filter((level): level is string => typeof level === "string" && level.length > 0)
          : [];
        // 카탈로그에 대조해 지금 고를 수 있는 단계만 남긴다. 이 정규형이 설정 GET이
        // 돌려주는 값이고 클라이언트는 그 배열을 무관한 편집(모델 추가)에도
        // 그대로 되돌려 보내는데, 검증기는 사다리 밖 단계를 거부하므로 카탈로그가 단계를
        // 하나 빼는 순간 그 모델을 지우기 전까지 AI Gateway 저장 전체가 400으로 잠긴다.
        // 빈 배열도 저장하지 않는다 — "정체성 0개"는 노출해 놓고 쓸 수 없는 모델이 된다.
        // 부재와 같은 뜻(사다리 전체)으로 접는다.
        const exposed = efforts.length > 0 ? narrowEffortLadder(model, efforts) : undefined;
        return [{
          id: entry.id,
          ...(exposed ? { efforts: [...exposed] } : {}),
          ...(entry.hostOnly === true ? { hostOnly: true } : {}),
        }];
      })
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
    ...(typeof value.rosterSeedVersion === "number" && Number.isInteger(value.rosterSeedVersion) && value.rosterSeedVersion > 0 ? { rosterSeedVersion: value.rosterSeedVersion } : {}),
    ...(typeof value.wireLogEnabled === "boolean" ? { wireLogEnabled: value.wireLogEnabled } : {}),
    // 라우팅 모델은 카탈로그가 아는 id(정준 실행 id·scoped·레거시 `claude-gateway--` 표기)만 남긴다. 켰는지는
    // 실행 시점에 로스터가 정한다 — 끈 모델의 저장값을 지우면 다시 켰을 때 사용자의 선택이 돌아오지 않는다.
    ...(typeof value.delegationRoutingModel === "string" && findClaudeGatewayModel(value.delegationRoutingModel) ? { delegationRoutingModel: value.delegationRoutingModel } : {}),
    ...(value.delegationRoutingEnabled === true ? { delegationRoutingEnabled: true } : {}),
    ...((value.delegationRoutingMode === "jev" || value.delegationRoutingMode === "model") ? { delegationRoutingMode: value.delegationRoutingMode } : {}),
    ...(providerPriority ? { providerPriority: [...providerPriority] } : {}),
    ...(compactCeiling !== undefined ? { compactCeiling } : {}),
    ...(xaiEndpoint !== undefined ? { xaiEndpoint } : {}),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Gateway 설정을 카탈로그에 대조해 해석한 결과. */
export interface AiGatewaySelection {
  /**
   * Models the gateway exposes to Claude Code — exactly the enabled selection.
   * Opt-in: an absent or empty selection exposes no catalog models, so gateway
   * sessions fall back to Claude Code's built-in models only.
   */
  readonly models: readonly GatewayModel[];
  /**
   * The subset of `models` registered as delegation identities — `models` minus
   * the host-only ones. Its order follows the same provider sort as `models`.
   */
  readonly delegationModels: readonly GatewayModel[];
  /**
   * Scoped model id → the reasoning rungs exposed as delegation identities.
   * An absent entry means that model's whole ladder. This narrowing never
   * reaches the wire: `/v1/models` keeps advertising the catalog ladder, so a
   * model kept at its top rung alone stays usable from the /model picker.
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
  const hostOnlyIds = new Set<string>();
  const effortExposure: Record<string, readonly GatewayReasoningEffort[]> = {};
  for (const entry of settings?.models ?? []) {
    const model = findGatewayModel(entry.id);
    if (!model) continue;
    if (retainStoredHostOnly(model, entry.hostOnly)) hostOnlyIds.add(model.id);
    if (enabled.includes(model)) continue;
    enabled.push(model);
    const exposed = narrowEffortLadder(model, entry.efforts);
    if (exposed) effortExposure[model.id] = exposed;
  }
  // Claude Code's /model picker preserves discovery order under its built-ins.
  // Settings UI is already grouped by GATEWAY_PROVIDERS; expose the same grammar
  // on the wire regardless of Add-click membership order.
  const models = sortGatewayModelsByProvider(enabled);
  const delegationModels = models.filter((model) => !hostOnlyIds.has(model.id));
  return {
    models,
    delegationModels,
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
  if (record.models !== undefined) {
    if (!Array.isArray(record.models)) return { ok: false };
    for (const raw of record.models) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
      const entry = raw as { readonly id?: unknown; readonly efforts?: unknown; readonly hostOnly?: unknown };
      if (Object.keys(entry).some((key) => key !== "id" && key !== "efforts" && key !== "hostOnly")) {
        return { ok: false };
      }
      if (typeof entry.id !== "string") return { ok: false };
      if (entry.hostOnly !== undefined && typeof entry.hostOnly !== "boolean") return { ok: false };
      const model = findGatewayModel(entry.id);
      if (!model) return { ok: false };
      if (models.some((existing) => existing.id === model.id)) return { ok: false };
      const efforts = parseExposedEfforts(model, entry.efforts);
      if (efforts === null) return { ok: false };
      models.push({
        id: model.id,
        ...(efforts ? { efforts } : {}),
        ...(entry.hostOnly === true ? { hostOnly: true } : {}),
      });
    }
  }

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
      ...(record.models !== undefined ? { models } : {}),
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
  /** Scoped gateway model id, e.g. `codex--gpt-6-sol`. */
  readonly id: string;
  /** Bare model label without the provider prefix. */
  readonly name: string;
  readonly contextWindow: number | null;
  /** True when Claude Code accounts this model on its 1M coordinate (`[1m]` alias). */
  readonly oneMillion: boolean;
  /** Fast variants are separate catalog models paired by the `-fast` id suffix. */
  readonly fast: boolean;
  /**
   * The provider's own lineup positioning. `null` on routing aliases, which
   * serve a different model per call and would be misdescribed by any single
   * class — the roster shows that absence rather than inventing a grade.
   */
  readonly capabilityClass: GatewayCapabilityClass | null;
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
    contextWindow: model.contextWindow ?? null,
    oneMillion: hasClaudeOneMillionMarker(toClaudeGatewayModelId(model)),
    fast: model.id.endsWith("-fast"),
    capabilityClass: model.capabilityClass ?? null,
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
