import type { useT } from "../../i18n/index.js";
import type { OperationNode } from "../../integration/types.js";

/**
 * 「채팅|터미널」 — 에이전트 Operation은 보는 방식을 말한다(S-26·S-30). 에이전트 세션이 아니면 undefined.
 * Operation 화면 막대의 보조 줄과 대화 행의 상태 요약이 같은 말을 쓴다.
 */
export function operationHarnessLabel(operation: OperationNode, t: ReturnType<typeof useT>): string | undefined {
  const session = operation.payload.session && typeof operation.payload.session === "object" && !Array.isArray(operation.payload.session)
    ? operation.payload.session as Record<string, unknown>
    : null;
  if (session?.harness !== "claude-code") return undefined;
  return t(operation.payload.chatMode === true ? "mobile.bar.viewChat" : "mobile.bar.viewTerminal");
}
