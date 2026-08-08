/**
 * 제어권 이양의 관측면. 원격 세션이 열리고 닫히는 사실은 설정 화면을 열어야만 보이던 정보였는데,
 * 그 사이 원격은 이미 터미널을 몰 수 있다. 이 두 이벤트가 그 공백을 메운다.
 *
 * 두 이벤트의 수신자가 서로 다르다는 점이 이 계약의 핵심이다 — `control:changed`는 이 기계 앞에
 * 앉은 사람의 것이고, `control:reclaimed`는 방금 끊긴 그 세션 하나의 것이다. 하나의 스트림으로
 * 합치면 원격 세션이 다른 세션의 존재와 기기 이름을 읽게 된다.
 */

/** 루프백 구독자에게만. 지금 제어를 쥔 원격이 누구인지(없으면 null). */
export const CONTROL_CHANGED_EVENT = "control:changed";

/** 끊긴 그 원격 세션에게만. 자기 세션이 회수되었음을 알린다. */
export const CONTROL_RECLAIMED_EVENT = "control:reclaimed";

/**
 * 제어를 쥔 원격 세션의 공개 표현. `handle`은 회수 호출의 대상이고 쿠키 비밀값과 다르다.
 * 세션 요약에서 이 화면에 필요한 만큼만 옮겨 담는다 — 만료 시각은 커튼이 말할 것이 없다.
 */
export interface ControlHolderSnapshot {
  readonly handle: string;
  /** 조인할 때 기기가 스스로 밝힌 이름. null이면 화면이 대체 이름을 쓴다. */
  readonly device: string | null;
  readonly openedAt: number;
}

export interface ControlChangedSnapshot {
  readonly holder: ControlHolderSnapshot | null;
}

export const controlChangedSnapshot = (holder: ControlHolderSnapshot | null): ControlChangedSnapshot => ({ holder });

/** 회수 사유. 지금은 하나뿐이지만, 만료·리스너 종료와 구분할 자리를 남겨 둔다. */
export type ControlReclaimedReason = "reclaimed";

export interface ControlReclaimedSnapshot {
  readonly reason: ControlReclaimedReason;
}

export const controlReclaimedSnapshot = (reason: ControlReclaimedReason): ControlReclaimedSnapshot => ({ reason });

/**
 * 플러그인에게 보유자 변화를 알리는 채널. 브라우저로 나가는 SSE 이벤트와 목적이 다르다 —
 * 이쪽은 서버 안에서 이미 열려 있는 전송을 다시 협상시키기 위한 것이다.
 */
export const CONTROL_HOLDER_EVENT_CHANNEL = "control:holder";
