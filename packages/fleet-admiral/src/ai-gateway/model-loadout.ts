/**
 * ai-gateway/model-loadout — the roster a host reads before assigning models to
 * workflow stages.
 *
 * Two layers meet here and stay distinguishable: catalog constraints (facts a
 * provider states, its capability class included) and provider quota (a
 * reading taken at a moment). The host combines them; this module never decides
 * for it, because a roster that answered "use this one" would be followed
 * without the check that makes the choice defensible.
 */

import {
  GATEWAY_BENCHMARKS_STAMP,
  GATEWAY_MODELS_UPDATED_AT,
  buildGatewayModelConstraints,
  deriveQuotaWindowRisk,
  toClaudeGatewayModelId,
  type GatewayModel,
  type GatewayModelConstraints,
  type GatewayProvider,
  type QuotaWindowPressure,
  type QuotaWindowRisk,
} from "@dotobokuri/core-ai-gateway";
import { createHash } from "node:crypto";

import {
  exposedEffortLadder,
  toGatewayAgentSelector,
  type GatewayEffortExposure,
} from "../agent-cli/gateway-agents.js";

/** A provider allowance reading, shaped by the host that took it. */
export interface GatewayQuotaWindow {
  readonly id: string;
  /** Sub-pool this window measures; absent when it covers the whole allowance. */
  readonly scope?: string;
  /** Human-readable subject of the window, e.g. the model a scoped limit binds. */
  readonly label?: string;
  readonly usedPercent: number;
  readonly resetsAt?: number;
  /**
   * The window's time boundary, with the provenance of each figure. Without a
   * length, `usedPercent` values from windows that reset on different clocks
   * (5h vs weekly vs monthly) are incomparable.
   */
  readonly period?: {
    readonly durationMs: number;
    /** `upstream` = provider-stated; `catalog` = Fleet product knowledge. */
    readonly durationBasis: string;
    readonly startsAt?: number;
    /** `upstream` = provider-stated; `derived` = reset minus duration. */
    readonly startsAtBasis?: string;
  };
  /** The window sums sibling scoped pools; exclude it from headroom math. */
  readonly isAggregate?: boolean;
  /** Absolute usage in plain counts, as decimal strings. Never money. */
  readonly amounts?: { readonly used: string; readonly limit: string };
}

export type GatewayWindowPressure = QuotaWindowPressure;

/**
 * A quota window as the loadout reports it: the reading's facts plus the
 * derived judgements the server can make honestly. The consumer of this
 * roster is a language model, and every derivation it is asked to perform
 * itself — epoch arithmetic, pace normalization — is a place it can go wrong,
 * so whatever the server can compute, it does.
 *
 * The judgements are spread flat here rather than nested under `risk` as the
 * quota DTO carries them: this roster is read as prose by a model, and one
 * level of nesting is one more hop between a window and its verdict.
 */
export interface GatewayLoadoutQuotaWindow extends GatewayQuotaWindow, QuotaWindowRisk {}

export interface GatewayProviderQuota {
  readonly status: string;
  readonly windows?: readonly GatewayQuotaWindow[];
  readonly fetchedAt?: number;
}

export interface GatewayLoadoutProviderQuota {
  readonly status: string;
  readonly windows?: readonly GatewayLoadoutQuotaWindow[];
  readonly fetchedAt?: number;
}

/**
 * Quota keyed by provider id. `claude` is meaningful here even though it serves
 * no gateway model: it is the allowance an inherited (unpinned) stage spends,
 * and therefore the baseline any offload is measured against.
 */
export type GatewayQuotaSnapshot = Readonly<Record<string, GatewayProviderQuota>>;

/**
 * The registered names this identity answers to, keyed by the reasoning level
 * each one carries. A model with an effort ladder registers one name per rung,
 * so the key set is exactly `constraints.effortLadder`; a model without effort
 * control registers a single name under `none`.
 */
export type GatewayAgentTypeSelectors = Readonly<Record<string, string>>;

/**
 * Routing facts minus the provider, which the grouping key already states. The
 * roster carries each model under its provider so a model and the allowance it
 * spends are read together; repeating the provider inside would invite a reader
 * to trust the copy over the group it is sitting in.
 */
export type GatewayLoadoutConstraints = Omit<GatewayModelConstraints, "provider">;

