import {
  GATEWAY_MODELS,
  GATEWAY_PROVIDER_NAMES,
  GATEWAY_PROVIDERS,
  buildGatewayModelConstraints,
  findGatewayModel,
  hasClaudeOneMillionMarker,
  toClaudeGatewayModelId,
} from "@dotobokuri/core-ai-gateway";
import type {
  GatewayModel,
  GatewayProvider,
  GatewayReasoningEffort,
} from "@dotobokuri/core-ai-gateway";
import type { GatewayEffortExposure } from "@dotobokuri/fleet-admiral";
import type { FleetPluginStorageHost } from "@fleet-console/sdk/plugin";

// AI Gateway 모델 선별은 콘솔 durable state의 terminal 플러그인 네임스페이스에 저장된다
// (console settings.json → plugins.terminal["ai-gateway"]). 저장 형태는 이 모듈이 보증하고,
// 카탈로그 대조(모델 존재, 기본 모델 소속)도 카탈로그를 아는 이 계층이 소유한다.
// 구 카탈로그가 남긴 stale id는 소비 시점에 걸러낸다.

export const AI_GATEWAY_SETTINGS_STORAGE_KEY = "ai-gateway";

/** 저장되는 모델 항목. `efforts` 부재 = 그 모델의 사다리 전체를 정체성으로 내보낸다. */
export interface AiGatewayStoredModel {
  readonly id: string;
  readonly efforts?: readonly string[];
}

/** `plugins.terminal["ai-gateway"]`에 저장되는 형태. models 부재/공백 = 미구성(노출 없음). */
export interface AiGatewayStoredSettings {
  readonly version: 1;
  readonly models?: readonly AiGatewayStoredModel[];
  readonly defaultModel?: string;
  /** 부재/false는 기본 Off. 저장 정규형은 opt-in인 true만 보존한다. */
  readonly cursorDiagnosticsEnabled?: boolean;
}

export function normalizeAiGatewaySettings(value: unknown): AiGatewayStoredSettings {
  if (!isRecord(value) || value.version !== 1) return { version: 1 };
  const models = Array.isArray(value.models)
    ? value.models
      .filter((entry): entry is AiGatewayStoredModel =>
        isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0)
      .map((entry) => {
        const efforts = Array.isArray(entry.efforts)
          ? entry.efforts.filter((level): level is string => typeof level === "string" && level.length > 0)
          : [];
        // 빈 배열은 저장하지 않는다 — "정체성 0개"를 뜻하게 두면 노출해 놓고 쓸 수 없는
        // 모델이 생긴다. 부재와 같은 뜻(사다리 전체)으로 접는다.
        return efforts.length > 0 ? { id: entry.id, efforts } : { id: entry.id };
      })
    : [];
  const defaultModel = typeof value.defaultModel === "string" && value.defaultModel.length > 0
    ? value.defaultModel
    : undefined;
  return {
    version: 1,
    ...(models.length > 0 ? { models } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(value.cursorDiagnosticsEnabled === true ? { cursorDiagnosticsEnabled: true } : {}),
  };
}

// 같은 서버 프로세스의 이 모듈 인스턴스에서 read+write만 직렬화한다(agent-cli-paths와 동일 관례).
let aiGatewaySettingsWriteTail: Promise<void> = Promise.resolve();

export interface AiGatewaySettingsStore {
  readonly read: () => Promise<AiGatewayStoredSettings>;
  /** 진단 opt-in은 보존하고 모델 선별만 교체한다. */
  readonly write: (value: AiGatewayUpdateValue | undefined) => Promise<AiGatewayStoredSettings>;
  /** 모델 선별은 보존하고 진단 opt-in만 갱신한다. */
  readonly writeCursorDiagnosticsEnabled: (enabled: boolean) => Promise<AiGatewayStoredSettings>;
}

export interface AiGatewayUpdateValue {
  readonly models?: readonly AiGatewayStoredModel[];
  readonly defaultModel?: string;
}

export function createAiGatewaySettingsStore(storage: FleetPluginStorageHost, pluginId: string): AiGatewaySettingsStore {
  const read = async (): Promise<AiGatewayStoredSettings> => normalizeAiGatewaySettings(
    await storage.readJson(pluginId, AI_GATEWAY_SETTINGS_STORAGE_KEY),
  );
  return {
    read,
    write: (value) => serializeAiGatewaySettingsWrite(async () => {
      const current = await read();
      const next = normalizeAiGatewaySettings({
        version: 1,
        ...(current.cursorDiagnosticsEnabled === true ? { cursorDiagnosticsEnabled: true } : {}),
        ...(value ?? {}),
      });
      await storage.writeJson(pluginId, AI_GATEWAY_SETTINGS_STORAGE_KEY, next);
      return next;
    }),
    writeCursorDiagnosticsEnabled: (enabled) => serializeAiGatewaySettingsWrite(async () => {
      const current = await read();
      const next = normalizeAiGatewaySettings({
        ...current,
        cursorDiagnosticsEnabled: enabled,
      });
      await storage.writeJson(pluginId, AI_GATEWAY_SETTINGS_STORAGE_KEY, next);
      return next;
    }),
  };
}

function serializeAiGatewaySettingsWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = aiGatewaySettingsWriteTail.then(write);
  aiGatewaySettingsWriteTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
   * Scoped model id → the reasoning rungs exposed as delegation identities.
   * An absent entry means that model's whole ladder. This narrowing never
   * reaches the wire: `/v1/models` keeps advertising the catalog ladder, so a
   * model kept at its top rung alone stays usable from the /model picker.
   */
  readonly effortExposure: GatewayEffortExposure;
  /** Resolved session-default model, when configured and exposed. */
  readonly defaultModel: GatewayModel | undefined;
}

