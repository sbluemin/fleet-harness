/**
 * 정보 변경 제안 — 승인 코어의 둘째 타입.
 * 기억(memory)은 여기 없다. 사령관이 직접 쓰는 메모라 승인을 타지 않는다.
 * 대상 사령관마다 열린 정보 제안은 하나(add·edit·remove 중 하나)다.
 */

export const INTEL_PROPOSAL_TYPE = "commodore.intel";

export type IntelProposalPayload = (
  | { readonly kind: "add"; readonly proposerId: string; readonly targetId: string; readonly text: string }
  | { readonly kind: "edit"; readonly proposerId: string; readonly targetId: string; readonly intelId: string; readonly text: string }
  | { readonly kind: "remove"; readonly proposerId: string; readonly targetId: string; readonly intelId: string }
) & {
  /** 이 제안이 같은 대상의 이전 정보 제안을 밀어냈으면 참. 끝난 제안의 이력은 아니다. */
  readonly replaced?: true;
};
