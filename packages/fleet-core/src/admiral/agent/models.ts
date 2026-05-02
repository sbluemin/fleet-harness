/**
 * admiral/agent/models — provider/model ID codec 및 조회 유틸리티.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import {
  CLI_BACKENDS,
  getModelsRegistry,
  getProviderModels,
  type CliType,
} from "@sbluemin/unified-agent";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export interface ParsedModelId {
  readonly cli: CliType;
  readonly backendModel: string;
}

export interface ProviderInfo {
  readonly cli: CliType;
  readonly providerId: string;
  readonly displayName: string;
  readonly modelCount: number;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CliCapability {
  readonly supportsSessionClose: boolean;
  readonly supportsSessionLoad: boolean;
  readonly requiresModelAtSpawn: boolean;
  readonly usesNpxBridge: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const LEGACY_PROVIDER_PREFIX = "Fleet ";
const MODEL_ID_POSTFIX = " (Unified)";
const LEGACY_MODEL_ID_POSTFIX = " (ACP)";
const ACP_UI_LEVELS = new Set<ThinkingLevel>(["low", "medium", "high", "xhigh"]);

/** models.json 기반 model ID 조회 테이블 — 모듈 초기화 시 구축 */
const MODEL_LOOKUP: {
  byRegisteredId: Map<string, { cli: CliType; backendModel: string }>;
  byProviderAndRegisteredId: Map<string, { cli: CliType; backendModel: string }>;
  byCliModel: Map<string, string>;
} = buildModelLookup();

export const DEFAULT_BRIDGE_SCOPE = "default";

export const CLI_CAPABILITIES: Record<CliType, CliCapability> = Object.fromEntries(
  Object.entries(CLI_BACKENDS).map(([cliType, backend]) => [
    cliType,
    {
      supportsSessionClose: backend.supportsSessionClose,
      supportsSessionLoad: backend.supportsSessionLoad,
      requiresModelAtSpawn: backend.requiresModelAtSpawn,
      usesNpxBridge: backend.usesNpxBridge,
    },
  ]),
) as Record<CliType, CliCapability>;

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** model ID → { cli, backendModel } 파싱. providerId가 주어지면 양행 식별. */
export function parseModelId(modelId: string, providerId?: string): ParsedModelId | null {
  if (providerId) {
    const lookup = MODEL_LOOKUP.byProviderAndRegisteredId.get(`${providerId}\u0000${modelId}`);
    if (lookup) return { cli: lookup.cli, backendModel: lookup.backendModel };
  }
  const lookup = MODEL_LOOKUP.byRegisteredId.get(modelId);
  if (!lookup) return null;
  return { cli: lookup.cli, backendModel: lookup.backendModel };
}

/** cli + backendModel → 등록된 model ID 빌드 */
export function buildModelId(cli: CliType, backendModel: string): string {
  const registeredId = MODEL_LOOKUP.byCliModel.get(`${cli}\u0000${backendModel}`);
  return registeredId ?? `${cli}/${backendModel}`;
}

/** cli → 정규 provider 표시명 */
export function buildProviderId(cli: CliType): string {
  return getCanonicalProviderName(cli);
}

/** 모든 fleet provider ID 목록 */
export function getProviderIds(): string[] {
  return Object.keys(getModelsRegistry().providers)
    .map((cli) => buildProviderId(cli as CliType));
}

/** provider ID가 fleet provider인지 검증 */
export function isFleetProviderId(providerId: string): boolean {
  return parseProviderId(providerId) !== null;
}

/** provider ID → CliType 역방향 조회 */
export function parseProviderId(providerId: string): CliType | null {
  for (const cliKey of Object.keys(getModelsRegistry().providers)) {
    const cli = cliKey as CliType;
    if (!CLI_BACKENDS[cli]) continue;
    if (buildProviderIdAliases(cli).includes(providerId)) return cli;
  }
  return null;
}

/** 모든 provider 정보 목록 */
export function listProviders(): ProviderInfo[] {
  const registry = getModelsRegistry();
  return Object.entries(registry.providers)
    .filter(([cliKey]) => !!CLI_BACKENDS[cliKey as CliType])
    .map(([cliKey, provider]) => {
      const cli = cliKey as CliType;
      return {
        cli,
        providerId: buildProviderId(cli),
        displayName: provider.name,
        modelCount: provider.models.length,
      };
    });
}

/** model ID의 reasoning effort levels 조회 — fleet provider가 아니면 null */
export function getThinkingLevels(modelId: string, providerId?: string): ThinkingLevel[] | null {
  const parsed = parseModelId(modelId, providerId);
  if (!parsed) return null;

  const provider = getProviderModels(parsed.cli);
  if (!provider?.reasoningEffort.supported) {
    return ["off"];
  }

  const levels = provider.reasoningEffort.levels.filter(
    (level): level is ThinkingLevel => ACP_UI_LEVELS.has(level as ThinkingLevel),
  );

  return ["off", ...levels];
}

/** systemPrompt 해시 — drift 감지용 */
export function hashSystemPrompt(prompt: string | undefined): string {
  if (!prompt) return "";
  let hash = 5381;
  for (let i = 0; i < prompt.length; i++) {
    hash = ((hash << 5) + hash + prompt.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════════

function buildModelLookup() {
  const byRegisteredId = new Map<string, { cli: CliType; backendModel: string }>();
  const byProviderAndRegisteredId = new Map<string, { cli: CliType; backendModel: string }>();
  const byCliModel = new Map<string, string>();
  const registry = getModelsRegistry();

  for (const [cliKey, provider] of Object.entries(registry.providers)) {
    const cli = cliKey as CliType;
    if (!CLI_BACKENDS[cli]) continue;
    const providerIds = buildProviderIdAliases(cli);
    for (const model of provider.models) {
      const modelIds = buildModelIdAliases(model.name);
      for (const modelId of [...modelIds, model.modelId]) {
        byRegisteredId.set(modelId, { cli, backendModel: model.modelId });
        for (const pid of providerIds) {
          byProviderAndRegisteredId.set(`${pid}\u0000${modelId}`, { cli, backendModel: model.modelId });
        }
      }
      byCliModel.set(`${cli}\u0000${model.modelId}`, modelIds[0]!);
    }
  }

  return { byRegisteredId, byProviderAndRegisteredId, byCliModel };
}

function getCanonicalProviderName(cli: CliType): string {
  return getModelsRegistry().providers[cli]?.name ?? cli;
}

function buildProviderIdAliases(cli: CliType): string[] {
  const canonicalName = getCanonicalProviderName(cli);
  return [canonicalName, `${LEGACY_PROVIDER_PREFIX}${canonicalName}`];
}

function buildModelIdAliases(displayName: string): string[] {
  return [`${displayName}${MODEL_ID_POSTFIX}`, `${displayName}${LEGACY_MODEL_ID_POSTFIX}`, displayName];
}
