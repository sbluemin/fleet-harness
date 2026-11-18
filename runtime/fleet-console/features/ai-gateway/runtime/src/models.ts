import modelsData from "../models.json" with { type: "json" };
import { z } from "zod";

import { clampReasoningEffort, type ReasoningEffort } from "./canonical/index.js";
import { recommendedRole, type AiGatewaySpeed } from "./model-family.js";
import type { QuotaScope } from "./quota/types.js";
import { isQuotaScope, modelQuotaScope } from "./quota/windows.js";

export const GATEWAY_PROVIDERS = ["codex", "xai", "muse-code", "opencode", "gemini", "anthropic", "claude"] as const;
export type GatewayProvider = typeof GATEWAY_PROVIDERS[number];

/**
 * The one native provider. `models.json` marks it `native: true`: the installed
 * Claude Code serves it under family aliases, discovery never advertises it, and
 * its versions and effort ladders arrive at runtime through
 * {@link applyClaudeNativeModels}. Every other provider is a registry provider
 * whose entries are served as declared.
 */
const NATIVE_PROVIDER = "claude" satisfies GatewayProvider;
/**
 * The one derived provider. It serves the native families' models over an API key instead of the subscription,
 * so `models.json` declares no entries for it: each is built from the native family it names, and its name,
 * description, scores, effort ladder and version are the Claude row's own — one source, never two copies.
 */
const DERIVED_PROVIDER = "anthropic" satisfies GatewayProvider;
type RegistryProvider = Exclude<GatewayProvider, typeof NATIVE_PROVIDER | typeof DERIVED_PROVIDER>;
const REGISTRY_PROVIDERS = GATEWAY_PROVIDERS.filter(
  (provider): provider is RegistryProvider => provider !== NATIVE_PROVIDER && provider !== DERIVED_PROVIDER,
);
/** Providers whose models.json entries are their own (everything but the derived one). */
const DECLARING_PROVIDERS: readonly (RegistryProvider | typeof NATIVE_PROVIDER)[] = [...REGISTRY_PROVIDERS, NATIVE_PROVIDER];

/**
 * The upstream wire protocol a model is served over. xAI and Muse Code declare
 * `responses` so routing never falls back to Anthropic; OpenCode Go serves each
 * model on exactly one OpenAI wire and declares which. Omission means `anthropic`.
 */
const GATEWAY_MODEL_WIRES = ["anthropic", "responses", "chat-completions"] as const;
export type GatewayModelWire = typeof GATEWAY_MODEL_WIRES[number];

export const GATEWAY_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type GatewayReasoningEffort = typeof GATEWAY_REASONING_EFFORTS[number];

/**
 * Scoped gateway model id → the reasoning rungs exposed as delegation identities.
 * An absent entry means that model's whole ladder.
 */
export type GatewayEffortExposure = Readonly<Record<string, readonly GatewayReasoningEffort[]>>;

const GatewayModelEffortSchema = z.discriminatedUnion("supported", [
  z.object({
    supported: z.literal(true),
    levels: z.array(z.enum(GATEWAY_REASONING_EFFORTS)).min(1),
  }).strict(),
  z.object({
    supported: z.literal(false),
  }).strict(),
]);

export type GatewayQuotaScope = QuotaScope;

/** Intelligence index score per reasoning effort. An absent effort has no published score. */
const GatewayModelIntelligenceSchema = z.object({
  source: z.url(),
  /** When this entry's scores were read, if not on the registry-wide `intelligenceIndex.observedAt`. */
  observedAt: z.iso.date().optional(),
  scores: z.partialRecord(z.enum(GATEWAY_REASONING_EFFORTS), z.number().nonnegative()),
}).strict();

const GatewayModelEntrySchema = z.object({
  modelId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  providerModelId: z.string().min(1).optional(),
  fastSupported: z.boolean().optional(),
  /** Whether this model also offers the Ultrafast service tier. Codex only. */
  ultrafastSupported: z.boolean().optional(),
  fastUpstreamId: z.string().min(1).optional(),
  fast: z.boolean().optional(),
  quotaScope: z.string().refine(isQuotaScope, { message: "invalid quotaScope" }).optional(),
  wire: z.enum(GATEWAY_MODEL_WIRES).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  contextWindow: z.number().int().positive().optional(),
  effort: GatewayModelEffortSchema.optional(),
  intelligence: GatewayModelIntelligenceSchema.optional(),
}).strict();

const GatewayProviderSchema = z.object({
  name: z.string().min(1),
  /** Served by an installed agent CLI under its own aliases; never advertised by discovery. */
  native: z.literal(true).optional(),
  defaultModel: z.string().min(1),
  source: z.string().min(1),
  models: z.array(GatewayModelEntrySchema).min(1),
}).strict();

