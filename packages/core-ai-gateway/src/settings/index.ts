import {
  hasClaudeOneMillionMarker,
  normalizeCompactCeiling,
  type CompactCeiling,
} from "../anthropic/claude-context.js";
import {
  GATEWAY_MODELS,
  GATEWAY_PROVIDER_NAMES,
  GATEWAY_PROVIDERS,
  buildGatewayModelConstraints,
  findGatewayModel,
  toClaudeGatewayModelId,
} from "../models.js";
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

/** 저장되는 모델 항목. `efforts` 부재 = 그 모델의 사다리 전체를 정체성으로 내보낸다. */
export interface AiGatewayStoredModel {
  readonly id: string;
  readonly efforts?: readonly string[];
  /**
   * true면 모델은 와이어(`/v1/models`, `/v1/messages` 노출 게이트, 실행 선택기)에 남지만
   * 위임 정체성을 등록하지 않고 `gateway_models` 로스터에서도 제외한다. 부재는 위임 가능이며,
   * 저장 정규형은 true만 보존한다.
   */
  readonly hostOnly?: boolean;
}

/** AI Gateway 설정 파일에 저장되는 형태. models 부재/공백 = 미구성(노출 없음). */
export interface AiGatewayStoredSettings {
  readonly version: 1;
  readonly models?: readonly AiGatewayStoredModel[];
  /** 부재/false는 기본 Off. 저장 정규형은 opt-in인 true만 보존한다. */
  readonly cursorDiagnosticsEnabled?: boolean;
  /**
   * 부재는 env(`FLEET_GATEWAY_WIRE_LOG`) 폴백, true/false는 호스트가 강제하는 On/Off다.
   * 위 `cursorDiagnosticsEnabled`와 달리 **false를 정규형에서 지우면 안 된다** — env를 켜 둔 설치에서
   * 사용자가 UI로 Off한 뒤 재시작하면 부재가 다시 env 상속으로 읽혀 로깅이 되살아나고,
   * 토글이 꺼지지 않는 결함이 된다.
   */
  readonly wireLogEnabled?: boolean;
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
        // 카탈로그를 떠난 모델은 저장에서도 접는다. 남겨두면 GET이 stale id를 클라이언트로
        // 돌려보내고 클라이언트는 무관한 편집에도 전체 선택을 되돌려 보내므로, 검증기가
        // 그 id를 거부해 모델을 지우기 전까지 AI Gateway 저장 전체가 400으로 잠긴다 —
        // 아래 사다리-밖 단계 접기와 같은 규율의 모델 축이다.
        const model = findGatewayModel(entry.id);
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
  return {
    version: 1,
    ...(models.length > 0 ? { models } : {}),
    ...(value.cursorDiagnosticsEnabled === true ? { cursorDiagnosticsEnabled: true } : {}),
    ...(typeof value.wireLogEnabled === "boolean" ? { wireLogEnabled: value.wireLogEnabled } : {}),
    ...(providerPriority ? { providerPriority: [...providerPriority] } : {}),
    ...(compactCeiling !== undefined ? { compactCeiling } : {}),
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
}

export function resolveAiGatewaySelection(settings: AiGatewayStoredSettings | undefined): AiGatewaySelection {
  const enabled: GatewayModel[] = [];
  const hostOnlyIds = new Set<string>();
  const effortExposure: Record<string, readonly GatewayReasoningEffort[]> = {};
  for (const entry of settings?.models ?? []) {
    const model = findGatewayModel(entry.id);
    if (!model) continue;
    if (entry.hostOnly === true) hostOnlyIds.add(model.id);
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
  return { models, delegationModels, effortExposure, providerPriority: settings?.providerPriority };
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

/** Stable provider clusters (codex → xai → cursor → opencode → kimi), then catalog order within each. */
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

  if (models.length === 0 && providerPriority === undefined) {
    return { ok: true, value: undefined };
  }
  return {
    ok: true,
    value: {
      ...(models.length > 0 ? { models } : {}),
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
  /** Scoped gateway model id, e.g. `cursor--grok-4.5`. */
  readonly id: string;
  /** Bare model label without the provider prefix. */
  readonly name: string;
  readonly contextWindow: number | null;
  /** True when Claude Code accounts this model on its 1M coordinate (`[1m]` alias). */
  readonly oneMillion: boolean;
  /** Cursor Run's Max Mode models carry separate billing semantics. */
  readonly maxMode: boolean;
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
    maxMode: model.cursorMaxMode === true,
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
