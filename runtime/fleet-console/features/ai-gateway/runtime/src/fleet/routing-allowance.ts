/**
 * routing-allowance — 코드 규칙 후보 선별·정렬과 배정이 허용량을 읽는 자리.
 *
 * `critical` 공급자는 후보에서 제외하고, 측정된 후보(`ok`, `elevated`)는 여유 순으로 정렬하며,
 * 쿼터 미상(`unknown`)은 측정된 후보 뒤에 원래 순서대로(미상끼리 무순위) 둔다.
 */

import { isProviderCatalogVisible } from "../model-family.js";
import { buildGatewayModelConstraints, type GatewayModel, type GatewayModelConstraints } from "../models.js";
import { deriveQuotaWindowRisk, type QuotaWindowPressure } from "../quota/pressure.js";
import type { GatewayProviderQuota, GatewayQuotaSnapshot } from "./quota-snapshot.js";
import { bindingQuotaWindows } from "./routing-quota.js";

/** 압박이 센 순서. 한 모델을 여러 창이 묶으면 가장 restrictive한 평결이 이긴다. */
const SEVERITY: Readonly<Record<QuotaWindowPressure, number>> = { ok: 0, elevated: 1, critical: 2 };

/** 후보 응답과 코드 규칙 정렬이 노출하는 압박 상태(`critical`은 제외). */
export type GatewayCandidatePressure = "ok" | "elevated" | "unknown";

const CANDIDATE_PRESSURE_ORDER: Readonly<Record<GatewayCandidatePressure, number>> = {
  ok: 0,
  elevated: 1,
  unknown: 2,
};

export interface GatewayModelAllowance {
  readonly pressure: QuotaWindowPressure | "unknown";
  readonly remainingPercent?: number;
  readonly sustainableHeadroom?: number;
  /** 병목 제한이 처음으로 회복되는 리셋까지 남은 초. 원시 창 없이 남은 시간만 싣는다. */
  readonly resetsInSeconds?: number;
}

export interface EvaluatedGatewayCandidateModel {
  readonly model: GatewayModel;
  readonly constraints: GatewayModelConstraints;
  readonly allowance: GatewayModelAllowance & { readonly pressure: GatewayCandidatePressure };
}

function round(value: number): number {
  return Number(value.toPrecision(6));
}

/**
 * 한 모델의 쿼터 압박·지속 가능 여유·리셋까지 남은 시간을 계산한다.
 *
 * 읽지 못한 허용량은 `ok`로도 `critical`로도 보지 않고 `unknown`으로 구분한다.
 */
export function evaluateModelAllowance(
  quota: GatewayProviderQuota | undefined,
  constraints: Pick<GatewayModelConstraints, "quotaScope"> | undefined,
  now = Date.now(),
): GatewayModelAllowance {
  if (!quota) return { pressure: "unknown" };
  if (quota.status !== undefined && quota.status !== "ok" && quota.status !== "stale") {
    return { pressure: "unknown" };
  }
  const fetchedAt = quota.fetchedAt;
  if (fetchedAt !== undefined && (!Number.isFinite(fetchedAt) || fetchedAt < 0 || fetchedAt > now)) {
    return { pressure: "unknown" };
  }
  const scope = constraints?.quotaScope;
  const binding = bindingQuotaWindows(quota, scope);
  if (binding.length === 0) return { pressure: "unknown" };
  if (scope !== undefined && !binding.some((window) => window.scope === scope)) {
    return { pressure: "unknown" };
  }
  const at = typeof fetchedAt === "number" && Number.isFinite(fetchedAt) ? fetchedAt : now;

  let worst: QuotaWindowPressure | undefined;
  const facts: Array<{
    readonly remaining: number;
    readonly reset?: number;
    readonly headroom?: number;
  }> = [];

  for (const window of binding) {
    if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) {
      return { pressure: "unknown" };
    }
    const duration = window.period?.durationMs;
    const validDuration = typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : undefined;
    const rawReset = window.resetsAt ?? (
      window.period?.startsAt !== undefined && validDuration !== undefined
        ? window.period.startsAt + validDuration
        : undefined
    );
    const reset = typeof rawReset === "number" && Number.isFinite(rawReset) ? rawReset : undefined;
    if (reset !== undefined && reset <= now) {
      return { pressure: "unknown" };
    }
    const { pressure } = deriveQuotaWindowRisk(window, at);
    if (worst === undefined || SEVERITY[pressure] > SEVERITY[worst]) worst = pressure;
    const remaining = Math.max(0, 1 - Math.min(100, window.usedPercent) / 100);
    const validClock = reset !== undefined && validDuration !== undefined && reset > at && reset - at <= validDuration;
    const clocklessUnused = window.usedPercent === 0 && reset === undefined && validDuration === undefined;
    const headroom = validClock
      ? remaining / ((reset - at) / validDuration)
      : clocklessUnused
        ? remaining
        : undefined;
    facts.push({
      remaining,
      ...(reset === undefined ? {} : { reset }),
      ...(headroom === undefined ? {} : { headroom }),
    });
  }

  if (worst === undefined) return { pressure: "unknown" };
  const remaining = Math.min(...facts.map((fact) => fact.remaining));
  const remainingPercent = round(remaining * 100);
  const completeHeadroom = facts.every((fact) => fact.headroom !== undefined);
  const sustainableHeadroom = completeHeadroom
    ? round(Math.min(Math.min(...facts.map((fact) => fact.headroom!)), 100))
    : undefined;

  let resetsInSeconds: number | undefined;
  const futureResets = [...new Set(facts.flatMap((fact) => (fact.reset !== undefined && fact.reset > now ? [fact.reset] : [])))].sort(
    (left, right) => left - right,
  );
  for (const reset of futureResets) {
    const after = Math.min(...facts.map((fact) => (fact.reset !== undefined && fact.reset <= reset ? 1 : fact.remaining)));
    if (after > remaining) {
      resetsInSeconds = Math.max(1, Math.ceil((reset - now) / 1_000));
      break;
    }
  }
  if (resetsInSeconds === undefined && futureResets.length > 0) {
    resetsInSeconds = Math.max(1, Math.ceil((futureResets[0]! - now) / 1_000));
  }

  return {
    pressure: worst,
    remainingPercent,
    ...(sustainableHeadroom === undefined ? {} : { sustainableHeadroom }),
    ...(resetsInSeconds === undefined ? {} : { resetsInSeconds }),
  };
}

