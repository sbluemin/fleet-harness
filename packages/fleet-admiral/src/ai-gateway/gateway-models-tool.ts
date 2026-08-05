/**
 * ai-gateway/gateway-models-tool — live roster of the gateway models a host may
 * assign to workflow stages.
 *
 * The tool reports facts and stops there. When to pin a model at all, and what
 * counts as a reason, is doctrine and lives in the Standing Orders and the
 * `workflow` skill; stating it twice would let the two drift apart.
 */

import type { AgentToolSpec } from "@dotobokuri/core-agent";
import type { GatewayModel } from "@dotobokuri/core-ai-gateway";

import type { GatewayEffortExposure } from "../agent-cli/gateway-agents.js";
import {
  buildGatewayLoadout,
  type GatewayLoadout,
  type GatewayQuotaSnapshot,
} from "./model-loadout.js";

export const GATEWAY_MODELS_TOOL_ID = "gateway_models";

export interface GatewayModelsSelection {
  /** Exactly the models the user exposed in the Console. Never the whole catalog. */
  readonly models: readonly GatewayModel[];
  /** Per-model reasoning rungs the user exposed. Absent entry = that model's whole ladder. */
  readonly effortExposure?: GatewayEffortExposure;
  readonly defaultModel?: GatewayModel;
}

export interface GatewayModelsToolDeps {
  /** Read at call time; the exposed set is user-editable while a session runs. */
  readonly readSelection: () => Promise<GatewayModelsSelection> | GatewayModelsSelection;
  /** Omitted when the host cannot read allowances; every provider then reports `unsupported`. */
  readonly readQuota?: () => Promise<GatewayQuotaSnapshot | undefined> | GatewayQuotaSnapshot | undefined;
}

const GATEWAY_MODELS_DOCTRINE = {
  id: GATEWAY_MODELS_TOOL_ID,
  tag: GATEWAY_MODELS_TOOL_ID,
  title: "gateway_models Tool Guidelines",
  description:
    `Report the gateway models currently available to this session, each model's routing constraints and measured role fit, and the current provider allowances.`
    + ` The roster is exactly what the user exposed in the Console and is editable while this session runs, so it is resolved at call time rather than remembered.`,
  promptSnippet:
    `gateway_models — Live roster of assignable gateway models: constraints, measured role fit, and provider allowances.`,
  whenToUse: [
    `Call gateway_models before every run that leaves the host — a staged workflow or a single Agent — not only when a run pins a model or a reasoning effort.`,
    `Call it again before a later dispatch in the same session; the roster is re-read from Settings on every call, and allowances move while work is in flight.`,
  ],
  whenNotToUse: [
    `Do not carry an earlier read forward as if it were still current. The revision tracks roster and default changes only, never allowance movement, so equal revisions do not mean equal quotas.`,
    `Do not treat the response as a recommendation to act on unread. It reports facts; the choice and its justification stay with you.`,
  ],
  // 이 목록은 필드 사전이 아니라 판정 규칙이다. 응답을 보면 알 수 있는 것은 빼고,
  // 틀리면 조용히 실패하는 것만 남긴다 — 길어질수록 읽히지 않고, 읽히지 않으면 없는 것과 같다.
  usageGuidelines: [
    `Two spellings, never interchangeable. agentTypes names this identity once per reasoning rung, so selecting by name already carries the level and nothing further pins effort; modelId is the model as a value. Neither derives from the other — the transform behind a name collapses ".", "[1m]", and "--" all into "-". Prefer a name: a wrong name fails loudly, while modelId reaches whatever the catalog holds, including a model the user turned off, in silence.`,
    `Names are registered once at session start; this roster is re-read live. A model exposed mid-session therefore appears here under a name that will not resolve until a new session — that, and not a stale roster, is what an unknown-name failure means.`,
    `Each provider entry pairs one allowance with the exposed models it serves, so the window to read against a model is in the same entry. claude serves none by design: it is what an unpinned run spends, and the baseline an offload is measured against. A model in no entry is one the user turned off.`,
    `effortLadder is what this session offers as identities, not what the model can do: the user exposes a model at some or all of its levels, so a level absent here may still exist upstream. A level outside the model's own ladder is clamped down with no signal and refused when nothing is below it, and some models have no effort control at all. The registration caveat above covers levels too: widening a model's exposure mid-session adds names here that this session cannot resolve.`,
    `roleFit null means unmeasured, never unsuitable: quality then gives no reason to prefer an identity, so the choice falls to allowance and never back to this session's own model. homolineage marks shared lineage with that session — useful for moving spend, useless where independent judgement is the product.`,
    `Read pressure before doing arithmetic of your own; it is the verdict on one window, combining headroom with burn pace against that window's own clock, and it never says which model to choose. Compare usedPercent only within one cadence — a shared window id does not mean a shared length. Where a provider splits into pools, quotaScope picks the window that applies and the isAggregate one stays out of headroom math. recoveryHalfLifeMs prices the drain: weeks of lockout for a monthly window, hours for a session one.`,
    `Absence is never safety. A missing derived field means the reading could not support it, and status "unsupported" means the allowance could not be read at all.`,
    `The roster cannot tell which provider this session itself runs on — it is registered once per runtime — so make that match yourself and read that window. isSessionDefault reflects Settings as it stands now, not what an already-running session launched with.`,
  ],
};

export function buildGatewayModelsToolSpec(deps: GatewayModelsToolDeps): AgentToolSpec {
  return {
    ...GATEWAY_MODELS_DOCTRINE,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const loadout = await resolveLoadout(deps);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(loadout) }],
        isError: false,
        details: loadout,
      };
    },
  };
}

async function resolveLoadout(deps: GatewayModelsToolDeps): Promise<GatewayLoadout> {
  const selection = await deps.readSelection();
  // A failed allowance read must not sink the roster: constraints and role fit
  // are still the larger part of the decision, and reporting `unsupported`
  // states the gap instead of implying room.
  let quota: GatewayQuotaSnapshot | undefined;
  try {
    quota = await deps.readQuota?.();
  } catch {
    quota = undefined;
  }
  return buildGatewayLoadout({
    exposed: selection.models,
    ...(selection.effortExposure ? { effortExposure: selection.effortExposure } : {}),
    ...(selection.defaultModel ? { defaultModel: selection.defaultModel } : {}),
    ...(quota ? { quota } : {}),
  });
}