/** A provider that serves a subset of the native families under its own credential; it declares no models itself. */
const GatewayDerivedProviderSchema = z.object({
  name: z.string().min(1),
  derivedFrom: z.literal("claude"),
  /** Native family aliases it serves. Only a family the pricing table knows belongs here. */
  families: z.array(z.string().min(1)).min(1),
  defaultModel: z.string().min(1),
  source: z.string().min(1),
}).strict();

/** Minimum intelligence score at which a model × effort is recommended for each role. */
const GatewayRoleThresholdsSchema = z.object({
  lead: z.number().nonnegative(),
  overseer: z.number().nonnegative(),
}).strict();

const GatewayModelsRegistrySchema = z.object({
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  intelligenceIndex: z.object({
    name: z.string().min(1),
    observedAt: z.iso.date(),
    note: z.string().min(1),
  }).strict(),
  roleThresholds: GatewayRoleThresholdsSchema,
  providers: z.object({
    codex: GatewayProviderSchema,
    xai: GatewayProviderSchema,
    "muse-code": GatewayProviderSchema,
    opencode: GatewayProviderSchema,
    gemini: GatewayProviderSchema,
    anthropic: GatewayDerivedProviderSchema,
    claude: GatewayProviderSchema,
  }).strict(),
}).strict();

export type GatewayModelsRegistry = z.infer<typeof GatewayModelsRegistrySchema>;
type GatewayModelEntry = z.infer<typeof GatewayModelEntrySchema>;

export type GatewayModelEffort =
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly levels: readonly GatewayReasoningEffort[];
    };

const UNSUPPORTED_GATEWAY_MODEL_EFFORT = Object.freeze({ supported: false as const });

export interface GatewayModel {
  /** Collision-free model id exposed by the gateway. */
  readonly id: string;
  /** Provider-prefixed label shown by Claude Code's model picker. */
  readonly displayName: string;
  readonly provider: GatewayProvider;
  /** Model id sent to the selected upstream provider. */
  readonly upstreamId?: string;
  readonly serviceTier?: "priority" | "ultrafast";
  /** Whether this model offers an optional priority service tier. */
  readonly fastSupported?: boolean;
  /** Whether this model also offers the Ultrafast service tier (catalog flag; Codex only). */
  readonly ultrafastSupported?: boolean;
  readonly fastUpstreamId?: string;
  /** Selected service tier; never a separate model identity. */
  readonly fast?: boolean;
  /**
   * Optional declared sub-pool: the allowance pool this catalog entry spends
   * (e.g. `pool:gemini`). Its own `model:` limit is derived from
   * the entry either way — see {@link resolveModelQuotaScopes}.
   */
  readonly quotaScope?: GatewayQuotaScope;
  /** 공급자가 선언한 업스트림 와이어 프로토콜. 생략하면 `anthropic`이다. */
  readonly wire?: GatewayModelWire;
  readonly description?: string;
  /** Authoritative input context window reported by the provider/reference catalog. */
  readonly contextWindow?: number;
  /** Model-specific reasoning ladder. Missing registry metadata is treated as unsupported. */
  readonly effort: GatewayModelEffort;
  /** Accepted request ids that are intentionally omitted from discovery. */
  readonly aliases?: readonly string[];
  /**
   * Claude only: the Claude Code alias this entry launches as. The CLI resolves
   * it to its own latest version, so the launch path never pins a version.
   */
  readonly claudeAlias?: string;
}

/**
 * Claude Code's model aliases come from the registry's native provider. Each
 * alias stands for its family's latest version, which only the installed CLI
 * knows; the version, wire id, and effort ladder arrive through
 * {@link applyClaudeNativeModels}, and the registry's effort levels are the
 * ladder assumed until then.
 *
 * Every current family runs natively on a 1M window, so each family is exactly
 * one catalog entry: `claude--<alias>-1m`, launched as `<alias>[1m]`. The bare
 * alias and the retired 200k scoped id (`claude--<alias>`) are accepted request
 * spellings of that same entry, never entries of their own.
 */
const CLAUDE_ONE_MILLION_SUFFIX = /\[1m\]$/i;
const CLAUDE_ONE_MILLION_ID_SUFFIX = "-1m";
const CLAUDE_ONE_MILLION_MARKER = "[1m]";

/** The single catalog id of a Claude family (`claude--sonnet-1m`). */
function claudeFamilyModelId(alias: string): string {
  return scopedModelId("claude", `${alias}${CLAUDE_ONE_MILLION_ID_SUFFIX}`);
}

/** Request spellings that reach a family's single entry: the 1M alias, the bare alias, the retired 200k scoped id. */
function claudeFamilyAliases(alias: string): readonly string[] {
  return [`${alias}${CLAUDE_ONE_MILLION_MARKER}`, alias, scopedModelId("claude", alias)];
}

