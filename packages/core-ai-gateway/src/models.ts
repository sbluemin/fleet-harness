import modelsData from "../models.json" with { type: "json" };
import { z } from "zod";

import { clampReasoningEffort, type ReasoningEffort } from "./canonical/index.js";
import {
  canProjectClaudeContextWindow,
  hasClaudeOneMillionMarker,
  isClaudeOneMillionContextWindow,
  stripClaudeOneMillionMarker,
} from "./anthropic/claude-context.js";

/**
 * Subscription credential coordinates for gateway providers.
 *
 * These are provider access facts, not Fleet policy: the id a credential is
 * persisted under and the base URL its subscription API answers on. Callers that
 * read a provider's own usage or validate its key need the same coordinates as
 * the transport path, so they live beside the model catalog rather than in a
 * Fleet-domain package.
 */

// Keep the persisted provider id stable so existing Kimi keys remain usable
// after the retired direct Kimi backend is removed.
export const KIMI_AUTH_PROVIDER_ID = "Claude Code with Moonshot Kimi";
export const KIMI_CODE_API_BASE_URL = "https://api.kimi.com/coding";
export const KIMI_CODE_MODEL = "k3";

export const GATEWAY_PROVIDERS = ["codex", "cursor", "kimi", "opencode"] as const;
export type GatewayProvider = typeof GATEWAY_PROVIDERS[number];

/**
 * The upstream wire protocol a model is served over. Only the OpenCode Go
 * provider declares this today: its subscription exposes Anthropic, OpenAI
 * Responses, and Chat Completions endpoints side by side, and each model is
 * native to exactly one of them. Omission means `anthropic`.
 */
export const GATEWAY_MODEL_WIRES = ["anthropic", "responses", "chat-completions"] as const;
export type GatewayModelWire = typeof GATEWAY_MODEL_WIRES[number];

/**
 * Whether a model's requests stay in Anthropic Messages form end to end (no
 * canonical translation). The `[1m]` discovery marker for such models
 * additionally requires a real 1M window: Claude Code attaches its long-context
 * beta to `[1m]` models, and that synthetic beta must never reach a sub-1M
 * Anthropic-compatible upstream. Translated-wire models are exempt — the beta
 * never leaves the gateway on those paths.
 */
export function isAnthropicPassthroughModel(
  model: Pick<GatewayModel, "provider" | "wire">,
): boolean {
  if (model.provider === "kimi") return true;
  return model.provider === "opencode" && (model.wire ?? "anthropic") === "anthropic";
}

export const GATEWAY_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type GatewayReasoningEffort = typeof GATEWAY_REASONING_EFFORTS[number];

/**
 * Scoped gateway model id → the reasoning rungs exposed as delegation identities.
 * An absent entry means that model's whole ladder.
 */
export type GatewayEffortExposure = Readonly<Record<string, readonly GatewayReasoningEffort[]>>;

const GatewayEffortUpstreamModelIdsSchema = z.partialRecord(
  z.enum(GATEWAY_REASONING_EFFORTS),
  z.string().min(1),
);

const GatewayModelEffortSchema = z.discriminatedUnion("supported", [
  z.object({
    supported: z.literal(true),
    levels: z.array(z.enum(GATEWAY_REASONING_EFFORTS)).min(1),
    upstreamModelIdTemplate: z.string().min(1).optional(),
    upstreamModelIds: GatewayEffortUpstreamModelIdsSchema.optional(),
  }).strict(),
  z.object({
    supported: z.literal(false),
  }).strict(),
]);

export const GATEWAY_QUOTA_SCOPES = ["auto", "api"] as const;
export type GatewayQuotaScope = typeof GATEWAY_QUOTA_SCOPES[number];

