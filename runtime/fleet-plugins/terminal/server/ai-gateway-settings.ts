import {
  GATEWAY_MODELS,
  GATEWAY_PROVIDER_NAMES,
  GATEWAY_PROVIDERS,
  findGatewayModel,
  hasClaudeOneMillionMarker,
  toClaudeGatewayModelId,
} from "@dotobokuri/core-ai-gateway";
import type { GatewayModel, GatewayProvider } from "@dotobokuri/core-ai-gateway";
import type { FleetPluginStorageHost } from "@fleet-console/sdk/plugin";

// AI Gateway 모델 선별은 콘솔 durable state의 terminal 플러그인 네임스페이스에 저장된다
// (console settings.json → plugins.terminal["ai-gateway"]). 저장 형태는 이 모듈이 보증하고,
// 카탈로그 대조(모델 존재, 기본 모델 소속)도 카탈로그를 아는 이 계층이 소유한다.
// 구 카탈로그가 남긴 stale id는 소비 시점에 걸러낸다.

export const AI_GATEWAY_SETTINGS_STORAGE_KEY = "ai-gateway";

/** `plugins.terminal["ai-gateway"]`에 저장되는 형태. models 부재/공백 = 미구성(노출 없음). */
export interface AiGatewayStoredSettings {
  readonly version: 1;
  readonly models?: readonly { readonly id: string }[];
  readonly defaultModel?: string;
  /** 부재/false는 기본 Off. 저장 정규형은 opt-in인 true만 보존한다. */
  readonly cursorDiagnosticsEnabled?: boolean;
}

export function normalizeAiGatewaySettings(value: unknown): AiGatewayStoredSettings {
  if (!isRecord(value) || value.version !== 1) return { version: 1 };
  const models = Array.isArray(value.models)
    ? value.models
      .filter((entry): entry is { readonly id: string } =>
        isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0)
      .map((entry) => ({ id: entry.id }))
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
  readonly models?: readonly { readonly id: string }[];
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
  /** Resolved session-default model, when configured and exposed. */
  readonly defaultModel: GatewayModel | undefined;
}

export function resolveAiGatewaySelection(settings: AiGatewayStoredSettings | undefined): AiGatewaySelection {
  const enabled: GatewayModel[] = [];
  for (const entry of settings?.models ?? []) {
    const model = findGatewayModel(entry.id);
    if (!model || enabled.includes(model)) continue;
    enabled.push(model);
  }
  const configuredDefault = settings?.defaultModel ? findGatewayModel(settings.defaultModel) : undefined;
  const defaultModel = configuredDefault && enabled.includes(configuredDefault) ? configuredDefault : undefined;
  return { models: enabled, defaultModel };
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

  const models: { id: string }[] = [];
  if (record.models !== undefined) {
    if (!Array.isArray(record.models)) return { ok: false };
    for (const raw of record.models) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
      const entry = raw as { readonly id?: unknown };
      if (Object.keys(entry).some((key) => key !== "id")) return { ok: false };
      if (typeof entry.id !== "string") return { ok: false };
      const model = findGatewayModel(entry.id);
      if (!model) return { ok: false };
      if (models.some((existing) => existing.id === model.id)) return { ok: false };
      models.push({ id: model.id });
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
  /** Supported reasoning ladder — informational; effort itself is chosen inside Claude Code. */
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
  return {
    id: model.id,
    name: bareModelName(model),
    contextWindow: model.contextWindow ?? null,
    oneMillion: hasClaudeOneMillionMarker(toClaudeGatewayModelId(model)),
    maxMode: model.cursorMaxMode === true,
    fast: model.id.endsWith("-fast"),
    description: model.description ?? null,
    effort: model.effort.supported
      ? { levels: model.effort.levels }
      : null,
  };
}

// displayName은 Claude Code /model picker용 provider-접두 라벨이다. 설정 UI는 provider 그룹
// 안에서 표시하므로 접두를 벗긴 소재 이름을 쓴다.
function bareModelName(model: GatewayModel): string {
  const prefix = `${GATEWAY_PROVIDER_NAMES[model.provider]}-`;
  return model.displayName.startsWith(prefix) ? model.displayName.slice(prefix.length) : model.displayName;
}
