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
  GATEWAY_MODELS_UPDATED_AT,
  buildGatewayModelConstraints,
  toClaudeGatewayModelId,
  type GatewayModel,
  type GatewayModelConstraints,
} from "@dotobokuri/core-ai-gateway";
import { createHash } from "node:crypto";

import {
  exposedEffortLadder,
  toGatewayAgentName,
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

export type GatewayWindowPressure = "ok" | "elevated" | "critical";

/**
 * A quota window as the loadout reports it: the reading's facts plus the
 * derived judgements the server can make honestly. The consumer of this
 * roster is a language model, and every derivation it is asked to perform
 * itself — epoch arithmetic, pace normalization — is a place it can go wrong,
 * so whatever the server can compute, it does. A derived field is omitted
 * whenever its inputs cannot support it; absence means "could not tell",
 * never "safe".
 */
export interface GatewayLoadoutQuotaWindow extends GatewayQuotaWindow {
  /** Normalized reset-length class; window ids like `cycle` do not name one. */
  readonly cadence?: "session" | "daily" | "weekly" | "monthly";
  /**
   * (used fraction) ÷ (elapsed fraction of the window). Above 1.0 the window
   * is being spent faster than its clock refills it. Omitted while the window
   * is too young for the ratio to mean anything.
   */
  readonly paceRatio?: number;
  /** Linear projection of when the window empties; present only when that lands before the reset. */
  readonly projectedExhaustionAt?: number;
  /** Half the window length: the average lockout bought by draining this pool now. */
  readonly recoveryHalfLifeMs?: number;
  /**
   * The server's verdict on this window's state. It describes the window —
   * never which model to choose; that judgement stays with the host.
   */
  readonly pressure: GatewayWindowPressure;
}

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
  readonly isSessionDefault: boolean;
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
  readonly defaultModel?: GatewayModel;
  readonly quota?: GatewayQuotaSnapshot;
  /** Injectable clock for derived quota metrics; defaults to Date.now. */
  readonly now?: () => number;
}

const UNSUPPORTED_QUOTA = Object.freeze({ status: "unsupported" as const });

/** The session's own subscription — what an unpinned stage spends. */
const PARENT_PROVIDER_ID = "claude";

export function buildGatewayLoadout(input: BuildGatewayLoadoutInput): GatewayLoadout {
  const placed = input.exposed.map((model) => ({
    provider: model.provider as string,
    entry: toLoadoutModel(model, input.defaultModel, input.effortExposure),
  }));
  return {
    revision: loadoutRevision(placed.map(({ entry }) => entry)),
    catalogUpdatedAt: GATEWAY_MODELS_UPDATED_AT,
    providers: buildProviders(placed, input.quota, input.now ?? Date.now),
  };
}