/**
 * The provider's own positioning of a model within its current lineup, read
 * from what the provider states — lineup defaults, tier tokens (`max`/`pro`
 * against `plus` against `flash`/`mini`-class names), and generation
 * supersession. It is a prior, not a measurement: Fleet-measured suitability
 * stays in role fit, and a measured verdict outranks this class wherever the
 * two disagree.
 *
 * Ambiguity resolves downward. Overclassing puts a light model in seats that
 * needed judgment; underclassing merely costs one candidate. A `-fast` entry
 * therefore inherits its base class only when `providerModelId` proves it is
 * the same upstream under different service terms; an unlinked `-fast`/`flash`
 * name reads as the provider's light tier.
 *
 * Routing aliases (Cursor's `auto`) carry no class: what serves the request
 * varies per call, so any single class would lie.
 */
export const GATEWAY_CAPABILITY_CLASSES = ["flagship", "standard", "light"] as const;
export type GatewayCapabilityClass = typeof GATEWAY_CAPABILITY_CLASSES[number];

const GatewayModelEntrySchema = z.object({
  modelId: z.string().min(1),
  name: z.string().min(1),
  capabilityClass: z.enum(GATEWAY_CAPABILITY_CLASSES).optional(),
  description: z.string().min(1).optional(),
  providerModelId: z.string().min(1).optional(),
  serviceTier: z.literal("priority").optional(),
  cursorMaxMode: z.literal(true).optional(),
  quotaScope: z.enum(GATEWAY_QUOTA_SCOPES).optional(),
  wire: z.enum(GATEWAY_MODEL_WIRES).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  contextWindow: z.number().int().positive().optional(),
  effort: GatewayModelEffortSchema.optional(),
}).strict();

const GatewayProviderSchema = z.object({
  name: z.string().min(1),
  defaultModel: z.string().min(1),
  source: z.string().min(1),
  models: z.array(GatewayModelEntrySchema).min(1),
}).strict();

export const GatewayModelsRegistrySchema = z.object({
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  providers: z.object({
    codex: GatewayProviderSchema,
    cursor: GatewayProviderSchema,
    kimi: GatewayProviderSchema,
    opencode: GatewayProviderSchema,
  }).strict(),
}).strict();

export type GatewayModelsRegistry = z.infer<typeof GatewayModelsRegistrySchema>;
type GatewayModelEntry = z.infer<typeof GatewayModelEntrySchema>;

export type GatewayModelEffort =
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly levels: readonly GatewayReasoningEffort[];
      /** Cursor wire id with one `{effort}` placeholder, resolved immediately before transport. */
      readonly upstreamModelIdTemplate?: string;
      /** Exact Cursor wire ids for effort tiers that do not follow the model's common template. */
      readonly upstreamModelIds?: Readonly<Partial<Record<GatewayReasoningEffort, string>>>;
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
  readonly serviceTier?: "priority";
  /** Cursor Run's modelDetails.maxMode flag; omitted for standard-mode models. */
  readonly cursorMaxMode?: true;
  /**
   * Sub-allowance this model is billed against, when its provider splits one
   * subscription across pools. Cursor spends Auto-tier and API-tier models from
   * separate budgets, so the provider's combined usage figure cannot tell a
   * caller whether this particular model still has room.
   */
  readonly quotaScope?: GatewayQuotaScope;
  /** Upstream wire protocol; OpenCode Go only. Omission means `anthropic`. */
  readonly wire?: GatewayModelWire;
  /** Provider-stated lineup positioning; absent only on routing aliases. */
  readonly capabilityClass?: GatewayCapabilityClass;
  readonly description?: string;
  /** Authoritative input context window reported by the provider/reference catalog. */
  readonly contextWindow?: number;
  /** Model-specific reasoning ladder. Missing registry metadata is treated as unsupported. */
  readonly effort: GatewayModelEffort;
  /** Accepted request ids that are intentionally omitted from discovery. */
  readonly aliases?: readonly string[];
}

const registry = parseGatewayModelsRegistry(modelsData);

export function parseGatewayModelsRegistry(value: unknown): GatewayModelsRegistry {
  const parsed = GatewayModelsRegistrySchema.parse(value);
  validateRegistry(parsed);
  return parsed;
}

export const GATEWAY_MODELS_UPDATED_AT = registry.updatedAt;

