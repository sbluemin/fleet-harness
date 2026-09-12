import type { OperationActivity, OperationRuntimeState } from "../plugin/types.js";

export interface AgentActivitySource {
  readonly status: string;
  readonly chatActive?: boolean;
  readonly attentionPending?: boolean;
  readonly backgroundPending?: boolean;
  readonly modelActivity?: "working" | "not-working";
  readonly turnState: string;
}

export function sessionActivity(session: AgentActivitySource): OperationActivity {
  if (session.attentionPending === true) return "awaiting";
  if (session.turnState === "ended" && session.backgroundPending === true) return "background";
  if (session.modelActivity === "working") return "running";
  if (session.modelActivity === "not-working") return session.backgroundPending === true ? "background" : "idle";
  if (session.turnState === "running") return "running";
  return session.backgroundPending === true ? "background" : "idle";
}

export function sessionRuntime(session: AgentActivitySource): OperationRuntimeState {
  if (session.chatActive !== true && session.status === "dormant") return { lifecycle: "dormant" };
  return { lifecycle: "live", activity: sessionActivity(session) };
}