function toLoadoutModel(
  model: GatewayModel,
  defaultModel?: GatewayModel,
  exposure?: GatewayEffortExposure,
): GatewayLoadoutModel {
  const modelId = toClaudeGatewayModelId(model);
  // provider는 그룹 키가 말한다. 사본을 남기면 둘이 어긋났을 때 어느 쪽이 참인지 모른다.
  const { provider: _provider, ...catalog } = buildGatewayModelConstraints(model);
  // 사다리는 카탈로그가 아니라 이 세션이 정체성으로 등록한 것을 말해야 한다.
  // 등록되지 않은 단계를 사다리에 남기면 호스트가 해석할 수 없는 이름을 고른다.
  const effortLadder = exposedEffortLadder(model.id, catalog.effortLadder, exposure);
  const constraints = effortLadder === catalog.effortLadder
    ? catalog
    : { ...catalog, effortLadder };
  return {
    agentTypes: toAgentTypeSelectors(modelId, constraints),
    modelId,
    constraints,
    isSessionDefault: defaultModel !== undefined && defaultModel.id === model.id,
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
    return Object.freeze({ none: toGatewayAgentName(id) });
  }
  return Object.freeze(Object.fromEntries(
    constraints.effortLadder.map((effort) => [effort, toGatewayAgentName(id, effort)]),
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

const MS_PER_HOUR = 3_600_000;
const CADENCE_SESSION_MAX_MS = 20 * MS_PER_HOUR;
const CADENCE_DAILY_MAX_MS = 3 * 24 * MS_PER_HOUR;
const CADENCE_WEEKLY_MAX_MS = 20 * 24 * MS_PER_HOUR;
/** Below this elapsed fraction a pace ratio is noise, so it is omitted rather than clamped. */
const MIN_ELAPSED_FRACTION = 0.05;
const PACE_CRITICAL = 1.5;
const PACE_ELEVATED = 1.1;
const USED_CRITICAL_PERCENT = 95;
const USED_ELEVATED_PERCENT = 80;

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

function windowCadence(durationMs: number): NonNullable<GatewayLoadoutQuotaWindow["cadence"]> {
  if (durationMs <= CADENCE_SESSION_MAX_MS) return "session";
  if (durationMs <= CADENCE_DAILY_MAX_MS) return "daily";
  if (durationMs <= CADENCE_WEEKLY_MAX_MS) return "weekly";
  return "monthly";
}

function windowPressure(usedPercent: number, paceRatio: number | undefined): GatewayWindowPressure {
  if (usedPercent >= USED_CRITICAL_PERCENT || (paceRatio !== undefined && paceRatio >= PACE_CRITICAL)) {
    return "critical";
  }
  if (usedPercent >= USED_ELEVATED_PERCENT || (paceRatio !== undefined && paceRatio >= PACE_ELEVATED)) {
    return "elevated";
  }
  return "ok";
}

function enrichQuotaWindow(window: GatewayQuotaWindow, at: number): GatewayLoadoutQuotaWindow {
  const durationMs = window.period?.durationMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    // 기간 없는 판독은 percent 대역만으로 판정한다. 파생 필드의 부재는 "계산 불가"이지
    // 안전의 표시가 아니다.
    return { ...window, pressure: windowPressure(window.usedPercent, undefined) };
  }
  const startsAt = window.period?.startsAt
    ?? (window.resetsAt !== undefined && window.resetsAt > durationMs ? window.resetsAt - durationMs : undefined);
  // 관측이 회차 종료 이후라면 그 percent는 이미 끝난 회차의 것이다 — pace 계열을 만들지
  // 않는다. resetsAt이 없어도 startsAt+durationMs가 같은 경계를 말한다.
  const resetBoundary = window.resetsAt ?? (startsAt !== undefined ? startsAt + durationMs : undefined);
  const stale = resetBoundary !== undefined && at > resetBoundary;
  let paceRatio: number | undefined;
  let projectedExhaustionAt: number | undefined;
  if (startsAt !== undefined && resetBoundary !== undefined && !stale && at > startsAt) {
    const elapsed = Math.min(1, (at - startsAt) / durationMs);
    if (elapsed >= MIN_ELAPSED_FRACTION) {
      const used = Math.min(1, Math.max(0, window.usedPercent / 100));
      paceRatio = Math.round((used / elapsed) * 100) / 100;
      if (used > 0) {
        // 선형 외삽: 지금까지의 평균 소진율이 유지될 때 100%에 닿는 시각. 리셋보다
        // 엄격히 이를 때만 싣는다 — 부재로 "리셋까지 안전"을 표현한다.
        const exhaustionAt = startsAt + Math.round((at - startsAt) / used);
        if (exhaustionAt < resetBoundary) projectedExhaustionAt = exhaustionAt;
      }
    }
  }
  return {
    ...window,
    cadence: windowCadence(durationMs),
    ...(paceRatio !== undefined ? { paceRatio } : {}),
    ...(projectedExhaustionAt !== undefined ? { projectedExhaustionAt } : {}),
    recoveryHalfLifeMs: Math.round(durationMs / 2),
    pressure: windowPressure(window.usedPercent, paceRatio),
  };
}

// Quota is deliberately excluded: it moves on its own and would make every
// reading look like a roster change, hiding the exposure edits that matter.
// The rung set belongs in the material for the mirror reason: narrowing a
// model's exposed levels changes which identities exist, and a revision that
// stayed equal across that edit would report the roster as unchanged.
function loadoutRevision(models: readonly GatewayLoadoutModel[]): string {
  const material = [
    GATEWAY_MODELS_UPDATED_AT,
    ...models
      .map((model) =>
        `${model.modelId}:${model.isSessionDefault ? "1" : "0"}:${model.constraints.effortLadder.join("+")}`)
      .sort(),
  ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}
