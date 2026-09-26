import { createHash } from "node:crypto";

import benchmarksData from "../benchmarks.json" with { type: "json" };
import modelsData from "../models.json" with { type: "json" };
import { z } from "zod";

export const GATEWAY_PROVIDERS = ["codex", "xai", "opencode", "antigravity", "muse-code", "claude"] as const;
export type GatewayProvider = typeof GATEWAY_PROVIDERS[number];

/**
 * Providers declared in `models.json`. Claude is not among them: its lineup is
 * whatever the installed Claude Code resolves its aliases to, so it is built
 * from {@link CLAUDE_NATIVE_FAMILIES} and {@link applyClaudeNativeModels}.
 */
type RegistryProvider = Exclude<GatewayProvider, "claude">;
const REGISTRY_PROVIDERS = GATEWAY_PROVIDERS.filter(
  (provider): provider is RegistryProvider => provider !== "claude",
);

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
    upstreamModelIds: GatewayEffortUpstreamModelIdsSchema.optional(),
  }).strict(),
  z.object({
    supported: z.literal(false),
  }).strict(),
]);

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
 * Where the variant reaches its base's own wire id, `providerModelId` carries
 * the lineage. A provider that gives a variant its own wire id declares
 * {@link GatewayModelEntry.variantOf} separately.
 *
 * Routing aliases carry no class: what serves the request varies per call.
 */
const GATEWAY_CAPABILITY_CLASSES = ["flagship", "standard", "light"] as const;
export type GatewayCapabilityClass = typeof GATEWAY_CAPABILITY_CLASSES[number];

const GatewayBenchmarkScoreSchema = z.number().finite().nonnegative().max(100);

const GatewayBenchmarkSourceSchema = z.object({
  name: z.string().min(1),
  benchVersion: z.string().min(1),
  observedAt: z.iso.datetime(),
  url: z.url(),
  method: z.string().min(1),
  license: z.string().min(1),
  artifacts: z.array(z.object({
    url: z.url(),
    sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  }).strict()).min(1),
  metrics: z.record(z.string().min(1), z.object({
    unit: z.string().min(1),
    direction: z.enum(["higher", "lower"]),
    role: z.enum(["quality", "context", "sample-size"]),
  }).strict()),
}).strict();

const GatewayBenchmarkModelEntrySchema = z.object({
  effort: z.enum(GATEWAY_REASONING_EFFORTS),
  measurements: z.record(z.string().min(1), z.object({
    model: z.string().min(1),
    metrics: z.record(z.string().min(1), z.number().finite().nonnegative()),
  }).strict()),
  normalized: z.object({
    score: GatewayBenchmarkScoreSchema,
    sourceScores: z.record(z.string().min(1), GatewayBenchmarkScoreSchema),
  }).strict(),
}).strict();

/**
 * 모든 소스의 지표와 동일 effort가 확인된 모델만 같은 코호트에서 정규화한다.
 * 누락된 측정값은 추정하지 않고 모델 전체를 제외하며 원문 라벨과 근거를 보존한다.
 * 소스 수집·effort 확인·갱신 절차는 ../benchmark-methodology.md를 따른다.
 */
const GatewayBenchmarksRegistrySchema = z.object({
  version: z.literal(3),
  updatedAt: z.iso.datetime(),
  normalization: z.object({
    method: z.literal("cohort-min-max"),
    sourceWeighting: z.literal("equal"),
    missingData: z.literal("exclude-model"),
    effortPolicy: z.literal("exact-match"),
    // 소스가 발표한 통계적 유의성이 아니라 Fleet의 보수적 라우팅 정책이다.
    tieBandPoints: z.literal(2),
  }).strict(),
  sources: z.record(z.string().min(1), GatewayBenchmarkSourceSchema),
  models: z.record(z.string().min(1), GatewayBenchmarkModelEntrySchema),
  excluded: z.record(z.string().min(1), z.object({ reason: z.string().min(1) }).strict()),
  sourceAudit: z.record(z.string().min(1), z.object({
    name: z.string().min(1),
    url: z.url(),
    status: z.literal("excluded"),
    reason: z.string().min(1),
  }).strict()),
}).strict();

