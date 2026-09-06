/**
 * ai-gateway/gateway-models-tool — live roster of the gateway models a host may
 * assign to workflow stages.
 *
 * The host reads this before a handoff; identity choice is the delegation
 * skill's semantic policy, and no hook gates a dispatch.
 */

import type { AgentToolSpec } from "@dotobokuri/core-agent";
import type { GatewayModel, GatewayProvider } from "@dotobokuri/core-ai-gateway";

import type { GatewayEffortExposure } from "../agent-cli/gateway-agents.js";
import {
  buildGatewayLoadout,
  type GatewayLoadout,
  type GatewayQuotaSnapshot,
} from "./model-loadout.js";

export const GATEWAY_MODELS_TOOL_ID = "gateway_models";

export interface GatewayModelsSelection {
  /** Exactly the delegable models the user exposed — the exposed set minus the ones reserved for the host session. Never the whole catalog. */
  readonly models: readonly GatewayModel[];
  /** Per-model reasoning rungs the user exposed. Absent entry = that model's whole ladder. */
  readonly effortExposure?: GatewayEffortExposure;
  /** The user's opt-in ordered spend preference across providers; weights the allowance axis only. */
  readonly providerPriority?: readonly GatewayProvider[];
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
  // MCP로 실제 전달되는 필드는 description 하나다(core-agent specToMcpTool). whenToUse·
  // usageGuidelines에 적은 문장은 모델에 도달하지 않으므로, 틀리면 조용히 실패하는 두 규칙은
  // 여기에 둔다. 나머지 판정 규칙 — 응답을 어떻게 읽고 판단하는가 — 은 delegation 스킬의
  // references가 온디맨드로 소유한다. 여기에 겹쳐 실으면 같은 사실이 두 곳에서 따로 늙는다.
  description:
    `Report the gateway models currently available to this session, each model's routing constraints, capability class, and benchmark evidence, and their current allowances with the user's ranked quota consumption priority.`
    + ` The roster is the models the user exposed in the Console minus the ones reserved for the host session; signed-out providers and providers without roster models are omitted. It is editable while this session runs, so it is resolved at call time rather than remembered.`
    + ` Two spellings, never interchangeable: agentTypes names a registered identity — the Agent tool's subagent_type and a workflow stage's opts.agentType both resolve it from the same registry — while modelId is the model as a value for a field that takes a model rather than a name, such as a workflow stage's opts.model. Neither spelling converts into the other.`
    + ` Names are registered once at session start while this roster is re-read live, so a model or reasoning rung exposed mid-session appears here under a name that will not resolve until a new session.`,
  promptSnippet:
    `gateway_models — Live roster of assignable gateway models: constraints, capability class, benchmark evidence, provider allowances, and the user's ranked quota consumption priority.`,
  whenToUse: [],
  whenNotToUse: [],
  usageGuidelines: [],
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
  // A failed allowance read must not sink the roster: constraints — the
  // capability class included — are still the larger part of the decision, and
  // reporting `unsupported` states the gap instead of implying room.
  let quota: GatewayQuotaSnapshot | undefined;
  try {
    quota = await deps.readQuota?.();
  } catch {
    quota = undefined;
  }
  return buildGatewayLoadout({
    exposed: selection.models,
    ...(selection.effortExposure ? { effortExposure: selection.effortExposure } : {}),
    ...(selection.providerPriority ? { providerPriority: selection.providerPriority } : {}),
    ...(quota ? { quota } : {}),
  });
}
