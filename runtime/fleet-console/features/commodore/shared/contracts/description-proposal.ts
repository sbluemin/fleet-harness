/**
 * 설명 변경 제안 — 승인 코어에 등록하는 첫 타입.
 * 화면은 나중에 이 모양을 `approval:state` 스냅숏의 `type` 으로 가른다.
 */

export const DESCRIPTION_PROPOSAL_TYPE = "commodore.description";

export interface DescriptionProposalPayload {
  /** 제안한 사령관. */
  readonly proposerId: string;
  /** 설명을 바꿀 사령관. 제안한 사령관 자신이어도 된다. */
  readonly targetId: string;
  /** 제안한 순간의 설명 rev. 승인도 직접 고침도 이 값과 달라지면 제안은 stale 이다. */
  readonly baseRev: number;
  /** 제안 문안. `MAX_DESCRIPTION` 이내. */
  readonly text: string;
}