/**
 * The single catalog id of an Anthropic API-key model (`anthropic--sonnet-1m`). It follows the Claude family's
 * id (`claude--sonnet-1m`) with another provider scope, so it names the family, not a version: a version change
 * the Claude Code sync reports moves the wire id and the label, never this id, and every stored selection,
 * client subtitle and score keyed by family keeps matching.
 */
function anthropicFamilyModelId(alias: string): string {
  return scopedModelId(DERIVED_PROVIDER, `${alias}${CLAUDE_ONE_MILLION_ID_SUFFIX}`);
}

/** Request spellings of that entry: the bare scoped id. The bare alias belongs to the subscription entry. */
function anthropicFamilyAliases(alias: string): readonly string[] {
  return [scopedModelId(DERIVED_PROVIDER, alias)];
}

export function parseGatewayModelsRegistry(value: unknown): GatewayModelsRegistry {
  const parsed = GatewayModelsRegistrySchema.parse(value);
  validateRegistry(parsed);
  return parsed;
}

const registry = parseGatewayModelsRegistry(modelsData);
const nativeProvider = registry.providers[NATIVE_PROVIDER];
const nativeFamilies = nativeProvider.models;
const derivedProvider = registry.providers[DERIVED_PROVIDER];
/** The native families the derived provider serves, in the native order. */
const derivedFamilies = nativeFamilies.filter((family) => derivedProvider.families.includes(family.modelId));

export const GATEWAY_MODELS_UPDATED_AT = registry.updatedAt;

/** Human-readable provider names as declared by the model registry. */
export const GATEWAY_PROVIDER_NAMES: Readonly<Record<GatewayProvider, string>> = Object.freeze({
  ...Object.fromEntries(
    REGISTRY_PROVIDERS.map((provider) => [provider, registry.providers[provider].name]),
  ) as Record<RegistryProvider, string>,
  claude: nativeProvider.name,
  anthropic: derivedProvider.name,
});

/**
 * Whether discovery must leave this provider's models out: a native provider is
 * served by its installed CLI under its own aliases, not advertised by the gateway.
 */
export function isNativeGatewayProvider(provider: GatewayProvider): boolean {
  return provider === NATIVE_PROVIDER;
}

/** A role the registry's thresholds can recommend a model × effort for. */
export type GatewayRole = keyof GatewayModelsRegistry["roleThresholds"];

/** Minimum intelligence score per role, as declared by the registry. */
export const GATEWAY_ROLE_THRESHOLDS: Readonly<Record<GatewayRole, number>> = Object.freeze({
  ...registry.roleThresholds,
});

/** Where the intelligence scores come from and when they were read. */
export const GATEWAY_INTELLIGENCE_INDEX: Readonly<GatewayModelsRegistry["intelligenceIndex"]> = Object.freeze({
  ...registry.intelligenceIndex,
});

export interface GatewayModelIntelligence {
  readonly source: string;
  /** Score per reasoning effort. An absent effort has no published score. */
  readonly scores: Readonly<Partial<Record<GatewayReasoningEffort, number>>>;
}

/**
 * The dates the catalog's scores were read, as one display value: a single date when every entry was read on
 * the same day, otherwise `<earliest>–<latest>`. An entry without its own date was read on the registry-wide one.
 */
export const GATEWAY_INTELLIGENCE_OBSERVED_SPAN: string = (() => {
  // The derived provider's scores are the native families' own, so they add no date of their own.
  const dates = DECLARING_PROVIDERS.flatMap((provider) => registry.providers[provider].models.flatMap((entry) =>
    entry.intelligence ? [entry.intelligence.observedAt ?? registry.intelligenceIndex.observedAt] : []));
  if (dates.length === 0) return registry.intelligenceIndex.observedAt;
  const sorted = [...dates].sort();
  const earliest = sorted[0]!;
  const latest = sorted.at(-1)!;
  return earliest === latest ? earliest : `${earliest}–${latest}`;
})();

/** Catalog id → intelligence data. Claude families key by their single catalog id. */
const GATEWAY_MODEL_INTELLIGENCE: ReadonlyMap<string, GatewayModelIntelligence> = new Map(
  DECLARING_PROVIDERS.flatMap((provider) => registry.providers[provider].models.flatMap((entry) => {
    if (!entry.intelligence) return [];
    const intelligence = Object.freeze({
      source: entry.intelligence.source,
      scores: Object.freeze({ ...entry.intelligence.scores }),
    });
    const id = provider === NATIVE_PROVIDER ? claudeFamilyModelId(entry.modelId) : scopedModelId(provider, entry.modelId);
    // The API-key entry of a native family reads the very same record, so a score can never differ between the two.
    const derived = provider === NATIVE_PROVIDER && derivedFamilies.some((family) => family.modelId === entry.modelId)
      ? [[anthropicFamilyModelId(entry.modelId), intelligence] as const]
      : [];
    return [[id, intelligence] as const, ...derived];
  })),
);

