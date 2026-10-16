import type { ReactNode } from "react";
import type { OperationLaunchVariantGroup } from "@fleet-console/sdk/operations";

/** 새 세션을 띄울 모델·강도 좌표. 값은 실행 의도의 `variant.model`·`variant.effort` 로 그대로 실린다(null 이면 싣지 않는다). */
export interface NewSessionLaunchChoice {
  readonly model: string | null;
  readonly effort: string | null;
}

export interface NewSessionLaunchSlotProps {
  /** 모델·강도 변형을 선언한 실행 종류의 로스터(`kind.variants`) — AI Gateway 에서 켠 모델 그대로다. 카탈로그를 읽기 전에는 빈 배열. */
  readonly groups: readonly OperationLaunchVariantGroup[];
  /** 지금 고른 값. 처음에는 Quick Launch 기억(없으면 기본 Opus)으로 채워져 온다. */
  readonly value: NewSessionLaunchChoice;
  /** 고른 값을 새 세션 화면에 돌려준다. 기억(writeQuickLaunchModelEffort 등)을 쓸지는 이 칸이 정한다. */
  readonly onChange: (next: NewSessionLaunchChoice) => void;
  /** 시작하는 중에는 바꿀 수 없다. */
  readonly disabled: boolean;
}

/**
 * 새 세션 화면 칩 줄 오른쪽의 모델·강도 칸. 화면은 이 칸에 자리와 값만 건네고, 칸이 무엇을 그리는지는 모른다.
 *
 * 칩 줄은 `new-session-chips` 컨테이너다(new-session.css). 폭이 600px 미만이면 이 칸이 둘째 줄 오른쪽으로 내려가고,
 * 380px 미만에서는 `.effort-track-value` 를 숨긴다 — 이 칸의 다른 좁은 폭 규칙도 같은 `@container new-session-chips` 아래에 둔다.
 *
 * 지금은 비어 있다: 모델 칩·강도 트랙은 컴포저 칩 작업이 이 파일에 세운다. 그 전까지 새 세션은 위 `value`(기억된 또는 기본 모델)로 실행된다.
 */
export function NewSessionLaunchSlot(_props: NewSessionLaunchSlotProps): ReactNode {
  return null;
}