export type GatewayBenchmarkFigures = {
  readonly score: number;
};

export type GatewayModelBenchmark = {
  readonly method: "cohort-min-max";
  readonly cohortSize: number;
  readonly effort: GatewayReasoningEffort;
  readonly score: number;
  readonly sourceScores: Readonly<Record<string, number>>;
  readonly sources: readonly string[];
  readonly observedAt: string;
  readonly routingTieBandPoints: 2;
  readonly caveat: string;
};

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
  /** A serving sibling with its own wire id names the catalog base separately. */
  variantOf: z.string().min(1).optional(),
  serviceTier: z.literal("priority").optional(),
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
    opencode: GatewayProviderSchema,
    xai: GatewayProviderSchema,
    antigravity: GatewayProviderSchema,
    "muse-code": GatewayProviderSchema,
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
      /** Exact upstream wire ids for effort tiers (Antigravity). */
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
  /** 공급자가 선언한 업스트림 와이어 프로토콜. 생략하면 `anthropic`이다. */
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
  /**
   * Claude only: the Claude Code alias this entry launches as. The CLI resolves
   * it to its own latest version, so the launch path never pins a version.
   */
  readonly claudeAlias?: string;
}


const benchmarksRegistry = parseGatewayBenchmarksRegistry(benchmarksData);

export function parseGatewayBenchmarksRegistry(value: unknown): GatewayBenchmarksRegistry {
  const parsed = GatewayBenchmarksRegistrySchema.parse(value);
  const sourceIds = Object.keys(parsed.sources);
  const models = Object.entries(parsed.models);
  if (sourceIds.length < 2 || models.length < 2) {
    throw new Error("Gateway benchmark cohort requires at least two sources and two complete models");
  }
  for (const [sourceId, source] of Object.entries(parsed.sources)) {
    if (Object.hasOwn(parsed.sourceAudit, sourceId)) {
      throw new Error(`Gateway benchmark source overlaps excluded source audit: ${sourceId}`);
    }
    if (Object.values(source.metrics).filter((metric) => metric.role === "quality").length !== 1) {
      throw new Error(`Gateway benchmark source requires exactly one quality metric: ${sourceId}`);
    }
  }
  for (const [modelKey, entry] of models) {
    if (Object.hasOwn(parsed.excluded, modelKey)) {
      throw new Error(`Gateway benchmark model overlaps excluded models: ${modelKey}`);
    }
    for (const sourceId of Object.keys(entry.measurements)) {
      if (!Object.hasOwn(parsed.sources, sourceId)) {
        throw new Error(`Gateway benchmark model entry names an unknown source: ${modelKey} -> ${sourceId}`);
      }
    }
    requireBenchmarkKeys(entry.measurements, sourceIds, `${modelKey} measurements`);
    requireBenchmarkKeys(entry.normalized.sourceScores, sourceIds, `${modelKey} sourceScores`);
    for (const sourceId of sourceIds) {
      requireBenchmarkKeys(
        entry.measurements[sourceId]!.metrics,
        Object.keys(parsed.sources[sourceId]!.metrics),
        `${modelKey}/${sourceId} metrics`,
      );
    }
  }

  // 모든 소스가 같은 완전 코호트를 사용하며 품질 이외의 지표는 점수에 섞지 않는다.
  const recomputedScores = new Map<string, number[]>();
  for (const sourceId of sourceIds) {
    const source = parsed.sources[sourceId]!;
    for (const [metricId, metric] of Object.entries(source.metrics)) {
      if (metric.role !== "sample-size") continue;
      const expected = models[0]![1].measurements[sourceId]!.metrics[metricId]!;
      for (const [modelKey, entry] of models) {
        const count = entry.measurements[sourceId]!.metrics[metricId]!;
        if (!Number.isSafeInteger(count) || count <= 0 || count !== expected) {
          throw new Error(`Gateway benchmark sample-size must be an equal positive integer across the cohort: ${modelKey}/${sourceId}/${metricId}`);
        }
      }
    }
    const [qualityId, quality] = Object.entries(source.metrics).find(([, metric]) => metric.role === "quality")!;
    const values = models.map(([, entry]) => entry.measurements[sourceId]!.metrics[qualityId]!);
    const min = values.reduce((minimum, value) => Math.min(minimum, value), Infinity);
    const max = values.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
    for (const [index, [modelKey, entry]] of models.entries()) {
      const value = values[index]!;
      const score = roundBenchmarkScore(max === min ? 50 : 100 * (
        quality.direction === "higher" ? (value - min) / (max - min) : (max - value) / (max - min)
      ));
      requireBenchmarkScore(entry.normalized.sourceScores[sourceId]!, score, `${modelKey}/${sourceId}`);
      const scores = recomputedScores.get(modelKey) ?? [];
      scores.push(score);
      recomputedScores.set(modelKey, scores);
    }
  }
  for (const [modelKey, entry] of models) {
    const scores = recomputedScores.get(modelKey)!;
    const score = roundBenchmarkScore(scores.reduce((sum, value) => sum + value, 0) / sourceIds.length);
    requireBenchmarkScore(entry.normalized.score, score, modelKey);
  }
  return parsed;
}

function requireBenchmarkKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`Gateway benchmark requires exact complete keys: ${label}`);
  }
}

function roundBenchmarkScore(score: number): number {
  return Math.round(score * 1_000_000) / 1_000_000;
}

function requireBenchmarkScore(stored: number, expected: number, label: string): void {
  const floatingPointSlack = Number.EPSILON * Math.max(1, Math.abs(stored), Math.abs(expected));
  if (Math.abs(stored - expected) > 1e-6 + floatingPointSlack) {
    throw new Error(`Gateway benchmark normalized score differs from recomputed score: ${label}`);
  }
}

const CLAUDE_PROVIDER_NAME = "Claude";

/**
 * Claude Code's model aliases. Each alias stands for its family's latest
 * version, which only the installed CLI knows; the version, wire id, and effort
 * ladder arrive through {@link applyClaudeNativeModels}. Class is the family's
 * lineup position and does not change between versions.
 */
const CLAUDE_NATIVE_FAMILIES = [
  { alias: "fable", name: "Fable", capabilityClass: "flagship", oneMillion: true },
  { alias: "opus", name: "Opus", capabilityClass: "flagship", oneMillion: true },
  { alias: "sonnet", name: "Sonnet", capabilityClass: "standard", oneMillion: false },
  { alias: "haiku", name: "Haiku", capabilityClass: "light", oneMillion: false },
] as const satisfies readonly {
  readonly alias: string;
  readonly name: string;
  readonly capabilityClass: GatewayCapabilityClass;
  readonly oneMillion: boolean;
}[];
const CLAUDE_DEFAULT_ALIAS = "sonnet";
const CLAUDE_ONE_MILLION_CONTEXT_WINDOW = 1_000_000;
/** The ladder assumed until the CLI reports one. Haiku has never taken effort. */
const CLAUDE_UNRESOLVED_EFFORT: Readonly<Record<string, readonly GatewayReasoningEffort[]>> = {
  fable: ["low", "medium", "high", "xhigh", "max"],
  opus: ["low", "medium", "high", "xhigh", "max"],
  sonnet: ["low", "medium", "high", "xhigh", "max"],
};

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

/** 측정값·정규화 정책·제외 근거까지 전체 스냅샷의 변경을 로스터 revision에 반영한다. */
export const GATEWAY_BENCHMARKS_STAMP = `sha256:${createHash("sha256")
  .update(JSON.stringify(benchmarksRegistry))
  .digest("hex")}`;

