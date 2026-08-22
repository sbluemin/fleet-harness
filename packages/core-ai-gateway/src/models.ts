import benchmarksData from "../benchmarks.json" with { type: "json" };
import modelsData from "../models.json" with { type: "json" };
import { z } from "zod";

import { clampReasoningEffort, type ReasoningEffort } from "./canonical/index.js";
import {
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

export const GATEWAY_PROVIDERS = ["codex", "xai", "cursor", "opencode", "kimi"] as const;
export type GatewayProvider = typeof GATEWAY_PROVIDERS[number];

/**
 * The upstream wire protocol a model is served over. Only the OpenCode Go
 * provider declares this today: its subscription exposes Anthropic, OpenAI
 * Responses, and Chat Completions endpoints side by side, and each model is
 * native to exactly one of them. Omission means `anthropic`.
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

const GATEWAY_QUOTA_SCOPES = ["auto", "api"] as const;
export type GatewayQuotaScope = typeof GATEWAY_QUOTA_SCOPES[number];

/**
 * The provider's own positioning of a model within its current lineup, read
 * from what the provider states — lineup defaults, tier tokens (`max`/`pro`
 * against `plus` against `flash`/`mini`-class names), and generation
 * supersession. It is a prior, not a measurement: the provider's statement
 * about its own lineup, never Fleet's judgment of quality.
 *
 * Ambiguity resolves downward. Overclassing puts a light model in seats that
 * needed judgment; underclassing merely costs one candidate. A `-fast` entry
 * therefore inherits its base class only where a link proves it is the same
 * upstream under different service terms, and an unlinked `-fast`/`flash` name
 * reads as the provider's light tier.
 *
 * Two links prove it, because providers spell the same fact two ways. Where the
 * variant reaches its base's own wire id, `providerModelId` already carries the
 * proof. Where the provider gives the variant a wire id of its own — Cursor's
 * `cursor-grok-4.6-{effort}-fast` against `cursor-grok-4.6-{effort}` — that
 * field is spoken for by the wire, so {@link GatewayModelEntry.variantOf} states
 * the lineage separately. Without the second spelling such a variant could not
 * be linked at all, and the downward rule would grade a flagship's priority tier
 * as light purely because the catalog had no room to say otherwise.
 *
 * Routing aliases (Cursor's `auto`) carry no class: what serves the request
 * varies per call, so any single class would lie.
 */
const GATEWAY_CAPABILITY_CLASSES = ["flagship", "standard", "light"] as const;
export type GatewayCapabilityClass = typeof GATEWAY_CAPABILITY_CLASSES[number];

const GatewayBenchmarkFiguresSchema = z.object({
  score: z.number().positive().max(100),
  tokensPerTask: z.number().int().positive(),
  stepsPerTask: z.number().int().positive().optional(),
}).strict();

const GatewayBenchmarkSourceSchema = z.object({
  name: z.string().min(1),
  benchVersion: z.string().min(1),
  observedAt: z.iso.datetime(),
  url: z.string().min(1),
  method: z.string().min(1),
  /**
   * Fleet가 라우팅상 동률로 취급하는 점수 폭. **소스가 발표한 통계값이 아니라 Fleet의
   * 보수적 라우팅 정책이다** — CursorBench는 동률 임계값을 발표하지 않는다. 그래서 이
   * 값은 소스를 서술하는 `method`가 아니라 여기에 있고, 이름도 소스 쪽 사실처럼 읽히지
   * 않게 둔다 — 호스트에는 소스 이름 바로 옆에 실려 나가므로, 이름이 근거 등급을
   * 그대로 말해 버린다.
   */
  routingTieBandPoints: z.number().positive(),
}).strict();

const GatewayBenchmarkModelEntrySchema = z.object({
  source: z.string().min(1),
  rungs: z.partialRecord(z.enum(GATEWAY_REASONING_EFFORTS), GatewayBenchmarkFiguresSchema).optional(),
  overall: GatewayBenchmarkFiguresSchema.optional(),
  caveat: z.string().min(1).optional(),
}).strict().refine((entry) => entry.rungs !== undefined || entry.overall !== undefined, {
  message: "Gateway benchmark model entry requires rungs or overall",
});

/**
 * benchmarks.json 저작 규칙 — 스키마가 강제하지 못하는 것:
 *
 * **소스는 CursorBench 하나뿐이며, 단일 소스는 의도된 정책이다.** 점수와 토큰
 * 수치는 하니스 상대값이라 소스 간 비교가 성립하지 않는데, 소스가 여럿이면
 * 호스트 판정이 비교 불가능한 수치들 사이에서 흐려진다는 것이 실측 교훈이다
 * (2026-08-08에 SWE-rebench·AA Terminal-Bench v2.1을 들였다가 같은 날 이
 * 이유로 걷어냈다 — 제2 소스 재도입은 사용자 재가 사항이다). 따라서
 * CursorBench(cursor.com/cursorbench, 에이전트형 다중 파일 코딩, Cursor 자체
 * 하니스)에 행이 없는 모델은 벤치 항목을 만들지 않고 그대로 둔다 — 무증거
 * 모델은 `capabilityClass`가 유일한 사전 확률로 호스트 판정을 이끈다.
 *
 * CursorBench가 새 버전을 내면: 벤더 자기 보고가 아니라 Cursor가 전 모델을
 * 같은 하니스로 직접 돌린 결과인지 확인한 뒤, `benchVersion`·수치를 갱신하고
 * 그 소스의 `observedAt`을 함께 올린다 — 로스터 revision이 이 스탬프를 실어
 * 나르므로, 올리지 않은 편집은 호스트에게 보이지 않는다. 조인의 나머지
 * 불변식(형제 키 공유·별칭 제외·고아 검출·내로잉 후 공백)은 validateRegistry와
 * validateBenchmarkCoverage가 강제한다.
 */
const GatewayBenchmarksRegistrySchema = z.object({
  version: z.number().int().positive(),
  sources: z.record(z.string().min(1), GatewayBenchmarkSourceSchema),
  models: z.record(z.string().min(1), GatewayBenchmarkModelEntrySchema),
}).strict();

export type GatewayBenchmarkFigures = {
  readonly score: number;
  readonly tokensPerTask: number;
  readonly stepsPerTask?: number;
};

export type GatewayModelBenchmark = {
  readonly source: string;
  readonly observedAt: string;
  readonly routingTieBandPoints: number;
  readonly rungs?: Readonly<Partial<Record<GatewayReasoningEffort, GatewayBenchmarkFigures>>>;
  readonly overall?: GatewayBenchmarkFigures;
  readonly caveat?: string;
};

type GatewayBenchmarkModelEntry = z.infer<typeof GatewayBenchmarkModelEntrySchema>;
type GatewayBenchmarksRegistry = z.infer<typeof GatewayBenchmarksRegistrySchema>;

const GatewayModelPricingSchema = z.object({
  inputCostPerToken: z.number().nonnegative(),
  outputCostPerToken: z.number().nonnegative(),
  cacheReadInputTokenCost: z.number().nonnegative(),
  cacheCreationInputTokenCost: z.number().nonnegative().optional(),
  aliases: z.array(z.string().min(1)).min(1),
}).strict();

const GatewayPricingRegistrySchema = z.object({
  source: z.literal("openrouter"),
  observedAt: z.iso.datetime(),
  models: z.record(z.string().min(1), GatewayModelPricingSchema),
}).strict();

const GatewayModelEntrySchema = z.object({
  modelId: z.string().min(1),
  name: z.string().min(1),
  capabilityClass: z.enum(GATEWAY_CAPABILITY_CLASSES).optional(),
  benchmarkKey: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  providerModelId: z.string().min(1).optional(),
  /**
   * The catalog entry this one is a serving variant of, when the provider gives
   * the variant its own wire id and `providerModelId` is therefore unavailable
   * as the lineage link. Pure provenance: it names a sibling `modelId` in the
   * same provider and never reaches a request, so the variant keeps sending its
   * own upstream id while inheriting the base's class and benchmark evidence.
   */
  variantOf: z.string().min(1).optional(),
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

const GatewayModelsRegistrySchema = z.object({
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  providers: z.object({
    codex: GatewayProviderSchema,
    cursor: GatewayProviderSchema,
    kimi: GatewayProviderSchema,
    opencode: GatewayProviderSchema,
    xai: GatewayProviderSchema,
  }).strict(),
  pricing: GatewayPricingRegistrySchema,
}).strict();

export type GatewayModelsRegistry = z.infer<typeof GatewayModelsRegistrySchema>;
type GatewayModelEntry = z.infer<typeof GatewayModelEntrySchema>;

export interface GatewayModelPricing {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadInputTokenCost: number;
  readonly cacheCreationInputTokenCost?: number;
  readonly aliases: readonly string[];
}

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
  /** Third-party benchmark evidence keyed from benchmarks.json. */
  readonly benchmark?: GatewayModelBenchmark;
  readonly description?: string;
  /** Authoritative input context window reported by the provider/reference catalog. */
  readonly contextWindow?: number;
  /** Model-specific reasoning ladder. Missing registry metadata is treated as unsupported. */
  readonly effort: GatewayModelEffort;
  /** Accepted request ids that are intentionally omitted from discovery. */
  readonly aliases?: readonly string[];
}


const benchmarksRegistry = parseGatewayBenchmarksRegistry(benchmarksData);

export function parseGatewayBenchmarksRegistry(value: unknown): GatewayBenchmarksRegistry {
  const parsed = GatewayBenchmarksRegistrySchema.parse(value);
  for (const [modelKey, entry] of Object.entries(parsed.models)) {
    if (!parsed.sources[entry.source]) {
      throw new Error(`Gateway benchmark model entry names an unknown source: ${modelKey} -> ${entry.source}`);
    }
  }
  return parsed;
}

export function parseGatewayModelsRegistry(value: unknown): GatewayModelsRegistry {
  const parsed = GatewayModelsRegistrySchema.parse(value);
  validateRegistry(parsed);
  return parsed;
}

const registry = (() => {
  const parsed = parseGatewayModelsRegistry(modelsData);
  validateBenchmarkCoverage(parsed);
  return parsed;
})();

export const GATEWAY_MODELS_UPDATED_AT = registry.updatedAt;
export const GATEWAY_MODEL_PRICING: Readonly<Record<string, GatewayModelPricing>> = Object.freeze(
  Object.fromEntries(
    Object.entries(registry.pricing.models).map(([modelId, pricing]) => [
      modelId,
      Object.freeze({ ...pricing, aliases: Object.freeze([...pricing.aliases]) }),
    ]),
  ),
);

/**
 * Deterministic stamp that moves whenever any benchmark source is re-observed.
 * Roster revisions include it so a bench refresh is visible as a catalog change.
 */
export const GATEWAY_BENCHMARKS_STAMP = Object.entries(benchmarksRegistry.sources)
  .map(([sourceId, source]) => `${sourceId}:${source.observedAt}`)
  .sort()
  .join("|");

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
 * Claude Code understands only its default 200k coordinate and the `[1m]` 1M
 * coordinate. Keep that marker truthful: only a provider model whose real window
 * reaches 1M is advertised as such. The response compatibility seam maps every
 * other real window onto the unmarked 200k coordinate while preserving Claude's
 * absolute compaction reserve.
 */
export function toClaudeGatewayModelId(model: GatewayModel): string {
  const alias = toGatewayModelAlias(model.id);
  return isClaudeOneMillionContextWindow(model.contextWindow)
    ? `${alias}${CLAUDE_ONE_MILLION_MARKER}`
    : alias;
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
   * True when the model shares Anthropic's lineage, and therefore its blind
   * spots, with a Claude Code session's own model. Such a model can move spend
   * off the parent's subscription, but adds nothing to a panel that depends on
   * independent judgement. Vendors keep the `claude-` prefix stable, so new
   * Anthropic entries are recognized without further declaration.
   */
  readonly homolineage: boolean;
  /**
   * The provider's stated lineup positioning ({@link GatewayCapabilityClass}).
   * The quality prior for seats whose product is judgment; allowance never
   * implies it. Absent on routing aliases.
   */
  readonly capabilityClass?: GatewayCapabilityClass;
  /**
   * Third-party measured evidence about the vendor model. Where present and
   * fresh it outranks the capabilityClass prior for quality ordering, and
   * capabilityClass stands where it is absent. Fleet treats a score gap within
   * routingTieBandPoints as a routing tie; that band is Fleet's own policy, not
   * a significance threshold published by the source.
   */
  readonly benchmark?: GatewayModelBenchmark;
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
    ...(model.benchmark ? { benchmark: model.benchmark } : {}),
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

function freezeBenchmarkFigures(figures: GatewayBenchmarkFigures): GatewayBenchmarkFigures {
  return Object.freeze({ ...figures });
}

function resolveGatewayModelBenchmark(
  entry: GatewayModelEntry,
  effort: GatewayModelEffort,
): GatewayModelBenchmark | undefined {
  if (!entry.benchmarkKey) return undefined;
  const benchEntry = benchmarksRegistry.models[entry.benchmarkKey];
  if (!benchEntry) return undefined;
  const source = benchmarksRegistry.sources[benchEntry.source];
  if (!source) return undefined;

  let rungs: Partial<Record<GatewayReasoningEffort, GatewayBenchmarkFigures>> | undefined;
  if (benchEntry.rungs) {
    if (effort.supported) {
      const narrowed = effort.levels
        .filter((level) => benchEntry.rungs?.[level] !== undefined)
        .map((level) => [level, freezeBenchmarkFigures(benchEntry.rungs![level]!)] as const);
      rungs = narrowed.length > 0
        ? Object.freeze(Object.fromEntries(narrowed)) as Partial<Record<GatewayReasoningEffort, GatewayBenchmarkFigures>>
        : undefined;
    } else {
      rungs = Object.freeze(
        Object.fromEntries(
          Object.entries(benchEntry.rungs).map(([level, figures]) => [
            level as GatewayReasoningEffort,
            freezeBenchmarkFigures(figures),
          ]),
        ),
      ) as Partial<Record<GatewayReasoningEffort, GatewayBenchmarkFigures>>;
    }
  }

  const overall = benchEntry.overall ? freezeBenchmarkFigures(benchEntry.overall) : undefined;
  const benchmark = Object.freeze({
    source: `${source.name} ${source.benchVersion}`,
    observedAt: source.observedAt,
    routingTieBandPoints: source.routingTieBandPoints,
    ...(rungs ? { rungs } : {}),
    ...(overall ? { overall } : {}),
    ...(benchEntry.caveat ? { caveat: benchEntry.caveat } : {}),
  }) as GatewayModelBenchmark;

  if (!benchmark.rungs && !benchmark.overall) return undefined;
  return benchmark;
}

function toGatewayModel(
  provider: GatewayProvider,
  providerName: string,
  entry: GatewayModelEntry,
): GatewayModel {
  const benchmark = resolveGatewayModelBenchmark(entry, freezeGatewayModelEffort(entry.effort));
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
    ...(benchmark ? { benchmark } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
    effort: freezeGatewayModelEffort(entry.effort),
    ...(entry.aliases ? { aliases: Object.freeze([...entry.aliases]) } : {}),
  };
}

function providerModels(provider: GatewayProvider): readonly GatewayModel[] {
  return Object.freeze(GATEWAY_MODELS.filter((model) => model.provider === provider));
}

export function validateBenchmarkCoverage(
  value: GatewayModelsRegistry,
  benchmarks: GatewayBenchmarksRegistry = benchmarksRegistry,
): void {
  const referencedBenchmarkKeys = new Set<string>();
  for (const provider of GATEWAY_PROVIDERS) {
    for (const model of value.providers[provider].models) {
      if (model.benchmarkKey) referencedBenchmarkKeys.add(model.benchmarkKey);
    }
  }
  for (const key of Object.keys(benchmarks.models)) {
    if (!referencedBenchmarkKeys.has(key)) {
      throw new Error(`Gateway benchmark entry is orphaned: ${key}`);
    }
  }
}

function validateRegistry(value: GatewayModelsRegistry): void {
  for (const provider of GATEWAY_PROVIDERS) {
    const definition = value.providers[provider];
    for (const model of definition.models) {
      if (model.benchmarkKey) {
        if (!benchmarksRegistry.models[model.benchmarkKey]) {
          throw new Error(`Gateway benchmark key is unknown: ${provider}/${model.modelId} -> ${model.benchmarkKey}`);
        }
        if (model.providerModelId === "default") {
          throw new Error(`Gateway routing alias cannot carry a benchmark key: ${provider}/${model.modelId}`);
        }
        const resolved = resolveGatewayModelBenchmark(model, freezeGatewayModelEffort(model.effort));
        if (!resolved) {
          throw new Error(`Gateway benchmark resolves to no rungs or overall: ${provider}/${model.modelId}`);
        }
      }
    }
  }
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
      // The lineage link is `providerModelId` where the sibling reaches the
      // base's own wire id, and `variantOf` where the provider gave it one of
      // its own. Two links must never name two different bases.
      const catalogEntry = (modelId: string | undefined) => (
        modelId === undefined ? undefined : definition.models.find((candidate) => candidate.modelId === modelId)
      );
      // `providerModelId`는 계보 지목이기 전에 wire id다. 카탈로그에 없는 upstream 이름을
      // 담고 있으면 어떤 base 도 지목하지 않은 것이므로 `variantOf` 와 경쟁하지 않는다 —
      // 여기서 무조건 불일치를 거부하면, 자체 wire id 와 계보를 동시에 적어야 하는 변형이
      // 다시 표현 불가가 되어 이 필드를 들인 이유가 사라진다.
      const providerLinkedBase = isRoutingAlias ? undefined : catalogEntry(model.providerModelId);
      if (model.variantOf && providerLinkedBase && model.providerModelId !== model.variantOf) {
        throw new Error(`Gateway service-tier sibling names two different bases: ${provider}/${model.modelId}`);
      }
      if (model.variantOf === model.modelId) {
        throw new Error(`Gateway service-tier sibling names itself as its base: ${provider}/${model.modelId}`);
      }
      const baseModelId = isRoutingAlias ? undefined : model.variantOf ?? model.providerModelId;
      if (baseModelId) {
        const base = catalogEntry(baseModelId);
        // `providerModelId` may legitimately name an upstream this catalog does
        // not list, so only an explicit `variantOf` demands a resolvable base.
        if (model.variantOf && !base) {
          throw new Error(`Gateway service-tier sibling names an unknown base: ${provider}/${model.modelId} -> ${model.variantOf}`);
        }
        // A chain would let the class travel two hops from the model that
        // actually stated it, so a base is always a base. 한 홉 위도 두 표기 중
        // 어느 쪽으로든 이어질 수 있으므로 둘 다 본다 — `variantOf` 만 보면 base 가
        // `providerModelId` 로 이어진 형제일 때 체인이 그대로 통과한다.
        const baseLink = base && base.modelId !== base.providerModelId
          ? base.variantOf ?? base.providerModelId
          : base?.variantOf;
        if (base && catalogEntry(baseLink)) {
          throw new Error(`Gateway service-tier sibling names another sibling as its base: ${provider}/${model.modelId}`);
        }
        if (base && base.capabilityClass !== model.capabilityClass) {
          throw new Error(`Gateway service-tier sibling class differs from its base: ${provider}/${model.modelId}`);
        }
        if (base && base.benchmarkKey !== model.benchmarkKey) {
          throw new Error(`Gateway service-tier sibling benchmark key differs from its base: ${provider}/${model.modelId}`);
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
      // OpenCode Go selects among several wires per model; xAI's Grok CLI subscription
      // is fixed to Responses but declares it so routing never falls back to Anthropic.
      if (model.wire && provider !== "opencode" && provider !== "xai") {
        throw new Error(`Gateway model wire is not supported by provider: ${provider}/${model.modelId}`);
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

// 이 집합은 Anthropic wire가 살려내는 사다리다 — model constraints의 effortLadder를 만들고,
// 그 constraints가 설정 DTO의 노출 사다리(exposableEffortLadder)와 fleet-admiral의 위임 신원
// 로스터를 먹인다; discovery(`/v1/models`)의 effort capability도 같은 집합으로 좁힌다.
// 카탈로그 사다리는 max에서 끝난다 — ultracode는 모델의 단이 아니라 Claude Code 하네스가
// launch `--effort ultracode`로 받는 세션 능력이라 모델 메타데이터는 싣지 않는다.
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
