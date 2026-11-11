import { buildGatewayLoadout, buildGatewayEnabledModels, canonicalGatewayCandidateId } from "./model-loadout.js";
import { evaluateGatewayCandidateModels, evaluateModelAllowance } from "./routing-allowance.js";
import { visibleDelegationModels, type GatewayAssignmentExposure } from "./routing-assignment.js";
import { buildGatewayModelConstraints } from "../models.js";
import { routingBatchInstructions, routingDifficulty, routingSeatEffort, type RoutingChoice } from "./routing-decision.js";

export interface GatewayRoutingBatchItem { readonly key: string; readonly prompt: string }
export interface GatewayRoutingBatchDecision {
  readonly key: string;
  readonly model: string;
  readonly effort?: string;
  readonly via: "route" | "rule" | "least-used";
  readonly because: string;
}
export interface GatewayRoutingBatchOptions {
  readonly choose: (input: {
    readonly state: Readonly<Record<string, unknown>>;
    readonly instructions: readonly string[];
    readonly criteria: Readonly<Record<string, string>>;
    readonly difficulty: typeof routingDifficulty;
    readonly tasks: readonly string[];
  }, signal?: AbortSignal) => Promise<Readonly<Record<string, RoutingChoice>>>;
  readonly signal?: AbortSignal;
  readonly refreshExposure?: () => GatewayAssignmentExposure;
}
export class NoEnabledGatewayModelsError extends Error {}

/** 상위 세션 전용 배치. 하위 에이전트·Workflow 배정 정책에는 critical 폴백을 추가하지 않는다. */
export async function decideGatewayRoutingBatch(
  items: readonly GatewayRoutingBatchItem[], exposure: GatewayAssignmentExposure, options: GatewayRoutingBatchOptions,
): Promise<readonly GatewayRoutingBatchDecision[]> {
  const abort = () => { if (options.signal?.aborted) throw options.signal.reason ?? new Error("Aborted"); };
  abort();
  const current = options.refreshExposure?.() ?? exposure;
  if (!visibleDelegationModels(current).length) throw new NoEnabledGatewayModelsError("no_enabled_models");
  const candidates = evaluateGatewayCandidateModels(current);
  const enabled = buildGatewayEnabledModels(current).models;
  const sole = candidates.length === 1 && (enabled.find(row => row.model === canonicalGatewayCandidateId(candidates[0]!.model))?.efforts.length ?? 0) <= 1;
  let choices: Readonly<Record<string, RoutingChoice>> = {};
  let reason = candidates.length ? "sole candidate" : "all enabled models are critical";
  if (candidates.length && !sole) {
    const tasks = items.map((item, index) => ({ id: `t${index}`, prompt: item.prompt }));
    try {
      choices = await options.choose({
        state: { gateway_models: buildGatewayLoadout(current), tasks },
        instructions: routingBatchInstructions, difficulty: routingDifficulty,
        criteria: Object.fromEntries(candidates.map((entry, index) => [`c${index}`, canonicalGatewayCandidateId(entry.model)])),
        tasks: tasks.map(task => task.id),
      }, options.signal);
      reason = "stale or invalid routing choice";
    } catch (error) {
      abort();
      reason = `routing decision failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  abort();
  const latest = options.refreshExposure?.() ?? current;
  const visible = visibleDelegationModels(latest);
  if (!visible.length) throw new NoEnabledGatewayModelsError("no_enabled_models");
  const allowed = evaluateGatewayCandidateModels(latest);
  const rows = buildGatewayEnabledModels(latest).models;
  const decisions = items.map((item, index): GatewayRoutingBatchDecision => {
    const choice = choices[`t${index}`];
    const selected = sole ? candidates[0]?.model : candidates.find((_, n) => choice?.seat === `c${n}`)?.model;
    const routed = selected && allowed.some(entry => entry.model.id === selected.id) ? selected : undefined;
    const rule = allowed[0]?.model;
    const leastUsed = () => visible.reduce((best, model) => {
      const remaining = (candidate: typeof model) => evaluateModelAllowance(latest.quota?.[candidate.provider], buildGatewayModelConstraints(candidate)).remainingPercent ?? -1;
      return remaining(model) > remaining(best) ? model : best;
    });
    const model = routed ?? rule ?? leastUsed();
    const id = canonicalGatewayCandidateId(model);
    const effort = routingSeatEffort(rows.find(row => row.model === id)?.efforts ?? [], routed ? choice?.difficulty : undefined);
    return { key: item.key, model: id, ...(effort ? { effort } : {}), via: routed ? "route" : rule ? "rule" : "least-used", because: routed ? (sole ? "sole candidate" : "AI model") : reason };
  });
  abort();
  for (const decision of decisions) {
    const model = visible.find(model => canonicalGatewayCandidateId(model) === decision.model)!;
    latest.providerLoad?.set(model.provider, (latest.providerLoad.get(model.provider) ?? 0) + 1);
    latest.distribution?.record(model.provider, latest);
  }
  return decisions;
}