/** Human-readable provider names as declared by the model registry. */
export const GATEWAY_PROVIDER_NAMES: Readonly<Record<GatewayProvider, string>> = Object.freeze({
  ...Object.fromEntries(
    REGISTRY_PROVIDERS.map((provider) => [provider, registry.providers[provider].name]),
  ) as Record<RegistryProvider, string>,
  claude: CLAUDE_PROVIDER_NAME,
});

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
  const claude = CLAUDE_NATIVE_FAMILIES.flatMap((family) => {
    const resolution = claudeNativeResolutions.get(family.alias);
    const levels = resolution ? resolution.effortLevels : CLAUDE_UNRESOLVED_EFFORT[family.alias] ?? [];
    const base = {
      displayName: `${CLAUDE_PROVIDER_NAME}-${resolution?.displayName ?? family.name}`,
      provider: "claude" as const,
      ...(resolution ? { upstreamId: resolution.model } : {}),
      capabilityClass: family.capabilityClass,
      effort: levels.length > 0
        ? Object.freeze({ supported: true as const, levels: Object.freeze([...levels]) })
        : UNSUPPORTED_GATEWAY_MODEL_EFFORT,
      claudeAlias: family.alias,
    };
    const entries: GatewayModel[] = [Object.freeze({
      ...base,
      id: scopedModelId("claude", family.alias),
      aliases: Object.freeze([family.alias]),
    })];
    if (family.oneMillion) {
      entries.push(Object.freeze({
        ...base,
        id: scopedModelId("claude", `${family.alias}-1m`),
        contextWindow: CLAUDE_ONE_MILLION_CONTEXT_WINDOW,
        aliases: Object.freeze([`${family.alias}[1m]`]),
      }));
    }
    return entries;
  });
  return Object.freeze([...STATIC_GATEWAY_MODELS, ...claude]);
}

/**
 * Pick each alias's latest version from the installed CLI's model picker.
 *
 * An alias row is authoritative: it is exactly what the CLI launches for that
 * alias. A family the picker lists only by explicit ids (Fable today) takes the
 * highest version among them, which is what the CLI's own alias resolves to.
 */