/** The intelligence data of a catalog model, or undefined when no score is published for it. */
export function gatewayModelIntelligence(modelId: string): GatewayModelIntelligence | undefined {
  return GATEWAY_MODEL_INTELLIGENCE.get(modelId);
}

/**
 * The highest role whose threshold the score reaches. Computed, never stored:
 * the registry holds only scores and thresholds.
 */
export function recommendedGatewayRole(score: number | undefined): GatewayRole | undefined {
  return recommendedRole(score, GATEWAY_ROLE_THRESHOLDS);
}

/** The recommended role of a catalog model at one reasoning effort. */
export function recommendedGatewayModelRole(
  modelId: string,
  effort: GatewayReasoningEffort,
): GatewayRole | undefined {
  return recommendedGatewayRole(gatewayModelIntelligence(modelId)?.scores[effort]);
}

/** One row of the installed Claude Code's model picker (`supportedModels()`). */
export interface ClaudeNativeModelRow {
  readonly value: string;
  readonly resolvedModel: string | null;
  readonly displayName: string;
  readonly effortLevels: readonly string[];
}

/** What one Claude alias currently resolves to. */
export interface ClaudeNativeResolution {
  readonly alias: string;
  readonly model: string;
  readonly displayName: string;
  readonly effortLevels: readonly GatewayReasoningEffort[];
}

const STATIC_GATEWAY_MODELS: readonly GatewayModel[] = Object.freeze(
  REGISTRY_PROVIDERS.flatMap((provider) => {
    const definition = registry.providers[provider];
    return definition.models.map((entry) => Object.freeze(toGatewayModel(provider, definition.name, entry)));
  }),
);

let claudeNativeResolutions: ReadonlyMap<string, ClaudeNativeResolution> = new Map();

/**
 * The whole catalog. Claude entries are rebuilt whenever the installed CLI
 * reports a different lineup, so read this binding at call time rather than
 * capturing it.
 */
export let GATEWAY_MODELS: readonly GatewayModel[] = buildGatewayModels();

function buildGatewayModels(): readonly GatewayModel[] {
  const familyEntry = (family: GatewayModelEntry, provider: GatewayProvider) => {
    const alias = family.modelId;
    const resolution = claudeNativeResolutions.get(alias);
    const levels = resolution
      ? resolution.effortLevels
      : family.effort?.supported ? family.effort.levels : [];
    const effort: GatewayModelEffort = levels.length > 0
      ? Object.freeze({ supported: true as const, levels: Object.freeze([...levels]) })
      : UNSUPPORTED_GATEWAY_MODEL_EFFORT;
    return {
      alias,
      displayName: `${GATEWAY_PROVIDER_NAMES[provider]}-${resolution?.displayName ?? family.name}`,
      ...(resolution ? { upstreamId: resolution.model } : {}),
      ...(family.description ? { description: family.description } : {}),
      ...(family.contextWindow ? { contextWindow: family.contextWindow } : {}),
      effort,
    };
  };
  const claude = nativeFamilies.map((family) => {
    const { alias, ...entry } = familyEntry(family, NATIVE_PROVIDER);
    return Object.freeze<GatewayModel>({
      id: claudeFamilyModelId(alias),
      provider: NATIVE_PROVIDER,
      ...entry,
      aliases: Object.freeze([...claudeFamilyAliases(alias)]),
      claudeAlias: alias,
    });
  });
  // The API-key twin of each served family: same label, description, window and ladder as the Claude row, the
  // wire id the sync reports for it. It carries no `claudeAlias` — that would bind it to the subscription's
  // quota scope and auto-compact names, and it is never launched as a bare alias.
  const anthropic = derivedFamilies.map((family) => {
    const { alias, ...entry } = familyEntry(family, DERIVED_PROVIDER);
    return Object.freeze<GatewayModel>({
      id: anthropicFamilyModelId(alias),
      provider: DERIVED_PROVIDER,
      ...entry,
      aliases: Object.freeze([...anthropicFamilyAliases(alias)]),
    });
  });
  return Object.freeze([...STATIC_GATEWAY_MODELS, ...anthropic, ...claude]);
}

/**
 * Pick each alias's latest version from the installed CLI's model picker.
 *
 * An alias row is authoritative: it is exactly what the CLI launches for that
 * alias. The picker may list a family only by its 1M coordinate (Opus today) or
 * only by explicit ids (Fable today); those take the highest version reported.
 * The `default` row names the account's default family, not a family of its own.
 * The wire id and label never carry the 1M marker — the family's single 1M
 * entry adds it back at launch.
 */