/** Human-readable provider names as declared by the model registry (e.g. `Moonshot-Kimi`). */
export const GATEWAY_PROVIDER_NAMES: Readonly<Record<GatewayProvider, string>> = Object.freeze(
  Object.fromEntries(
    GATEWAY_PROVIDERS.map((provider) => [provider, registry.providers[provider].name]),
  ) as Record<GatewayProvider, string>,
);

export const GATEWAY_MODELS: readonly GatewayModel[] = Object.freeze(
  GATEWAY_PROVIDERS.flatMap((provider) => {
    const definition = registry.providers[provider];
    return definition.models.map((entry) => Object.freeze(toGatewayModel(provider, definition.name, entry)));
  }),
);

export const CODEX_SUBSCRIPTION_MODELS = providerModels("codex");
export const CURSOR_SUBSCRIPTION_MODELS = providerModels("cursor");
export const KIMI_SUBSCRIPTION_MODELS = providerModels("kimi");
export const OPENCODE_SUBSCRIPTION_MODELS = providerModels("opencode");

/**
 * The prefix every discovered gateway model id carries.
 *
 * It was introduced against a Claude Code discovery filter that dropped ids not
 * beginning with `claude`. That filter no longer exists: in 2.1.221 the reader of
 * the gateway model cache maps every entry into the picker with no id test at all
 * (observed 2026-08-04). The prefix is therefore not what makes a model
 * discoverable, and a future reader should not infer that it is.
 *
 * It stays because the grammar is already published. Persisted sessions,
 * `ANTHROPIC_MODEL` values, and stored defaults hold prefixed ids, and
 * `findGatewayModel` resolves a prefixed id and a bare registry id to the same
 * model. Dropping the prefix is a migration of those persisted values, not an
 * edit to this constant.
 */
export const GATEWAY_MODEL_ALIAS_PREFIX = "claude-gateway--";
const CLAUDE_ONE_MILLION_MARKER = "[1m]";
const CLAUDE_ONE_MILLION_DISPLAY_SUFFIX = " (1M Context)";

export function toGatewayModelAlias(modelId: string): string {
  return `${GATEWAY_MODEL_ALIAS_PREFIX}${modelId}`;
}

/**
 * Claude Code only understands its default 200k coordinate and a `[1m]`
 * coordinate. Translated models whose real window is above 200k use the latter
 * while the gateway projects their response usage onto it.
 *
 * The projection divides by the model's real window and nothing else. Dividing by
 * a smaller budget — a provider's own compaction threshold, say — would map the
 * band between that budget and the real window onto 100%+ of the 1M coordinate, a
 * region Claude Code treats as "context exceeds the limit" and refuses to
 * auto-compact out of. Metering against the real window instead lets Claude Code's
 * own reserve compact the session while capacity remains.
 *
 * Anthropic passthrough models (Kimi, and OpenCode's anthropic-wire entries)
 * additionally require a real window of at least 1M, so a synthetic long-context
 * beta never reaches a sub-1M Anthropic-compatible upstream.
 */
export function toClaudeGatewayModelId(model: GatewayModel): string {
  const alias = toGatewayModelAlias(model.id);
  if (
    canProjectClaudeContextWindow(model.contextWindow)
    && (!isAnthropicPassthroughModel(model)
      || isClaudeOneMillionContextWindow(model.contextWindow))
  ) {
    return `${alias}${CLAUDE_ONE_MILLION_MARKER}`;
  }
  return alias;
}

function toClaudeGatewayModelDisplayName(model: GatewayModel): string {
  return isClaudeOneMillionContextWindow(model.contextWindow)
    ? `${model.displayName}${CLAUDE_ONE_MILLION_DISPLAY_SUFFIX}`
    : model.displayName;
}

export function findGatewayModel(
  id: string,
  catalog: readonly GatewayModel[] = GATEWAY_MODELS,
): GatewayModel | undefined {
  if (id.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)) {
    const scopedId = stripClaudeOneMillionMarker(id).slice(GATEWAY_MODEL_ALIAS_PREFIX.length);
    const model = catalog.find((candidate) => candidate.id === scopedId);
    if (!model) return undefined;
    // Claude Code may omit the discovery-only marker from the request, so both
    // forms resolve to the same registry model. A fabricated marker for a
    // genuinely unmarked 200k model would make Claude undercount its context,
    // so accept a marker only when discovery emits one.
    return hasClaudeOneMillionMarker(id)
      && !hasClaudeOneMillionMarker(toClaudeGatewayModelId(model))
      ? undefined
      : model;
  }
  return catalog.find((model) => model.id === id || model.aliases?.includes(id));
}

