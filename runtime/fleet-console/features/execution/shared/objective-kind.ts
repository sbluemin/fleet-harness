import type { ObjectiveKindDescriptor } from "./client-contract.js";

/** Agent bodies belong to Console execution, not the former terminal plugin. */
export const AGENT_OBJECTIVE_KIND = { pluginId: null, type: "agent" } as const;

export function findAgentObjectiveKind(kinds: readonly ObjectiveKindDescriptor[]): ObjectiveKindDescriptor | undefined {
  return kinds.find((kind) => kind.pluginId === AGENT_OBJECTIVE_KIND.pluginId && kind.type === AGENT_OBJECTIVE_KIND.type);
}