export function resolveClaudeNativeModels(rows: readonly ClaudeNativeModelRow[]): readonly ClaudeNativeResolution[] {
  return nativeFamilies.flatMap((family) => {
    const alias = family.modelId;
    const candidates = rows.flatMap((row) => {
      if (row.value === "default" || !row.resolvedModel) return [];
      const model = row.resolvedModel.replace(CLAUDE_ONE_MILLION_SUFFIX, "");
      const version = claudeFamilyVersion(model, alias);
      return version ? [{ row, model, version }] : [];
    });
    const aliasCandidate = candidates.find(({ row }) => row.value === alias)
      ?? candidates.find(({ row }) => row.value === `${alias}${CLAUDE_ONE_MILLION_MARKER}`);
    const picked = aliasCandidate
      ?? [...candidates].sort((left, right) => compareVersions(right.version, left.version))[0];
    if (!picked) return [];
    return [{
      alias,
      model: picked.model,
      displayName: `${family.name} ${picked.version.join(".")}`,
      effortLevels: picked.row.effortLevels.filter(
        (level): level is GatewayReasoningEffort => ANTHROPIC_EFFORT_RUNGS.has(level as GatewayReasoningEffort),
      ),
    }];
  });
}

/**
 * Install the installed CLI's lineup. Returns whether the catalog changed.
 * An alias the CLI no longer reports keeps its entry but loses its wire id.
 */
export function applyClaudeNativeModels(rows: readonly ClaudeNativeModelRow[]): boolean {
  const next = new Map(resolveClaudeNativeModels(rows).map((resolution) => [resolution.alias, resolution]));
  if (JSON.stringify([...next]) === JSON.stringify([...claudeNativeResolutions])) return false;
  claudeNativeResolutions = next;
  GATEWAY_MODELS = buildGatewayModels();
  return true;
}

/** `claude-opus-5-5` → [5, 5]; `claude-haiku-4-5-20251001` → [4, 5]. Other families → undefined. */
function claudeFamilyVersion(model: string, family: string): readonly number[] | undefined {
  const prefix = `claude-${family}-`;
  if (!model.startsWith(prefix)) return undefined;
  const parts = model.slice(prefix.length).split("-");
  const version: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) break;
    version.push(Number(part));
  }
  return version.length > 0 ? version : undefined;
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export const CODEX_SUBSCRIPTION_MODELS = providerModels("codex");

/**
 * A catalog entry by its canonical id or one of its declared aliases.
 *
 * Bare catalog vocabulary only. A downstream harness that publishes its own id
 * grammar resolves that spelling in its own folder before the catalog is asked —
 * see `downstream/harness/claude-code/discovery.ts`.
 */
export function findGatewayModel(
  id: string,
  catalog: readonly GatewayModel[] = GATEWAY_MODELS,
): GatewayModel | undefined {
  return catalog.find((model) => model.id === id || model.aliases?.includes(id));
}

/**
 * Apply the selected speed without creating a second catalog identity.
 *
 * `fast` and `ultrafast` are service tiers, not model ids: Fast rides Codex's
 * `priority` tier, Ultrafast its `ultrafast` tier (`standard` omits the field).
 * A catalog `fast: true` entry is permanently fast and ignores the argument.
 * A tier the model does not declare is dropped rather than forwarded.
 */
export function withGatewayModelSpeed(model: GatewayModel, selected: AiGatewaySpeed | undefined): GatewayModel {
  const forcedFast = model.fast === true;
  const fast = forcedFast || (selected === "fast" && model.fastSupported === true);
  const ultrafast = fast ? false : selected === "ultrafast" && model.ultrafastSupported === true;
  return {
    ...model,
    fast,
    ...(fast && model.fastUpstreamId ? { upstreamId: model.fastUpstreamId } : {}),
    ...(ultrafast ? { serviceTier: "ultrafast" as const } : fast && model.provider === "codex" ? { serviceTier: "priority" as const } : {}),
  };
}

export function upstreamModelId(model: GatewayModel): string {
  return model.upstreamId ?? model.id;
}

/** The actual upstream model identity used for provider measurements, not routing ids. */
export function gatewayModelIdentity(model: GatewayModel): string {
  return `${model.provider}::${upstreamModelId(model)}`;
}

/**
 * Facts a caller must respect when routing work to a model. Everything here is
 * derived from the catalog, so a newly added model carries them without further
 * declaration.
 */
export interface GatewayModelConstraints {
  readonly provider: GatewayProvider;
  readonly contextWindow?: number;
  /**
   * Reasoning levels a caller may actually request. This is the model's ladder
   * narrowed to the rungs discovery advertises, so a level absent here is
   * silently clamped upstream rather than honoured.
   */
  readonly effortLadder: readonly GatewayReasoningEffort[];
  readonly effortSupported: boolean;
  /**
   * Every sub-budget this model spends, most specific last: the pool its
   * `models.json` entry declares and its own `model:` limit. A live window binds
   * to the model when it carries no scope (provider-wide) or one of these. Empty
   * means the model reads only provider-wide windows.
   */
  readonly quotaScopes: readonly GatewayQuotaScope[];
}

