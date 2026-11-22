/**
 * 원격 미리보기 — 호스트 Desktop이 이미 캡처한 '에이전트가 고른 창 1개'에서 원격 full 시청자가 있을 때만
 * 1초마다 정지 화면 한 장을 뽑아, 서버가 메모리에 최신 1장만 들고 원격 full 화면에 나눠 준다(결정 8cd1a62d).
 * 브라우저 번들과 호스트가 같은 리터럴을 쓰도록 여기 둔다.
 */

/** 호스트 Desktop이 지금 쓰는 화면 밖 창의 스틸을 요청하는 루프백 전용 경로. */
export const DESKTOP_OFFSCREEN_PREVIEW_STILL_PATH = "/api/v1/desktop/computer-preview/still";
/** 호스트 Desktop 렌더러가 정지 화면을 올리는 루프백 전용 경로. 원격 리스너에서는 404다. */
export const DESKTOP_REMOTE_PREVIEW_FRAME_PATH = "/api/v1/desktop/computer-preview/frame";
/** 원격 full 화면이 최신 정지 화면을 기다려 받는 경로(long-poll). 루프백에서는 404, monitoring은 403이다. */
export const REMOTE_PREVIEW_FRAME_PATH = "/api/v1/computer-preview/frame";

/**
 * 원격 full 화면이 붙자마자 1회 읽는 지금 상태. SSE 채널은 지난 프레임을 다시 보내지 않으므로, 화면이 핸드셰이크 뒤에
 * 구독을 시작해도 이미 진행 중인 컴퓨터 사용을 놓치지 않게 한다. 판정은 프레임 경로와 같다(루프백 404·monitoring 403).
 */
export const REMOTE_PREVIEW_STATE_PATH = "/api/v1/computer-preview/state";
/** 원격 full 구독자에게만 — 지금 보여 줄 화면이 있는지와 호스트가 보내기를 껐는지. */
export const REMOTE_PREVIEW_STATE_EVENT = "computer-preview:state";
/** 호스트 Desktop(로컬) 구독자에게만 — 정지 화면을 받아 가는 원격 기기 수. 0이면 뽑지 않는다. */
export const REMOTE_PREVIEW_VIEWERS_EVENT = "computer-preview:viewers";

/** 올릴 때 붙이는 대상 id 질의 이름 — 대상이 바뀐 뒤 늦게 도착한 장은 서버가 버린다. */
export const REMOTE_PREVIEW_TARGET_PARAM = "target";
/** 원격이 마지막으로 받은 장 번호. 이보다 새 장이 있을 때만 돌려준다. */
export const REMOTE_PREVIEW_AFTER_PARAM = "afterSeq";
export const REMOTE_PREVIEW_SEQ_HEADER = "x-fleet-preview-seq";
/** 서버가 응답할 때 이 장이 몇 ms 전에 찍혔는지. 기기 사이 시계 차이를 타지 않으려고 나이로 싣는다. */
export const REMOTE_PREVIEW_AGE_HEADER = "x-fleet-preview-age-ms";

/** 정지 화면 가로 상한(px)과 간격·화질. 실측 근거: 목표 71123199 evidence proposal/jpeg-sizes.json. */
export const REMOTE_PREVIEW_MAX_WIDTH = 480;
export const REMOTE_PREVIEW_INTERVAL_MS = 1000;
export const REMOTE_PREVIEW_JPEG_QUALITY = 0.6;
/** 한 장의 크기 상한. 480px JPEG 실측 최대 18.4KB에 넉넉한 여유를 둔다. */
export const REMOTE_PREVIEW_MAX_BYTES = 256 * 1024;
/** 이보다 오래 새 장이 없으면 원격 카드가 갱신 멈춤을 알린다. */
export const REMOTE_PREVIEW_STALE_MS = 5000;

/** 원격에 싣는 화면의 주인. 창 번호·pid·창 제목 같은 호스트 식별자는 싣지 않는다. */
export interface RemotePreviewTarget {
  readonly id: string;
  readonly ownerKind: "objective" | "commodore";
  readonly objectiveId: string | null;
  readonly commodoreId: string | null;
  readonly actor: string;
}

/** `computer-preview:state` 프레임. `sending: false`는 컴퓨터 사용 중이지만 호스트가 원격 보내기를 끈 상태다. */
export interface RemotePreviewState {
  readonly target: RemotePreviewTarget | null;
  readonly sending: boolean;
}

export function readRemotePreviewState(value: unknown): RemotePreviewState {
  if (!value || typeof value !== "object") return { target: null, sending: false };
  const record = value as Record<string, unknown>;
  const raw = record.target;
  let target: RemotePreviewTarget | null = null;
  if (raw && typeof raw === "object") {
    const t = raw as Record<string, unknown>;
    if (typeof t.id === "string" && (t.ownerKind === "objective" || t.ownerKind === "commodore") && typeof t.actor === "string") {
      target = {
        id: t.id,
        ownerKind: t.ownerKind,
        objectiveId: typeof t.objectiveId === "string" ? t.objectiveId : null,
        commodoreId: typeof t.commodoreId === "string" ? t.commodoreId : null,
        actor: t.actor,
      };
    }
  }
  return { target, sending: record.sending === true };
}
