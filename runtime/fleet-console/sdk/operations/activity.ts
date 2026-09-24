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

/**
 * 부모가 대표하는 구성원의 활동을 부모 한 행에 끌어올린다 — 목록에서는 부모가 구성원을 대표하므로, 구성원이 기다리면 부모도
 * 대기로, 부모는 쉬는데 구성원이 일하면 부모는 백그라운드로 선다. 부모 자신의 대기·실행이 먼저다.
 * 살아 있는 부모와 구성원의 활동만 넘긴다(휴면·모름은 넘기지 않는다). 클라이언트 스토어의 공개 활동 축과 서버의 Console Use
 * 스캔이 이 한 규칙을 쓴다.
 */
export function liftNestedActivity<T extends string>(own: T, members: readonly string[]): T | "awaiting" | "background" {
  if (own === "awaiting" || members.includes("awaiting")) return "awaiting";
  if (own === "running") return own;
  if (own === "background" || members.some((activity) => activity === "running" || activity === "background")) return "background";
  return own;
}