/**
 * The scopes a model spends. A declared `quotaScope` is the pool its catalog
 * entry belongs to (`pool:gemini`); the model's own `model:` limit comes from
 * its id (or Claude family alias), so a catalog entry that declares a pool keeps
 * its model-scoped window too.
 */
export function resolveModelQuotaScopes(model: Pick<GatewayModel, "id" | "provider" | "claudeAlias" | "quotaScope">): readonly GatewayQuotaScope[] {
  const scopes: GatewayQuotaScope[] = [];
  if (model.quotaScope !== undefined) scopes.push(model.quotaScope);
  const owned = model.provider === "claude" && model.claudeAlias
    ? modelQuotaScope(model.claudeAlias)
    : modelQuotaScope(model.id.startsWith(`${model.provider}--`)
      ? model.id.slice(model.provider.length + 2)
      : model.id);
  if (owned !== undefined && !scopes.includes(owned)) scopes.push(owned);
  return scopes;
}

export function buildGatewayModelConstraints(model: GatewayModel): GatewayModelConstraints {
  const ladder = model.effort.supported
    ? model.effort.levels.filter((level) => ANTHROPIC_EFFORT_RUNGS.has(level))
    : [];
  return {
    provider: model.provider,
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    effortLadder: Object.freeze([...ladder]),
    effortSupported: ladder.length > 0,
    quotaScopes: Object.freeze(resolveModelQuotaScopes(model)),
  };
}

/**
 * Baseline allowance-pool identity exposed on the catalog; the routing loadout
 * narrows `quotaPool` to `${provider}:${scope}` when live quota reports a
 * matching scoped window. A model that declares no pool spends the provider's
 * shared allowance, so its baseline identity stays `${provider}:shared`.
 */
export function buildGatewayModelQuota(model: GatewayModel) {
  const { quotaScopes } = buildGatewayModelConstraints(model);
  return {
    quotaPool: model.quotaScope ? `${model.provider}:${model.quotaScope}` : `${model.provider}:shared`,
    ...(quotaScopes.length === 0 ? {} : { quotaScopes }),
  };
}

/**
 * 카탈로그가 관리하는 한 줄 모델 요약(성능 보증이 아닌 관리 메타데이터).
 */
export function gatewayModelSummary(model: GatewayModel): string {
  if (model.description && model.description.trim().length > 0) return model.description.trim();
  return `${model.displayName}.`;
}

export function gatewayProviderDefault(provider: GatewayProvider): GatewayModel {
  const defaultId = provider === NATIVE_PROVIDER
    ? claudeFamilyModelId(nativeProvider.defaultModel)
    : provider === DERIVED_PROVIDER
      ? anthropicFamilyModelId(derivedProvider.defaultModel)
      : scopedModelId(provider, registry.providers[provider].defaultModel);
  const resolved = GATEWAY_MODELS.find((model) => model.provider === provider && model.id === defaultId);
  if (!resolved) {
    throw new Error(`Gateway model registry has no default for provider "${provider}"`);
  }
  return resolved;
}

export interface AnthropicCapabilitySupport {
  readonly supported: boolean;
}

export interface AnthropicEffortCapability {
  readonly supported: boolean;
  readonly low: AnthropicCapabilitySupport;
  readonly medium: AnthropicCapabilitySupport;
  readonly high: AnthropicCapabilitySupport;
  readonly max: AnthropicCapabilitySupport;
  readonly xhigh: AnthropicCapabilitySupport | null;
}

export interface AnthropicThinkingCapability {
  readonly supported: boolean;
  readonly types: {
    readonly adaptive: AnthropicCapabilitySupport;
    readonly enabled: AnthropicCapabilitySupport;
  };
}

export interface AnthropicModelCapabilities {
  readonly batch: AnthropicCapabilitySupport;
  readonly citations: AnthropicCapabilitySupport;
  readonly code_execution: AnthropicCapabilitySupport;
  readonly context_management: {
    readonly supported: false;
    readonly clear_thinking_20251015: null;
    readonly clear_tool_uses_20250919: null;
    readonly compact_20260112: null;
  };
  readonly effort: AnthropicEffortCapability;
  readonly image_input: AnthropicCapabilitySupport;
  readonly pdf_input: AnthropicCapabilitySupport;
  readonly structured_outputs: AnthropicCapabilitySupport;
  readonly thinking: AnthropicThinkingCapability;
}

/** How a caller's model string is looked up in the catalog. */
export type GatewayModelLookup = (
  id: string,
  catalog: readonly GatewayModel[],
) => GatewayModel | undefined;

/**
 * Resolve a canonical gateway id or current provider alias to its wire model id.
 *
 * `find` is how the caller's spelling reaches the catalog. It defaults to bare
 * catalog vocabulary; a downstream harness that publishes its own id grammar passes
 * its own resolver instead, which is why this module holds no harness grammar.
 */
