import { useT } from "../../../core/client/src/i18n/index.js";
import type { ClusterIndex } from "./operation-clusters.js";

/**
 * 결정 요청 표식 — 묶음 서술자가 「뿌리에게 사람의 답을 청한 결정 요청이 있다」고 말할 때 뿌리 행·칩 이름 옆에 선다.
 * 물음표 말풍선 하나로 「있다/없다」만 말한다(요청은 묶음마다 하나다). 허용 대기의 청록 비콘·도착의 초록과 모양·색이 다르다.
 */
export function DecisionRequestMark({ decorative = false }: { readonly decorative?: boolean }) {
  const t = useT();
  const label = t("operation.decisionRequest");
  return (
    <span className="operation-decision-mark" title={label} {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label })}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M3.2 2.8h9.6a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H7.4L4.4 14v-2.4H3.2a1.4 1.4 0 0 1-1.4-1.4v-6a1.4 1.4 0 0 1 1.4-1.4z" /><path d="M6.5 5.6a1.5 1.5 0 1 1 2.1 1.4c-.4.2-.6.5-.6.9v.3" /><circle cx="8" cy="9.5" r=".2" fill="currentColor" /></svg>
    </span>
  );
}

/** 이 Operation 이 뿌리인 묶음에 결정 요청이 섰는가. */
export const hasDecisionRequest = (index: ClusterIndex, operationId: string): boolean => index.rootOf.get(operationId)?.cluster.decisionRequest === true;