export interface GatewayLoadoutModel {
  /**
   * Names that select this identity, one per reasoning level it advertises.
   * Selecting by name carries the level with it, so nothing further pins effort;
   * an entry here is reachable only if this session registered it at startup.
   */
  readonly agentTypes: GatewayAgentTypeSelectors;
  /**
   * The model itself, for a field that takes a model as a value rather than by
   * name. It is not a second spelling of `agentTypes` and cannot be derived from
   * one: that transform collapses `.`, `[1m]`, and `--` all into `-`, which no
   * inverse recovers. Reach for it when no registered name exists — a model
   * exposed mid-session has none — and to match a running session's own model
   * back to this roster.
   */
  readonly modelId: string;
  readonly constraints: GatewayLoadoutConstraints;
}

export interface GatewayLoadoutProvider {
  /**
   * `unsupported` means Fleet has no way to read this provider's allowance —
   * never that the allowance is healthy.
   */
  readonly quota: GatewayLoadoutProviderQuota | { readonly status: "unsupported" };
  /**
   * The exposed models this provider serves. Empty means it serves none of them,
   * which for `claude` is its permanent state: it is listed because an unpinned
   * run spends that allowance, making it the baseline an offload is measured
   * against, not because its models were all turned off.
   */
  readonly models: readonly GatewayLoadoutModel[];
}

export interface GatewayLoadout {
  /**
   * Changes when the exposed set or the catalog changes. A host that pinned
   * models under one revision can tell its roster went out of date.
   */
  readonly revision: string;
  readonly catalogUpdatedAt: string;
  /**
   * The user's opt-in ordered spend preference across providers; it weights the
   * allowance axis only and never overrides quality evidence; absent when the
   * user set none.
   */
  readonly providerPriority?: readonly GatewayProvider[];
  /**
   * Keyed by provider id. Each model sits under the allowance it spends, so the
   * window to read against a model is the one in the same entry — no join.
   * `constraints.quotaScope`, where a provider splits into pools, still selects
   * which of that entry's windows applies.
   */
  readonly providers: Readonly<Record<string, GatewayLoadoutProvider>>;
}

export interface BuildGatewayLoadoutInput {
  /** Exactly the models the user exposed. Never the whole catalog. */
  readonly exposed: readonly GatewayModel[];
  /** Per-model reasoning rungs the user exposed. Absent entry = that model's whole ladder. */
  readonly effortExposure?: GatewayEffortExposure;
  readonly quota?: GatewayQuotaSnapshot;
  /** The user's opt-in ordered spend preference across providers; weights the allowance axis only. */
  readonly providerPriority?: readonly GatewayProvider[];
  /** Injectable clock for derived quota metrics; defaults to Date.now. */
  readonly now?: () => number;
}

const UNSUPPORTED_QUOTA = Object.freeze({ status: "unsupported" as const });

/** The session's own subscription — what an unpinned stage spends. */
const PARENT_PROVIDER_ID = "claude";

export function buildGatewayLoadout(input: BuildGatewayLoadoutInput): GatewayLoadout {
  const placed = input.exposed.map((model) => ({
    provider: model.provider as string,
    entry: toLoadoutModel(model, input.effortExposure),
  }));
  const providerPriority = input.providerPriority
    ? Object.freeze([...input.providerPriority])
    : undefined;
  return {
    revision: loadoutRevision(placed.map(({ entry }) => entry), providerPriority),
    catalogUpdatedAt: GATEWAY_MODELS_UPDATED_AT,
    providers: buildProviders(placed, input.quota, input.now ?? Date.now),
    ...(providerPriority ? { providerPriority } : {}),
  };
}

function toLoadoutModel(
  model: GatewayModel,
  exposure?: GatewayEffortExposure,
): GatewayLoadoutModel {
  const modelId = toClaudeGatewayModelId(model);
  // provider는 그룹 키가 말한다. 사본을 남기면 둘이 어긋났을 때 어느 쪽이 참인지 모른다.
  const { provider: _provider, ...catalog } = buildGatewayModelConstraints(model);
  // 사다리는 카탈로그가 아니라 이 세션이 정체성으로 등록한 것을 말해야 한다.
  // 등록되지 않은 단계를 사다리에 남기면 호스트가 해석할 수 없는 이름을 고른다.
  const effortLadder = exposedEffortLadder(model.id, catalog.effortLadder, exposure);
  const { benchmark, ...baseConstraints } = catalog;
  const constraints = {
    ...baseConstraints,
    effortLadder,
    ...(benchmark && effortLadder.includes(benchmark.effort) ? { benchmark } : {}),
  };
  return {
    agentTypes: toAgentTypeSelectors(modelId, constraints),
    modelId,
    constraints,
  };
}