export function resolveGatewayModel(
  requested: string | undefined,
  options: {
    readonly override?: string;
    readonly catalog?: readonly GatewayModel[];
    readonly fallback: string;
    readonly find?: GatewayModelLookup;
  },
): string {
  if (options.override) return options.override;
  if (!requested) return options.fallback;
  const find = options.find ?? findGatewayModel;
  const model = find(requested, options.catalog ?? GATEWAY_MODELS);
  return model ? upstreamModelId(model) : options.fallback;
}

function scopedModelId(provider: GatewayProvider, modelId: string): string {
  return `${provider}--${modelId}`;
}

function toGatewayModel(
  provider: RegistryProvider,
  providerName: string,
  entry: GatewayModelEntry,
): GatewayModel {
  return {
    id: scopedModelId(provider, entry.modelId),
    displayName: `${providerName}-${entry.name}`,
    provider,
    upstreamId: entry.providerModelId ?? entry.modelId,
    ...(entry.fastSupported ? { fastSupported: true } : {}),
    ...(entry.ultrafastSupported ? { ultrafastSupported: true } : {}),
    ...(entry.fastUpstreamId ? { fastUpstreamId: entry.fastUpstreamId } : {}),
    ...(entry.fast ? { fast: true } : {}),
    ...(entry.quotaScope ? { quotaScope: entry.quotaScope as GatewayQuotaScope } : {}),
    ...(entry.wire ? { wire: entry.wire } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
    effort: freezeGatewayModelEffort(entry.effort),
    ...(entry.aliases ? { aliases: Object.freeze([...entry.aliases]) } : {}),
  };
}

function providerModels(provider: GatewayProvider): readonly GatewayModel[] {
  return Object.freeze(GATEWAY_MODELS.filter((model) => model.provider === provider));
}

function validateRegistry(value: GatewayModelsRegistry): void {
  const lookupIds = new Set<string>();
  const native = value.providers[NATIVE_PROVIDER];
  if (native.native !== true) {
    throw new Error(`Gateway provider must be marked native: ${NATIVE_PROVIDER}`);
  }
  const nativeIds = new Set<string>();
  for (const family of native.models) {
    const alias = family.modelId;
    const owner = `${NATIVE_PROVIDER}/${alias}${CLAUDE_ONE_MILLION_ID_SUFFIX}`;
    if (!/^[a-z]+$/.test(alias)) {
      throw new Error(`Native gateway model id must be a bare family alias: ${owner}`);
    }
    if (nativeIds.has(alias)) throw new Error(`Duplicate gateway model id: ${NATIVE_PROVIDER}/${alias}`);
    nativeIds.add(alias);
    // A native entry is judgment data for an alias the CLI resolves; serving fields would never be read.
    if (
      family.providerModelId || family.fastSupported || family.ultrafastSupported || family.fastUpstreamId || family.fast
      || family.quotaScope || family.wire || family.aliases
    ) {
      throw new Error(`Native gateway model declares a serving field: ${owner}`);
    }
    registerLookupId(lookupIds, claudeFamilyModelId(alias), owner);
    for (const spelling of claudeFamilyAliases(alias)) registerLookupId(lookupIds, spelling, owner);
  }
  if (!nativeIds.has(native.defaultModel)) {
    throw new Error(`Gateway default model is missing: ${NATIVE_PROVIDER}/${native.defaultModel}`);
  }
  const derived = value.providers[DERIVED_PROVIDER];
  const derivedOwner = `${DERIVED_PROVIDER}/${derived.defaultModel}`;
  for (const family of derived.families) {
    if (!nativeIds.has(family)) {
      throw new Error(`Derived gateway provider names a family that is not native: ${DERIVED_PROVIDER}/${family}`);
    }
    if (derived.families.indexOf(family) !== derived.families.lastIndexOf(family)) {
      throw new Error(`Duplicate gateway model id: ${DERIVED_PROVIDER}/${family}`);
    }
    registerLookupId(lookupIds, anthropicFamilyModelId(family), `${DERIVED_PROVIDER}/${family}`);
    for (const spelling of anthropicFamilyAliases(family)) registerLookupId(lookupIds, spelling, `${DERIVED_PROVIDER}/${family}`);
  }
  if (!derived.families.includes(derived.defaultModel)) {
    throw new Error(`Gateway default model is missing: ${derivedOwner}`);
  }
  for (const provider of REGISTRY_PROVIDERS) {
    const definition = value.providers[provider];
    if (definition.native) {
      throw new Error(`Only ${NATIVE_PROVIDER} can be a native gateway provider: ${provider}`);
    }
    const modelIds = new Set<string>();
    for (const model of definition.models) {
      if (model.modelId.includes("--")) {
        throw new Error(`Gateway model id contains reserved separator: ${provider}/${model.modelId}`);
      }
      if (modelIds.has(model.modelId)) {
        throw new Error(`Duplicate gateway model id: ${provider}/${model.modelId}`);
      }
      modelIds.add(model.modelId);
      if (model.fastSupported && provider !== "codex" && provider !== "xai") {
        throw new Error(`Gateway fast selection is only supported by Codex and xAI: ${provider}/${model.modelId}`);
      }
      if (model.ultrafastSupported) {
        if (provider !== "codex") {
          throw new Error(`Gateway ultrafast selection is only supported by Codex: ${provider}/${model.modelId}`);
        }
        if (!model.fastSupported) {
          throw new Error(`Gateway ultrafast selection requires the fast tier: ${provider}/${model.modelId}`);
        }
      }
      // xAI Grok CLI와 Muse Code 구독은 Responses 고정이지만 라우팅이 Anthropic으로 떨어지지 않도록 명시한다.
      // OpenCode Go는 모델마다 Responses·Chat Completions 중 하나로만 서빙한다.
      if (model.wire && provider !== "xai" && provider !== "muse-code" && provider !== "opencode") {
        throw new Error(`Gateway model wire is not supported by provider: ${provider}/${model.modelId}`);
      }
      if (model.wire === "chat-completions" && provider !== "opencode") {
        throw new Error(`Gateway model wire is not supported by provider: ${provider}/${model.modelId}`);
      }
      if (model.intelligence) {
        const levels = model.effort?.supported ? model.effort.levels : [];
        for (const effort of Object.keys(model.intelligence.scores) as GatewayReasoningEffort[]) {
          if (!levels.includes(effort)) {
            throw new Error(`Gateway intelligence score is not an advertised level: ${provider}/${model.modelId}/${effort}`);
          }
        }
      }
      if (model.effort?.supported) {
        if (new Set(model.effort.levels).size !== model.effort.levels.length) {
          throw new Error(`Gateway effort levels contain duplicates: ${provider}/${model.modelId}`);
        }
      }
      const scopedId = scopedModelId(provider, model.modelId);
      registerLookupId(lookupIds, scopedId, `${provider}/${model.modelId}`);
      for (const alias of model.aliases ?? []) {
        registerLookupId(lookupIds, alias, `${provider}/${model.modelId}`);
      }
    }
    if (!modelIds.has(definition.defaultModel)) {
      throw new Error(`Gateway default model is missing: ${provider}/${definition.defaultModel}`);
    }
  }
}

function registerLookupId(lookupIds: Set<string>, id: string, owner: string): void {
  if (lookupIds.has(id)) {
    throw new Error(`Duplicate gateway model lookup id "${id}" at ${owner}`);
  }
  lookupIds.add(id);
}

// 이 집합은 Anthropic wire가 살려내는 사다리다 — model constraints의 effortLadder를 만들고,
// 그 constraints가 설정 DTO의 노출 사다리(exposableEffortLadder)와 fleet-admiral의 위임 신원
// 로스터를 먹인다; discovery(`/v1/models`)의 effort capability도 같은 집합으로 좁힌다.
// 카탈로그 사다리는 max에서 끝난다.
const ANTHROPIC_EFFORT_RUNGS = new Set<GatewayReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function freezeGatewayModelEffort(
  effort: GatewayModelEntry["effort"],
): GatewayModelEffort {
  if (!effort?.supported) return UNSUPPORTED_GATEWAY_MODEL_EFFORT;
  return Object.freeze({
    supported: true as const,
    levels: Object.freeze([...effort.levels]),
  });
}

function capability(supported: boolean): AnthropicCapabilitySupport {
  return { supported };
}

function anthropicEffortCapability(effort: GatewayModelEffort): AnthropicEffortCapability {
  const rungs = new Set(
    effort.supported
      ? effort.levels.filter((level) => ANTHROPIC_EFFORT_RUNGS.has(level))
      : [],
  );
  const supported = rungs.size > 0;
  return {
    supported,
    low: capability(rungs.has("low")),
    medium: capability(rungs.has("medium")),
    high: capability(rungs.has("high")),
    max: capability(rungs.has("max")),
    xhigh: supported ? capability(rungs.has("xhigh")) : null,
  };
}

export function anthropicModelCapabilities(effort: GatewayModelEffort): AnthropicModelCapabilities {
  const reasoningSupported = effort.supported && effort.levels.length > 0;
  return {
    batch: capability(false),
    citations: capability(false),
    code_execution: capability(false),
    context_management: {
      supported: false,
      clear_thinking_20251015: null,
      clear_tool_uses_20250919: null,
      compact_20260112: null,
    },
    effort: anthropicEffortCapability(effort),
    // Claude Code still attaches images even when this is false; advertise support
    // once the gateway forwards Anthropic image blocks to providers.
    image_input: capability(true),
    pdf_input: capability(false),
    structured_outputs: capability(false),
    thinking: {
      supported: reasoningSupported,
      types: {
        adaptive: capability(reasoningSupported),
        enabled: capability(reasoningSupported),
      },
    },
  };
}
