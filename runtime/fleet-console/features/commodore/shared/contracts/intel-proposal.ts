/**
 * 정보 변경 제안 — 승인 코어의 둘째 타입.
 * 기억(memory)은 여기 없다. 사령관이 직접 쓰는 메모라 승인을 타지 않는다.
 * 화면은 `approval:state` 스냅숏에서 `type` 으로 가른다.
 */

export const INTEL_PROPOSAL_TYPE = "commodore.intel";

/** 고치거나 지울 때 항목이 제안 당시와 같은가. `editedAt` 이 없으면 null. */
export interface IntelProposalBase {
  readonly editedAt: number | null;
  readonly text: string;
}

export type IntelProposalPayload =
  | { readonly kind: "add"; readonly proposerId: string; readonly targetId: string; readonly text: string }
  | { readonly kind: "edit"; readonly proposerId: string; readonly targetId: string; readonly intelId: string; readonly text: string; readonly base: IntelProposalBase }
  | { readonly kind: "remove"; readonly proposerId: string; readonly targetId: string; readonly intelId: string; readonly base: IntelProposalBase };
