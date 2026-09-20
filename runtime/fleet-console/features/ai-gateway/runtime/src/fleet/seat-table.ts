/**
 * seat-table — 역할 하나에 정체성 하나를 코드로 못박는 표.
 *
 * 로스터를 읽고 좌석을 고르는 일은 지금까지 호스트 모델의 몫이었다. 정책은 산문으로
 * 적혀 있었고(`assets/ai-gateway/seat-assignment.md`), 지키는지 확인할 방법은 없었다.
 * 이 모듈은 그 산문의 결정 가능한 부분만 가져와 순수 함수로 옮긴다 — 같은 로스터는 항상
 * 같은 표를 내고, 표는 기록에 남으며, 틀렸다면 규칙을 고칠 수 있다.
 *
 * 남는 판단은 하나다: 어떤 작업이 어떤 **역할**인가. 그건 호스트가 계속 정한다.
 * 이 표가 보장하는 것은 "역할 → 정체성"이지 "작업 → 역할"이 아니다.
 */

import type { GatewayModel, GatewayProvider } from "../models.js";
import type { GatewayEffortExposure } from "./gateway-agents.js";
import {
  buildGatewayLoadout,
  type GatewayLoadout,
  type GatewayLoadoutModel,
  type GatewayLoadoutProvider,
  type GatewayLoadoutQuotaWindow,
  type GatewayQuotaSnapshot,
} from "./model-loadout.js";

/** 이 표가 좌석을 주는 역할들. 호스트는 `fleet:<role>`로 부른다. */
export const FLEET_SEAT_ROLES = [
  "recon",
  "scan",
  "review",
  "verify",
  "judge",
  "propose",
  "implement",
] as const;

export type FleetSeatRole = (typeof FLEET_SEAT_ROLES)[number];

/**
 * 좌석의 성격. 판단석은 품질 밴드로 채우고, 기계석은 allowance로 분산한다.
 * 둘은 맞바꾸지 않는다 — 판단석에서 잃은 품질은 하류에서 회복되지 않고,
 * 기계석의 분산은 넓을수록 이득이다.
 */
const REGIME: Readonly<Record<FleetSeatRole, "judgment" | "mechanical">> = {
  recon: "mechanical",
  scan: "mechanical",
  verify: "mechanical",
  implement: "mechanical",
  review: "judgment",
  judge: "judgment",
  propose: "judgment",
};

/** 역할이 바라는 추론 강도. 모델 사다리에 없으면 아래 단으로 클램프한다. */
const WANTED_EFFORT: Readonly<Record<FleetSeatRole, string>> = {
  scan: "low",
  recon: "medium",
  verify: "medium",
  implement: "medium",
  review: "high",
  judge: "high",
  propose: "high",
};

/** 이름 없는 디스패치가 앉는 좌석. 상속을 막는 자리다. */
const INHERITED_SEAT: FleetSeatRole = "recon";

/** 품질 증거가 없을 때 쓰는 공급자 라인업 주장. 점수가 아니라 사전 순위다. */
const CLASS_PRIOR: Readonly<Record<string, number>> = { flagship: 2, standard: 1, light: 0 };

const LADDER_ORDER = ["low", "medium", "high", "xhigh"] as const;

export interface FleetSeat {
  readonly role: string;
  readonly agentType: string;
  readonly label: string;
  readonly modelId: string;
  readonly because: string;
}

export interface FleetSeatTable {
  readonly revision: string;
  readonly seats: Readonly<Record<string, FleetSeat>>;
  readonly inherited?: string;
}

/** 한 모델과 그 모델이 쓰는 공급자·allowance를 한자리에 둔 후보. */
interface Candidate {
  readonly provider: string;
  readonly model: GatewayLoadoutModel;
  /** 이 모델을 묶는 창들 중 가장 나쁜 판정. 읽지 못하면 undefined. */
  readonly pressure?: string;
  /** 사용자 소비 순서. 없으면 undefined. */
  readonly rank?: number;
  /** 품질 순위 키: benchmark가 있으면 그 점수, 없으면 class prior. */
  readonly quality: number;
  readonly measured: boolean;
  readonly tieBand: number;
}

/**
 * 로스터에서 좌석표를 만든다. 노출된 모델이 없으면 좌석 없는 표를 낸다 —
 * 그 표를 받은 Mod는 아무것도 재배정하지 않고 관측만 한다.
 */
