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

import {
  buildGatewayLoadout,
  type GatewayLoadout,
  type GatewayQuotaSnapshot,
} from "./model-loadout.js";

export const GATEWAY_MODELS_TOOL_ID = "gateway_models";

export interface GatewayModelsSelection {
  /** Exactly the models the user exposed in the Console. Never the whole catalog. */
  readonly models: readonly GatewayModel[];
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
  usageGuidelines: [
    `models[] contains only the exposed models. A model absent here is one the user turned off — the gateway still executes it, so pinning it would quietly override that choice with no error.`,
    `constraints.effortLadder lists the only reasoning levels that survive; a level outside it is clamped upstream without notice. Ladders differ per model, and some models have no effort control at all.`,
    `roleFit is null when the axis was never measured. Unmeasured is not unsuitable — it means quality gives no reason to prefer one identity, so the choice falls to allowance rather than back to the session's own model.`,
    `constraints.quotaScope names the sub-allowance a model is billed against. Read the provider window whose scope matches it; the scope-less window is the sum of pools and can look healthy while that model's own pool is spent.`,
    `A provider quota of status "unsupported" means the allowance cannot be read, never that it is plentiful.`,
    `An unpinned stage spends whatever this session is currently running on, so its provider is the baseline an offload is measured against. The roster cannot identify that provider — it is registered once per runtime and cannot see which model a given session launched with — so match it yourself against the model you are running, and read that provider's window.`,
    `isSessionDefault reflects what Settings currently designates, not necessarily what an already-running session launched with; the two diverge when the setting is changed mid-session.`,
    `constraints.homolineage marks a model sharing the parent session's lineage. It can move spend off that allowance, but adds no independence to a panel whose value comes from differing judgement.`,
    `Some exposed models are the host's own rather than a gateway provider's: they bill the "claude" provider, so that is the window to read before assigning one, and they are homolineage by construction. Whether pinning one moves spend off the inherited baseline depends on what this session is currently running — the rule above governs that, and it is not answered by the model being the host's own.`,
    `constraints.identity collapses service-tier siblings, so a measurement recorded against one covers the other.`,
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
    ...(selection.defaultModel ? { defaultModel: selection.defaultModel } : {}),
    ...(quota ? { quota } : {}),
  });
}