export function upstreamModelId(model: GatewayModel): string {
  return model.upstreamId ?? model.id;
}

/**
 * The upstream model a catalog entry actually reaches, as `provider::upstreamId`.
 *
 * Several entries are the same model under different service terms — Codex's
 * `-fast` variants are the priority tier of an identical upstream id — so a fact
 * measured about one holds for its siblings. Entries that merely share a vendor
 * name do not collapse: Cursor's `kimi-k3` and Moonshot's `k3` reach different
 * upstreams through different transports and keep separate identities.
 *
 * This is a lookup key for measurements recorded per upstream, not a routing
 * fact and not an id anything accepts. It stays out of `GatewayModelConstraints`
 * for that reason: a caller handed a `provider::model` string next to real model
 * ids will eventually pass it as one.
 */
export function gatewayModelIdentity(model: GatewayModel): string {
  return `${model.provider}::${upstreamModelId(model)}`;
}

/**
 * Facts a caller must respect when routing work to a model. Everything here is
 * derived from the catalog, so a newly added model carries them without further
 * declaration — unlike suitability, which is a judgement and lives elsewhere.
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
   * True when the model shares Anthropic's lineage, and therefore its blind
   * spots, with a Claude Code session's own model. Such a model can move spend
   * off the parent's subscription, but adds nothing to a panel that depends on
   * independent judgement. Vendors keep the `claude-` prefix stable, so new
   * Anthropic entries are recognized without further declaration.
   */
  readonly homolineage: boolean;
  /**
   * The provider's stated lineup positioning ({@link GatewayCapabilityClass}).
   * A quality prior for seats whose product is judgment; measured role fit
   * outranks it, and allowance never implies it. Absent on routing aliases.
   */
  readonly capabilityClass?: GatewayCapabilityClass;
  readonly quotaScope?: GatewayQuotaScope;
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
    homolineage: upstreamModelId(model).toLowerCase().startsWith("claude"),
    ...(model.capabilityClass ? { capabilityClass: model.capabilityClass } : {}),
    ...(model.quotaScope ? { quotaScope: model.quotaScope } : {}),
  };
}

export interface CursorModelSelection {
  readonly upstreamModelId: string;
  readonly maxMode: boolean;
}

/** Resolve one picker-visible Cursor model to its exact wire id and billing/context mode. */
export function resolveCursorModelSelection(
  modelId: string,
  requestedEffort?: ReasoningEffort,
  catalog: readonly GatewayModel[] = CURSOR_SUBSCRIPTION_MODELS,
): CursorModelSelection {
  const model = findGatewayModel(modelId, catalog)
    ?? catalog.find((candidate) => candidate.provider === "cursor" && (
      candidate.id === scopedModelId("cursor", modelId)
      || upstreamModelId(candidate) === modelId
    ));
  if (!model || model.provider !== "cursor") {
    return { upstreamModelId: modelId, maxMode: false };
  }

  const upstreamId = upstreamModelId(model);
  if (!model.effort.supported) {
    return { upstreamModelId: upstreamId, maxMode: model.cursorMaxMode === true };
  }
  // 카탈로그는 모델별 기본 effort를 정의하지 않는다. Claude Code는 effort 미설정 세션에도
  // 항상 자기 세션 기본값 "high"를 명시해 보내므로(2026-08-02 실측), effort를 생략하는
  // 드문 호출자에게도 같은 기준을 적용해 사다리 안으로 하향 클램프한다.
  const effort = clampReasoningEffort(
    requestedEffort ?? "high",
    model.effort.levels,
    upstreamId,
  ) as GatewayReasoningEffort;
  const exactModelId = model.effort.upstreamModelIds?.[effort];
  return {
    upstreamModelId: exactModelId
      ?? model.effort.upstreamModelIdTemplate?.replace("{effort}", effort)
      ?? upstreamId,
    maxMode: model.cursorMaxMode === true,
  };
}

