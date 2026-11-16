import type { useT } from "../../i18n/index.js";
import type { ObjectiveRecord } from "../../integration/types.js";

/**
 * 에이전트 Objective은 채팅으로 연다(S-26·S-30). 에이전트 세션이 아니면 undefined.
 * Objective 화면 막대의 보조 줄과 대화 행의 상태 요약이 같은 말을 쓴다.
 */
export function objectiveRecordHarnessLabel(objectiveRecord: ObjectiveRecord, t: ReturnType<typeof useT>): string | undefined {
  const session = objectiveRecord.session && typeof objectiveRecord.session === "object" && !Array.isArray(objectiveRecord.session)
    ? objectiveRecord.session as Record<string, unknown>
    : null;
  if (session?.harness !== "claude-code") return undefined;
  return t("mobile.bar.viewChat");
}