export function buildFleetSeatTable(loadout: GatewayLoadout): FleetSeatTable {
  const candidates = collectCandidates(loadout);
  if (candidates.length === 0) return { revision: loadout.revision, seats: {} };

  // 호스트 세션은 Claude 계열로 돈다. 위임이 사는 이유의 절반은 그 계열 밖의 시선이므로,
  // 같은 계열 모델은 좌석 경쟁에서 내린다 — 배제가 아니라 강등이다. 계열 밖 후보가 하나도
  // 없으면 좌석을 비우는 대신 같은 계열을 앉히고, 그 사실을 좌석 사유에 적는다.
  const independent = candidates.filter((candidate) => candidate.model.constraints.homolineage !== true);
  const pool = independent.length > 0 ? independent : candidates;

  const seats: Record<string, FleetSeat> = {};
  const judgmentPool = topQualityBand(pool);
  const mechanicalPool = spendOrder(pool);

  let mechanicalTurn = 0;
  for (const role of FLEET_SEAT_ROLES) {
    if (REGIME[role] === "judgment") {
      const pick = judgmentPool[0];
      if (pick) seats[role] = toSeat(role, pick, judgmentReason(pick));
      continue;
    }
    // 기계석은 공급자 단위로 돈다. 한 공급자가 모델 둘을 노출해도 몫은 하나다.
    const pick = mechanicalPool[mechanicalTurn % mechanicalPool.length];
    mechanicalTurn += 1;
    if (pick) seats[role] = toSeat(role, pick, mechanicalReason(pick));
  }

  return {
    revision: loadout.revision,
    seats,
    ...(seats[INHERITED_SEAT] ? { inherited: INHERITED_SEAT } : {}),
  };
}

function collectCandidates(loadout: GatewayLoadout): Candidate[] {
  const ranks = new Map<string, number>(
    (loadout.quotaConsumptionPriority?.providers ?? []).map((entry) => [entry.provider as string, entry.rank]),
  );
  const candidates: Candidate[] = [];
  for (const [provider, entry] of Object.entries(loadout.providers)) {
    for (const model of entry.models) {
      const rank = ranks.get(provider);
      const pressure = bindingPressure(entry, model);
      // critical은 보낼 곳이 없을 때의 마지막 수단이다. 사용자가 순서를 정해 둔
      // 공급자는 예외 — 그 설정이 예측을 이긴다고 로스터 스스로 말한다.
      if (pressure === "critical" && rank === undefined) continue;
      candidates.push({
        provider,
        model,
        ...(pressure === undefined ? {} : { pressure }),
        ...(rank === undefined ? {} : { rank }),
        quality: qualityOf(model),
        measured: model.constraints.benchmark !== undefined,
        tieBand: model.constraints.benchmark?.routingTieBandPoints ?? 0,
      });
    }
  }
  return candidates;
}

/**
 * 이 모델을 묶는 창의 판정. `quotaScope`가 풀을 지명하면 그 창이, 아니면 합산이 아닌
 * 모든 창이 동시에 묶으므로 그중 가장 나쁜 판정이 지배한다.
 */
function bindingPressure(entry: GatewayLoadoutProvider, model: GatewayLoadoutModel): string | undefined {
  const quota = entry.quota;
  if (!("windows" in quota) || quota.windows === undefined) return undefined;
  const scope = model.constraints.quotaScope;
  const binding = scope === undefined
    ? quota.windows.filter((window) => window.isAggregate !== true)
    : quota.windows.filter((window) => window.scope === scope);
  return worstPressure(binding);
}

const PRESSURE_ORDER: Readonly<Record<string, number>> = { ok: 0, elevated: 1, critical: 2 };

function worstPressure(windows: readonly GatewayLoadoutQuotaWindow[]): string | undefined {
  let worst: string | undefined;
  for (const window of windows) {
    const pressure = window.pressure;
    if (pressure === undefined) continue;
    if (worst === undefined || (PRESSURE_ORDER[pressure] ?? 0) > (PRESSURE_ORDER[worst] ?? 0)) worst = pressure;
  }
  return worst;
}

/**
 * 품질 순위 키. benchmark가 있으면 그 점수를, 없으면 capabilityClass 사전 순위를 쓴다.
 * 둘은 같은 척도가 아니므로 측정된 모델이 항상 앞선다 — 측정되지 않은 모델을 0점으로
 * 취급하지 않기 위한 분리다.
 */
function qualityOf(model: GatewayLoadoutModel): number {
  const benchmark = model.constraints.benchmark;
  if (benchmark) return benchmark.score;
  return CLASS_PRIOR[model.constraints.capabilityClass ?? ""] ?? 0;
}

/**
 * 판단석 후보를 품질 순으로 세운 뒤 최상위 밴드만 남긴다. 밴드 안의 동률은
 * 사용자의 소비 순서가 가른다 — 품질 밴드 안에서만 적용한다고 로스터가 말한다.
 */
