import modelsData from "../models.json" with { type: "json" };
import { z } from "zod";

import { clampReasoningEffort, type ReasoningEffort } from "./canonical.js";

export const GATEWAY_PROVIDERS = ["codex", "cursor", "kimi"] as const;
export type GatewayProvider = typeof GATEWAY_PROVIDERS[number];

export const GATEWAY_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type GatewayReasoningEffort = typeof GATEWAY_REASONING_EFFORTS[number];

const GatewayModelEffortSchema = z.discriminatedUnion("supported", [
  z.object({
    supported: z.literal(true),
    levels: z.array(z.enum(GATEWAY_REASONING_EFFORTS)).min(1),
    default: z.enum(GATEWAY_REASONING_EFFORTS),
    upstreamModelIdTemplate: z.string().min(1).optional(),
  }).strict(),
  z.object({
    supported: z.literal(false),
  }).strict(),
]);

const GatewayModelEntrySchema = z.object({
  modelId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  providerModelId: z.string().min(1).optional(),
  serviceTier: z.literal("priority").optional(),
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
  }).strict(),
}).strict();

export type GatewayModelsRegistry = z.infer<typeof GatewayModelsRegistrySchema>;
type GatewayModelEntry = z.infer<typeof GatewayModelEntrySchema>;

export type GatewayModelEffort =
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly levels: readonly GatewayReasoningEffort[];
      readonly default: GatewayReasoningEffort;
      /** Cursor wire id with one `{effort}` placeholder, resolved immediately before transport. */
      readonly upstreamModelIdTemplate?: string;
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

export const GATEWAY_MODELS: readonly GatewayModel[] = Object.freeze(
  GATEWAY_PROVIDERS.flatMap((provider) => {
    const definition = registry.providers[provider];
    return definition.models.map((entry) => Object.freeze(toGatewayModel(provider, definition.name, entry)));
  }),
);

export const CODEX_SUBSCRIPTION_MODELS = providerModels("codex");
export const CURSOR_SUBSCRIPTION_MODELS = providerModels("cursor");
export const KIMI_SUBSCRIPTION_MODELS = providerModels("kimi");

/**
 * Claude Code currently filters discovered models whose id does not start with `claude`.
 * The gateway therefore exposes a Claude-compatible alias and removes it on lookup.
 */
export const GATEWAY_MODEL_ALIAS_PREFIX = "claude-gateway--";
const CLAUDE_GATEWAY_CONTEXT_FLOOR = 200_000;
const CLAUDE_GATEWAY_COMPAT_CONTEXT_WINDOW = 1_000_000;
const CLAUDE_ONE_MILLION_MARKER = "[1m]";

export function toGatewayModelAlias(modelId: string): string {
  return `${GATEWAY_MODEL_ALIAS_PREFIX}${modelId}`;
}

export function fromGatewayModelAlias(alias: string): string {
  const unwrapped = alias.startsWith(GATEWAY_MODEL_ALIAS_PREFIX)
    ? alias.slice(GATEWAY_MODEL_ALIAS_PREFIX.length)
    : alias;
  return unwrapped.replace(/\[1m\]$/i, "");
}

/**
 * Claude Code only has built-in accounting for its default 200K window and a
 * 1M model variant. Translated models above 200K use the 1M variant; their
 * response usage is projected onto that virtual window by
 * projectClaudeContextInputTokens. Native Kimi passthrough can only use the
 * marker when its real window is at least 1M because its usage stays untouched.
 */
export function toClaudeGatewayModelId(model: GatewayModel): string {
  const alias = toGatewayModelAlias(model.id);
  const window = model.contextWindow;
  const canProjectUsage = model.provider !== "kimi";
  if (
    typeof window === "number"
    && window > CLAUDE_GATEWAY_CONTEXT_FLOOR
    && (canProjectUsage || window >= CLAUDE_GATEWAY_COMPAT_CONTEXT_WINDOW)
  ) {
    return `${alias}${CLAUDE_ONE_MILLION_MARKER}`;
  }
  return alias;
}

/**
 * Project provider input usage onto the 1M coordinate system selected by the
 * Claude compatibility marker. This keeps Claude Code's context percentage and
 * native auto-compaction model-relative without changing provider-side usage.
 */
export function projectClaudeContextInputTokens(
  inputTokens: number,
  contextWindow: number | undefined,
): number {
  if (
    !Number.isFinite(inputTokens)
    || inputTokens < 0
    || typeof contextWindow !== "number"
    || !Number.isFinite(contextWindow)
    || contextWindow <= CLAUDE_GATEWAY_CONTEXT_FLOOR
  ) {
    return inputTokens;
  }
  return Math.ceil(inputTokens * CLAUDE_GATEWAY_COMPAT_CONTEXT_WINDOW / contextWindow);
}

export function findGatewayModel(
  id: string,
  catalog: readonly GatewayModel[] = GATEWAY_MODELS,
): GatewayModel | undefined {
  const lookupId = fromGatewayModelAlias(id);
  return catalog.find((model) => model.id === lookupId || model.aliases?.includes(lookupId));
}

export function upstreamModelId(model: GatewayModel): string {
  return model.upstreamId ?? model.id;
}

/** Resolve one picker-visible Cursor base model to its exact effort-qualified wire id. */
export function resolveCursorUpstreamModelId(
  modelId: string,
  requestedEffort?: ReasoningEffort,
  catalog: readonly GatewayModel[] = CURSOR_SUBSCRIPTION_MODELS,
): string {
  const model = findGatewayModel(modelId, catalog)
    ?? catalog.find((candidate) => candidate.provider === "cursor" && upstreamModelId(candidate) === modelId);
  if (!model || model.provider !== "cursor") return modelId;

  const upstreamId = upstreamModelId(model);
  if (!model.effort.supported || !model.effort.upstreamModelIdTemplate) return upstreamId;
  const effort = clampReasoningEffort(
    requestedEffort ?? model.effort.default,
    model.effort.levels,
    upstreamId,
  );
  return model.effort.upstreamModelIdTemplate.replace("{effort}", effort);
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
    display_name: model.displayName,
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

/** Resolve a gateway id or compatibility alias to the provider's wire model id. */
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
      if (model.serviceTier && !model.providerModelId) {
        throw new Error(`Gateway service tier requires providerModelId: ${provider}/${model.modelId}`);
      }
      if (model.serviceTier && provider !== "codex") {
        throw new Error(`Gateway service tier is only supported by Codex: ${provider}/${model.modelId}`);
      }
      if (model.effort?.supported) {
        if (!model.effort.levels.includes(model.effort.default)) {
          throw new Error(`Gateway effort default is missing from levels: ${provider}/${model.modelId}`);
        }
        if (new Set(model.effort.levels).size !== model.effort.levels.length) {
          throw new Error(`Gateway effort levels contain duplicates: ${provider}/${model.modelId}`);
        }
        const template = model.effort.upstreamModelIdTemplate;
        if (provider === "cursor" && !template) {
          throw new Error(`Cursor effort model requires an upstream model id template: ${provider}/${model.modelId}`);
        }
        if (template) {
          if (provider !== "cursor") {
            throw new Error(`Gateway effort model id templates are only supported by Cursor: ${provider}/${model.modelId}`);
          }
          if (template.split("{effort}").length !== 2) {
            throw new Error(`Gateway effort model id template must contain one {effort}: ${provider}/${model.modelId}`);
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
    default: effort.default,
    ...(effort.upstreamModelIdTemplate
      ? { upstreamModelIdTemplate: effort.upstreamModelIdTemplate }
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