/** Backwards-compatible wire-id-only view of {@link resolveCursorModelSelection}. */
export function resolveCursorUpstreamModelId(
  modelId: string,
  requestedEffort?: ReasoningEffort,
  catalog: readonly GatewayModel[] = CURSOR_SUBSCRIPTION_MODELS,
): string {
  return resolveCursorModelSelection(modelId, requestedEffort, catalog).upstreamModelId;
}

export function gatewayProviderDefault(provider: GatewayProvider): GatewayModel {
  const defaultModel = registry.providers[provider].defaultModel;
  const resolved = GATEWAY_MODELS.find(
    (model) => model.provider === provider && model.id === scopedModelId(provider, defaultModel),
  );
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

export interface AnthropicModelEntry {
  readonly type: "model";
  readonly id: string;
  readonly display_name: string;
  readonly created_at: string;
  readonly capabilities: AnthropicModelCapabilities;
  readonly max_input_tokens: number | null;
  readonly max_tokens: null;
}

export interface AnthropicModelList {
  readonly data: readonly AnthropicModelEntry[];
  readonly has_more: false;
  readonly first_id: string | null;
  readonly last_id: string | null;
}

/** Claude Code gateway model discovery (`GET /v1/models`). */
export function buildAnthropicModelList(
  models: readonly GatewayModel[] = GATEWAY_MODELS,
  createdAt = GATEWAY_MODELS_UPDATED_AT,
): AnthropicModelList {
  const data = models.map((model) => ({
    type: "model" as const,
    id: toClaudeGatewayModelId(model),
    display_name: toClaudeGatewayModelDisplayName(model),
    created_at: createdAt,
    capabilities: anthropicModelCapabilities(model.effort),
    max_input_tokens: model.contextWindow ?? null,
    max_tokens: null,
  }));
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

/** Resolve a canonical gateway id or current provider alias to its wire model id. */
export function resolveGatewayModel(
  requested: string | undefined,
  options: { readonly override?: string; readonly catalog?: readonly GatewayModel[]; readonly fallback: string },
): string {
  if (options.override) return options.override;
  if (!requested) return options.fallback;
  const model = findGatewayModel(requested, options.catalog ?? GATEWAY_MODELS);
  return model ? upstreamModelId(model) : options.fallback;
}

function scopedModelId(provider: GatewayProvider, modelId: string): string {
  return `${provider}--${modelId}`;
}

function toGatewayModel(
  provider: GatewayProvider,
  providerName: string,
  entry: GatewayModelEntry,
): GatewayModel {
  return {
    id: scopedModelId(provider, entry.modelId),
    displayName: `${providerName}-${entry.name}`,
    provider,
    upstreamId: entry.providerModelId ?? entry.modelId,
    ...(entry.serviceTier ? { serviceTier: entry.serviceTier } : {}),
    ...(entry.cursorMaxMode ? { cursorMaxMode: entry.cursorMaxMode } : {}),
    ...(entry.quotaScope ? { quotaScope: entry.quotaScope } : {}),
    ...(entry.wire ? { wire: entry.wire } : {}),
    ...(entry.capabilityClass ? { capabilityClass: entry.capabilityClass } : {}),
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
  for (const provider of GATEWAY_PROVIDERS) {
    const definition = value.providers[provider];
    const modelIds = new Set<string>();
    for (const model of definition.models) {
      if (model.modelId.includes("--")) {
        throw new Error(`Gateway model id contains reserved separator: ${provider}/${model.modelId}`);
      }
      if (modelIds.has(model.modelId)) {
        throw new Error(`Duplicate gateway model id: ${provider}/${model.modelId}`);
      }
      modelIds.add(model.modelId);
      // A routing alias serves a different model per call, so any single class
      // would lie; every real model must state one so judgment-seat policy has
      // a prior to read. `default` is the only routing upstream observed.
      const isRoutingAlias = model.providerModelId === "default";
      if (isRoutingAlias && model.capabilityClass) {
        throw new Error(`Gateway routing alias cannot carry a capability class: ${provider}/${model.modelId}`);
      }
      if (!isRoutingAlias && !model.capabilityClass) {
        throw new Error(`Gateway model is missing a capability class: ${provider}/${model.modelId}`);
      }
      // A service-tier sibling is the same upstream under different terms; a
      // class diverging from its base would let the serving tier edit the prior.
      if (!isRoutingAlias && model.providerModelId) {
        const base = definition.models.find((candidate) => candidate.modelId === model.providerModelId);
        if (base && base.capabilityClass !== model.capabilityClass) {
          throw new Error(`Gateway service-tier sibling class differs from its base: ${provider}/${model.modelId}`);
        }
      }
      if (model.serviceTier && !model.providerModelId) {
        throw new Error(`Gateway service tier requires providerModelId: ${provider}/${model.modelId}`);
      }
      if (model.serviceTier && provider !== "codex") {
        throw new Error(`Gateway service tier is only supported by Codex: ${provider}/${model.modelId}`);
      }
      if (model.cursorMaxMode && provider !== "cursor") {
        throw new Error(`Gateway Cursor Max Mode is only supported by Cursor: ${provider}/${model.modelId}`);
      }
      // Cursor is the only provider observed to split one subscription across
      // pools. Declaring a scope elsewhere would invite a caller to look for a
      // per-pool window that provider's usage response never reports.
      if (model.quotaScope && provider !== "cursor") {
        throw new Error(`Gateway quota scope is only supported by Cursor: ${provider}/${model.modelId}`);
      }
      // OpenCode Go is the only provider serving one subscription over several
      // wire protocols; elsewhere a wire declaration would be dead metadata.
      if (model.wire && provider !== "opencode") {
        throw new Error(`Gateway model wire is only supported by OpenCode: ${provider}/${model.modelId}`);
      }
      if (model.effort?.supported) {
        if (new Set(model.effort.levels).size !== model.effort.levels.length) {
          throw new Error(`Gateway effort levels contain duplicates: ${provider}/${model.modelId}`);
        }
        const template = model.effort.upstreamModelIdTemplate;
        const exactModelIds = model.effort.upstreamModelIds;
        if (provider === "cursor" && !template && !exactModelIds) {
          throw new Error(`Cursor effort model requires an upstream model id template or overrides: ${provider}/${model.modelId}`);
        }
        if (template) {
          if (provider !== "cursor") {
            throw new Error(`Gateway effort model id templates are only supported by Cursor: ${provider}/${model.modelId}`);
          }
          if (template.split("{effort}").length !== 2) {
            throw new Error(`Gateway effort model id template must contain one {effort}: ${provider}/${model.modelId}`);
          }
        }
        if (exactModelIds) {
          if (provider !== "cursor") {
            throw new Error(`Gateway effort model id overrides are only supported by Cursor: ${provider}/${model.modelId}`);
          }
          for (const effort of Object.keys(exactModelIds) as GatewayReasoningEffort[]) {
            if (!model.effort.levels.includes(effort)) {
              throw new Error(`Gateway effort model id override is not an advertised level: ${provider}/${model.modelId}/${effort}`);
            }
          }
        }
        if (provider === "cursor" && !template) {
          const missing = model.effort.levels.find((effort) => !exactModelIds?.[effort]);
          if (missing) {
            throw new Error(`Cursor effort model has no upstream model id for level: ${provider}/${model.modelId}/${missing}`);
          }
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
    ...(effort.upstreamModelIdTemplate
      ? { upstreamModelIdTemplate: effort.upstreamModelIdTemplate }
      : {}),
    ...(effort.upstreamModelIds
      ? { upstreamModelIds: Object.freeze({ ...effort.upstreamModelIds }) }
      : {}),
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

function anthropicModelCapabilities(effort: GatewayModelEffort): AnthropicModelCapabilities {
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
    // once the gateway forwards Anthropic image blocks to Codex/Cursor.
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