/**
 * 두 후보의 여유 순위를 비교한다(음수면 left가 더 여유 있음).
 *
 * - 측정된 후보(`ok`, `elevated`)가 `unknown`보다 앞선다.
 * - `ok`가 `elevated`보다 앞선다.
 * - 같은 압박 등급 안에서는 지속 가능 여유(`sustainableHeadroom`)가 1순위(큰 값이 앞)이고,
 *   `sustainableHeadroom`이 없을 때만 `remainingPercent`로 비교한다.
 * - `unknown`끼리는 순위를 매기지 않는다(`0`).
 */
export function compareModelAllowance(
  left: GatewayModelAllowance,
  right: GatewayModelAllowance,
): number {
  const leftRank = left.pressure === "critical" ? 3 : CANDIDATE_PRESSURE_ORDER[left.pressure];
  const rightRank = right.pressure === "critical" ? 3 : CANDIDATE_PRESSURE_ORDER[right.pressure];
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.pressure === "unknown" || right.pressure === "unknown") return 0;
  if (left.sustainableHeadroom !== undefined && right.sustainableHeadroom !== undefined) {
    if (left.sustainableHeadroom !== right.sustainableHeadroom) {
      return right.sustainableHeadroom - left.sustainableHeadroom;
    }
    return (right.remainingPercent ?? -1) - (left.remainingPercent ?? -1);
  }
  if (left.sustainableHeadroom !== undefined) return -1;
  if (right.sustainableHeadroom !== undefined) return 1;
  const leftRemaining = left.remainingPercent ?? -1;
  const rightRemaining = right.remainingPercent ?? -1;
  if (leftRemaining !== rightRemaining) return rightRemaining - leftRemaining;
  return 0;
}

/**
 * 노출된 모델에서 숨긴 공급자와 `critical` 모델을 제외하고,
 * `ok`·`elevated`는 여유 순, `unknown`은 그 뒤 원래 순서(무순위)로 돌려준다.
 * 후보가 비어도 숨긴 공급자나 `critical` 공급자로 폴백하지 않는다.
 */
export function evaluateGatewayCandidateModels(
  exposure: {
    readonly delegationModels: readonly GatewayModel[];
    readonly quota?: GatewayQuotaSnapshot;
  },
  now = Date.now(),
): readonly EvaluatedGatewayCandidateModel[] {
  return exposure.delegationModels
    .filter((model) => isProviderCatalogVisible(exposure.quota?.[model.provider]?.status, model.provider))
    .map((model, index) => {
      const constraints = buildGatewayModelConstraints(model);
      const allowance = evaluateModelAllowance(exposure.quota?.[model.provider], constraints, now);
      return { model, constraints, allowance, index };
    })
    .filter(
      (entry): entry is typeof entry & { readonly allowance: GatewayModelAllowance & { readonly pressure: GatewayCandidatePressure } } =>
        entry.allowance.pressure !== "critical",
    )
    .sort((left, right) => compareModelAllowance(left.allowance, right.allowance) || (left.index - right.index))
    .map(({ model, constraints, allowance }) => ({ model, constraints, allowance }));
}

export function modelPressure(
  quota: GatewayProviderQuota | undefined,
  constraints: Pick<GatewayModelConstraints, "quotaScope"> | undefined,
  now = Date.now(),
): QuotaWindowPressure | undefined {
  const allowance = evaluateModelAllowance(quota, constraints, now);
  return allowance.pressure === "unknown" ? undefined : allowance.pressure;
}

/** 이 공급자의 허용량을 아예 읽지 못했는가. `signed_out`도 여기에 들어온다. */
export function allowanceUnreadable(snapshot: GatewayQuotaSnapshot | undefined, provider: string): boolean {
  const quota = snapshot?.[provider];
  if (!quota) return true;
  return evaluateModelAllowance(quota, undefined).pressure === "unknown";
}