export function resolveClaudeNativeModels(rows: readonly ClaudeNativeModelRow[]): readonly ClaudeNativeResolution[] {
  return CLAUDE_NATIVE_FAMILIES.flatMap((family) => {
    const aliasRow = rows.find((row) => row.value === family.alias && row.resolvedModel);
    const row = aliasRow ?? rows
      .filter((candidate) => candidate.resolvedModel && claudeFamilyVersion(candidate.resolvedModel, family.alias))
      .sort((left, right) => compareVersions(
        claudeFamilyVersion(right.resolvedModel!, family.alias)!,
        claudeFamilyVersion(left.resolvedModel!, family.alias)!,
      ))[0];
    if (!row?.resolvedModel) return [];
    return [{
      alias: family.alias,
      model: row.resolvedModel,
      displayName: row.displayName,
      effortLevels: row.effortLevels.filter(
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
export const OPENCODE_SUBSCRIPTION_MODELS = providerModels("opencode");

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

export function upstreamModelId(model: GatewayModel): string {
  return model.upstreamId ?? model.id;
}

/**
 * The upstream model a catalog entry actually reaches, as `provider::upstreamId`.
 *
 * Several entries are the same model under different service terms — Codex's
 * `-fast` variants are the priority tier of an identical upstream id — so a fact
 * measured about one holds for its siblings. Entries that merely share a vendor
 * name but reach different upstream transports keep separate identities.
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
    ...(model.capabilityClass ? { capabilityClass: model.capabilityClass } : {}),
    ...(model.benchmark && ladder.includes(model.benchmark.effort) ? { benchmark: model.benchmark } : {}),
  };
}

export function gatewayProviderDefault(provider: GatewayProvider): GatewayModel {
  const defaultModel = provider === "claude" ? CLAUDE_DEFAULT_ALIAS : registry.providers[provider].defaultModel;
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

function resolveGatewayModelBenchmark(
  entry: GatewayModelEntry,
  effort: GatewayModelEffort,
  benchmarks: GatewayBenchmarksRegistry = benchmarksRegistry,
): GatewayModelBenchmark | undefined {
  if (!entry.benchmarkKey || !Object.hasOwn(benchmarks.models, entry.benchmarkKey)) return undefined;
  const benchEntry = benchmarks.models[entry.benchmarkKey]!;
  if (!effort.supported || !effort.levels.includes(benchEntry.effort)) return undefined;

  return Object.freeze({
    method: benchmarks.normalization.method,
    cohortSize: Object.keys(benchmarks.models).length,
    effort: benchEntry.effort,
    score: benchEntry.normalized.score,
    sourceScores: Object.freeze({ ...benchEntry.normalized.sourceScores }),
    sources: Object.freeze(Object.values(benchmarks.sources).map((source) => `${source.name} ${source.benchVersion}`)),
    observedAt: benchmarks.updatedAt,
    routingTieBandPoints: benchmarks.normalization.tieBandPoints,
    caveat: "A relative index within a cohort sharing the same source set, not absolute accuracy. Applies only to the measured effort and does not establish serving success.",
  });
}

function toGatewayModel(
  provider: RegistryProvider,
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
  for (const provider of REGISTRY_PROVIDERS) {
    for (const model of value.providers[provider].models) {
      validateBenchmarkJoin(provider, model, benchmarks);
      if (model.benchmarkKey) referencedBenchmarkKeys.add(model.benchmarkKey);
    }
  }
  for (const key of Object.keys(benchmarks.models)) {
    if (!referencedBenchmarkKeys.has(key)) {
      throw new Error(`Gateway benchmark entry is orphaned: ${key}`);
    }
  }
}

function validateBenchmarkJoin(
  provider: RegistryProvider,
  model: GatewayModelEntry,
  benchmarks: GatewayBenchmarksRegistry,
): void {
  if (!model.benchmarkKey) return;
  if (!Object.hasOwn(benchmarks.models, model.benchmarkKey)) {
    throw new Error(`Gateway benchmark key is unknown: ${provider}/${model.modelId} -> ${model.benchmarkKey}`);
  }
  if (model.providerModelId === "default") {
    throw new Error(`Gateway routing alias cannot carry a benchmark key: ${provider}/${model.modelId}`);
  }
  if (!resolveGatewayModelBenchmark(model, freezeGatewayModelEffort(model.effort), benchmarks)) {
    throw new Error(`Gateway benchmark effort is not reachable: ${provider}/${model.modelId}`);
  }
}

function validateRegistry(value: GatewayModelsRegistry): void {
  for (const provider of REGISTRY_PROVIDERS) {
    for (const model of value.providers[provider].models) {
      validateBenchmarkJoin(provider, model, benchmarksRegistry);
    }
  }
  const lookupIds = new Set<string>();
  for (const family of CLAUDE_NATIVE_FAMILIES) {
    registerLookupId(lookupIds, family.alias, `claude/${family.alias}`);
    if (family.oneMillion) registerLookupId(lookupIds, `${family.alias}[1m]`, `claude/${family.alias}-1m`);
  }
  for (const provider of REGISTRY_PROVIDERS) {
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
      // base's wire id, or `variantOf` when the variant has its own wire id.
      const catalogEntry = (modelId: string | undefined) => (
        modelId === undefined ? undefined : definition.models.find((candidate) => candidate.modelId === modelId)
      );
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
        // `providerModelId` may name an upstream not listed here; an explicit
        // `variantOf` must resolve. A listed base must not itself be a sibling.
        if (model.variantOf && !base) {
          throw new Error(`Gateway service-tier sibling names an unknown base: ${provider}/${model.modelId} -> ${model.variantOf}`);
        }
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
      // OpenCode Go는 모델마다 와이어를 고른다. xAI Grok CLI와 Muse Code 구독은 Responses 고정이지만
      // 라우팅이 Anthropic으로 떨어지지 않도록 명시한다.
      if (model.wire && provider !== "opencode" && provider !== "xai" && provider !== "muse-code") {
        throw new Error(`Gateway model wire is not supported by provider: ${provider}/${model.modelId}`);
      }
      if (model.effort?.supported) {
        if (new Set(model.effort.levels).size !== model.effort.levels.length) {
          throw new Error(`Gateway effort levels contain duplicates: ${provider}/${model.modelId}`);
        }
        const exactModelIds = model.effort.upstreamModelIds;
        if (exactModelIds) {
          // Antigravity spells some effort rungs in the upstream model id. Other
          // providers carry effort in a request field instead.
          if (provider !== "antigravity") {
            throw new Error(`Gateway effort model id overrides are only supported by Antigravity: ${provider}/${model.modelId}`);
          }
          for (const effort of Object.keys(exactModelIds) as GatewayReasoningEffort[]) {
            if (!model.effort.levels.includes(effort)) {
              throw new Error(`Gateway effort model id override is not an advertised level: ${provider}/${model.modelId}/${effort}`);
            }
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
    // once the gateway forwards Anthropic image blocks to Codex.
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