/**
 * Derive the selectors from the same transform that registers the agents, so the
 * roster cannot drift from the names a session actually carries. Reachability is
 * still the host's check: registration is frozen at session start while this
 * roster is re-read live, and the two diverge the moment exposure changes.
 */
function toAgentTypeSelectors(
  id: string,
  constraints: GatewayLoadoutConstraints,
): GatewayAgentTypeSelectors {
  if (!constraints.effortSupported) {
    return Object.freeze({ none: toGatewayAgentSelector(id) });
  }
  return Object.freeze(Object.fromEntries(
    constraints.effortLadder.map((effort) => [effort, toGatewayAgentSelector(id, effort)]),
  ));
}

function buildProviders(
  placed: readonly { readonly provider: string; readonly entry: GatewayLoadoutModel }[],
  quota: GatewayQuotaSnapshot | undefined,
  now: () => number,
): Readonly<Record<string, GatewayLoadoutProvider>> {
  // 어느 예산이 상속분인지는 이 로스터가 알 수 없다. 세션의 시작 모델은 런치 시점에
  // 프로세스 환경으로 한 번 정해지고 그 뒤 세션 안에서 바뀔 수 있는데, 도구는 런타임
  // 단위로 한 번 등록되어 모든 세션을 상대하므로 어느 세션이 무엇으로 떴는지 볼 자리가
  // 없다. 설정값을 대신 추적하면 이미 떠 있는 세션과 어긋난 답을 자신 있게 내놓는다.
  // 그래서 여기서는 부모 구독을 포함한 모든 프로바이더의 사용량을 사실대로 늘어놓고,
  // 자기 세션이 무엇으로 도는지 이미 아는 호스트가 그 조인을 맡는다.
  const ids: string[] = [PARENT_PROVIDER_ID];
  for (const { provider } of placed) {
    if (!ids.includes(provider)) ids.push(provider);
  }
  for (const id of Object.keys(quota ?? {})) {
    if (!ids.includes(id)) ids.push(id);
  }
  return Object.freeze(Object.fromEntries(ids.map((id) => [id, {
    quota: enrichProviderQuota(quota?.[id], now) ?? UNSUPPORTED_QUOTA,
    models: Object.freeze(
      placed.filter((candidate) => candidate.provider === id).map(({ entry }) => entry),
    ),
  }])));
}

function enrichProviderQuota(
  quota: GatewayProviderQuota | undefined,
  now: () => number,
): GatewayLoadoutProviderQuota | undefined {
  if (!quota) return undefined;
  const { windows, ...rest } = quota;
  if (!windows || windows.length === 0) return rest;
  // `usedPercent`는 fetchedAt 시점의 관측치다. 요약은 캐시되므로 벽시계로 경과율을
  // 재면 관측과 다른 시각의 분모가 붙어 pace가 스스로 떠내려간다. 관측 시각이 없을
  // 때만 현재 시각으로 폴백한다.
  const at = typeof quota.fetchedAt === "number" && Number.isFinite(quota.fetchedAt) ? quota.fetchedAt : now();
  return { ...rest, windows: windows.map((window) => enrichQuotaWindow(window, at)) };
}

function enrichQuotaWindow(window: GatewayQuotaWindow, at: number): GatewayLoadoutQuotaWindow {
  return { ...window, ...deriveQuotaWindowRisk(window, at) };
}

// Quota is deliberately excluded: it moves on its own and would make every
// reading look like a roster change, hiding the exposure edits that matter.
// The rung set belongs in the material for the mirror reason: narrowing a
// model's exposed levels changes which identities exist, and a revision that
// stayed equal across that edit would report the roster as unchanged.
// providerPriority is included because it is a deliberate Settings edit like
// exposure — a host that pinned a fan under one spend order must see the roster
// changed. Benchmark evidence is part of the catalog, so a bench refresh must
// move the revision even when the model registry itself is unchanged.
function loadoutRevision(
  models: readonly GatewayLoadoutModel[],
  priority?: readonly GatewayProvider[],
): string {
  const material = [
    GATEWAY_MODELS_UPDATED_AT,
    `bench:${GATEWAY_BENCHMARKS_STAMP}`,
    ...models
      .map((model) =>
        `${model.modelId}:${model.constraints.effortLadder.join("+")}`)
      .sort(),
    `priority:${(priority ?? []).join(">")}`,
  ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}
