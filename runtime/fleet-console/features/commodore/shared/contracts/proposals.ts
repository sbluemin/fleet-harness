/**
 * 사령관의 설명·정보를 바꾸는 승인 제안 — 승인 코어에 등록하는 두 타입.
 * 기억(memory)은 여기 없다. 사령관이 직접 쓰는 메모라 승인을 타지 않는다.
 * 화면은 나중에 이 모양을 `approval:state` 스냅숏의 `type` 으로 가른다.
 */

/** 설명 변경 제안 — 승인 코어에 등록하는 첫 타입. 대상 사령관마다 열린 제안은 하나다. */
export const DESCRIPTION_PROPOSAL_TYPE = "commodore.description";

export interface DescriptionProposalPayload {
  /** 제안한 사령관. */
  readonly proposerId: string;
  /** 설명을 바꿀 사령관. 제안한 사령관 자신이어도 된다. */
  readonly targetId: string;
  /** 제안 문안. `MAX_DESCRIPTION` 이내. 승인하면 그 순간의 설명을 이 문안으로 덮어쓴다. */
  readonly text: string;
  /** 이 제안이 같은 대상의 이전 제안을 밀어냈으면 참. 카드의 「이전 제안을 대신했어요」. 끝난 제안의 이력은 아니다. */
  readonly replaced?: true;
}

/** 정보 변경 제안 — 승인 코어의 둘째 타입. 대상 사령관마다 열린 정보 제안은 하나(add·edit·remove 중 하나)다. */
export const INTEL_PROPOSAL_TYPE = "commodore.intel";

export type IntelProposalPayload = (
  | { readonly kind: "add"; readonly proposerId: string; readonly targetId: string; readonly text: string }
  | { readonly kind: "edit"; readonly proposerId: string; readonly targetId: string; readonly intelId: string; readonly text: string }
  | { readonly kind: "remove"; readonly proposerId: string; readonly targetId: string; readonly intelId: string }
) & {
  /** 이 제안이 같은 대상의 이전 정보 제안을 밀어냈으면 참. 끝난 제안의 이력은 아니다. */
  readonly replaced?: true;
};