function topQualityBand(candidates: readonly Candidate[]): Candidate[] {
  const measured = candidates.filter((candidate) => candidate.measured);
  const pool = measured.length > 0 ? measured : [...candidates];
  const sorted = [...pool].sort((left, right) => right.quality - left.quality);
  const best = sorted[0];
  if (best === undefined) return [];
  const band = best.tieBand;
  const within = sorted.filter((candidate) => best.quality - candidate.quality <= band);
  return within.sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER));
}

/**
 * 기계석 분산 순서: 공급자 하나당 한 자리씩, 사용자 소비 순서대로. 순위 없는 공급자는
 * 그 뒤에 안정적으로 붙는다.
 */
function spendOrder(candidates: readonly Candidate[]): Candidate[] {
  const byProvider = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const held = byProvider.get(candidate.provider);
    // 한 공급자가 여럿을 노출하면 그중 품질이 앞서는 하나가 그 공급자의 몫을 받는다.
    if (held === undefined || candidate.quality > held.quality) byProvider.set(candidate.provider, candidate);
  }
  return [...byProvider.values()].sort((left, right) => {
    const leftRank = left.rank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = right.rank ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.provider.localeCompare(right.provider);
  });
}

function toSeat(role: FleetSeatRole, candidate: Candidate, because: string): FleetSeat {
  const rung = clampEffort(candidate.model, WANTED_EFFORT[role]);
  const agentType = candidate.model.agentTypes[rung];
  const scoped = candidate.model.modelId.startsWith("claude-gateway--")
    ? candidate.model.modelId.slice("claude-gateway--".length)
    : candidate.model.modelId;
  const label = scoped.replace("--", "/");
  return {
    role,
    agentType: agentType ?? "",
    label: rung === "none" ? label : `${label} @${rung}`,
    modelId: candidate.model.modelId,
    because,
  };
}

/**
 * 역할이 바라는 단을 모델 사다리에 맞춘다. 사다리에 없는 단을 요청하면 상류가 말없이
 * 클램프하므로, 여기서 사다리가 실제로 가진 단으로만 고른다.
 */
function clampEffort(model: GatewayLoadoutModel, wanted: string): string {
  const ladder = model.constraints.effortLadder;
  if (!model.constraints.effortSupported || ladder.length === 0) return "none";
  if (ladder.includes(wanted as never)) return wanted;
  const wantedIndex = LADDER_ORDER.indexOf(wanted as never);
  for (let index = wantedIndex - 1; index >= 0; index -= 1) {
    const rung = LADDER_ORDER[index] as string;
    if (ladder.includes(rung as never)) return rung;
  }
  return ladder[0] as string;
}

function judgmentReason(candidate: Candidate): string {
  const basis = candidate.measured
    ? `top measured band (${candidate.quality.toFixed(1)})`
    : `${candidate.model.constraints.capabilityClass ?? "unmeasured"} class, no benchmark`;
  return candidate.model.constraints.homolineage === true ? `${basis}, host lineage — none other reachable` : basis;
}

function mechanicalReason(candidate: Candidate): string {
  const spend = candidate.rank === undefined ? "unranked provider" : `spend rank ${candidate.rank}`;
  const base = candidate.pressure === undefined || candidate.pressure === "ok"
    ? spend
    : `${spend}, allowance ${candidate.pressure}`;
  return candidate.model.constraints.homolineage === true ? `${base}, host lineage — none other reachable` : base;
}

export interface FleetSeatsInput {
  readonly exposed: readonly GatewayModel[];
  readonly effortExposure?: GatewayEffortExposure;
  readonly providerPriority?: readonly GatewayProvider[];
  /**
   * 있으면 allowance 판정까지 좌석에 반영한다. 런치 시점에는 보통 없는데, 그때의 좌석은
   * 카탈로그와 사용자 소비 순서만으로 정해진다 — 결정론은 그대로고, 압박이 심한 공급자를
   * 피하는 축만 빠진다.
   */
  readonly quota?: GatewayQuotaSnapshot;
}

/**
 * 런치가 플러그인 스냅숏에 심을 좌석표 JSON. 노출이 비면 좌석 없는 표를 낸다 —
 * 그 표를 받은 Mod는 재배정 없이 디스패치를 기록만 한다.
 */
export function buildFleetSeatsJson(input: FleetSeatsInput): string {
  const loadout = buildGatewayLoadout({
    exposed: input.exposed,
    ...(input.effortExposure ? { effortExposure: input.effortExposure } : {}),
    ...(input.providerPriority ? { providerPriority: input.providerPriority } : {}),
    ...(input.quota ? { quota: input.quota } : {}),
  });
  return JSON.stringify(buildFleetSeatTable(loadout));
}
