/**
 * 이 원격 접속이 끝났다는 사실을 SSE 수신부에서 화면으로 옮기는 창 이벤트.
 *
 * 전송과 안내가 이 이름을 각자 적어 두면 한쪽만 고쳐진 채 갈라진다. 그렇다고 안내가 SSE
 * 모듈을 직접 들여다보게 하면 화면 하나가 전송 전체에 매인다 — 이름과 사유만 여기 둔다.
 */
export const CONTROL_RECLAIMED_EVENT = "fleet-console:control-reclaimed";

/** 주인이 되찾았거나(reclaimed), 다른 기기의 접속이 이 접속을 대신했거나(superseded). */
export type SessionEndedReason = "reclaimed" | "superseded";

export interface SessionEndedDetail {
  readonly reason: SessionEndedReason;
}