export function resolveAiGatewaySelection(settings: AiGatewayStoredSettings | undefined): AiGatewaySelection {
  const enabled: GatewayModel[] = [];
  const effortExposure: Record<string, readonly GatewayReasoningEffort[]> = {};
  for (const entry of settings?.models ?? []) {
    const model = findGatewayModel(entry.id);
    if (!model || enabled.includes(model)) continue;
    enabled.push(model);
    const exposed = narrowEffortLadder(model, entry.efforts);
    if (exposed) effortExposure[model.id] = exposed;
  }
  // Claude Code's /model picker preserves discovery order under its built-ins.
  // Settings UI is already grouped by GATEWAY_PROVIDERS; expose the same grammar
  // on the wire regardless of Add-click membership order.
  const models = sortGatewayModelsByProvider(enabled);
  const configuredDefault = settings?.defaultModel ? findGatewayModel(settings.defaultModel) : undefined;
  const defaultModel = configuredDefault && models.includes(configuredDefault) ? configuredDefault : undefined;
  return { models, effortExposure, defaultModel };
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

/** Stable provider clusters (codex → cursor → kimi → opencode), then catalog order within each. */
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
  const record = value as { readonly models?: unknown; readonly defaultModel?: unknown };
  const extraKeys = Object.keys(record).filter((key) => key !== "models" && key !== "defaultModel");
  if (extraKeys.length > 0) return { ok: false };

  const models: AiGatewayStoredModel[] = [];
  if (record.models !== undefined) {
    if (!Array.isArray(record.models)) return { ok: false };
    for (const raw of record.models) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
      const entry = raw as { readonly id?: unknown; readonly efforts?: unknown };
      if (Object.keys(entry).some((key) => key !== "id" && key !== "efforts")) return { ok: false };
      if (typeof entry.id !== "string") return { ok: false };
      const model = findGatewayModel(entry.id);
      if (!model) return { ok: false };
      if (models.some((existing) => existing.id === model.id)) return { ok: false };
      const efforts = parseExposedEfforts(model, entry.efforts);
      if (efforts === null) return { ok: false };
      models.push({ id: model.id, ...(efforts ? { efforts } : {}) });
    }
  }

  let defaultModel: string | undefined;
  if (record.defaultModel !== undefined) {
    if (typeof record.defaultModel !== "string") return { ok: false };
    const model = findGatewayModel(record.defaultModel);
    if (!model) return { ok: false };
    if (models.length > 0 && !models.some((entry) => entry.id === model.id)) return { ok: false };
    defaultModel = model.id;
  }

  if (models.length === 0 && defaultModel === undefined) return { ok: true, value: undefined };
  return {
    ok: true,
    value: {
      ...(models.length > 0 ? { models } : {}),
      ...(defaultModel !== undefined ? { defaultModel } : {}),
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
  /** Scoped gateway model id, e.g. `cursor--claude-opus-5`. */
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
    description: model.description ?? null,
    effort: levels.length > 0 ? { levels } : null,
  };
}

// displayName은 Claude Code /model picker용 provider-접두 라벨이다. 설정 UI는 provider 그룹
// 안에서 표시하므로 접두를 벗긴 소재 이름을 쓴다.
function bareModelName(model: GatewayModel): string {
  const prefix = `${GATEWAY_PROVIDER_NAMES[model.provider]}-`;
  return model.displayName.startsWith(prefix) ? model.displayName.slice(prefix.length) : model.displayName;
}
