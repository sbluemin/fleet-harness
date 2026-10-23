import type { ReactNode } from "react";
import type { ObjectiveLaunchVariantGroup } from "../../../objectives/shared/records/types.js";

import { LaunchModelEffort } from "../../../execution/client/components/launch-model-effort.js";
import { writeNewSessionModelEffort } from "./new-session-preferences.js";

/** 새 세션을 띄울 모델·강도 좌표. 값은 실행 의도의 `variant.model`·`variant.effort` 로 그대로 실린다(null 이면 싣지 않는다). */
export interface NewSessionLaunchChoice {
  readonly model: string | null;
  readonly effort: string | null;
}

export interface NewSessionLaunchSlotProps {
  /** 모델·강도 변형을 선언한 실행 종류의 로스터(`kind.variants`) — AI Gateway 에서 켠 모델 그대로다. 카탈로그를 읽기 전에는 빈 배열. */
  readonly groups: readonly ObjectiveLaunchVariantGroup[];
  /** 지금 고른 값. 처음에는 새 세션 기억(없으면 기본 Opus)으로 채워져 온다. */
  readonly value: NewSessionLaunchChoice;
  /** 고른 값을 새 세션 화면에 돌려준다. 기억(writeNewSessionModelEffort 등)을 쓸지는 이 칸이 정한다. */
  readonly onChange: (next: NewSessionLaunchChoice) => void;
  /** 시작하는 중에는 바꿀 수 없다. */
  readonly disabled: boolean;
  /** 숨은 강도(MAX·ULTRACODE) 게이트의 펼침 — 트랙의 ✦와 `/effort` 목록의 문 행이 이 한 상태를 쓴다. */
  readonly apexOpen: boolean;
  readonly onApexOpenChange: (open: boolean) => void;
}

/**
 * 새 세션 화면 칩 줄 오른쪽의 모델·강도 칸. 화면은 이 칸에 자리와 값만 건네고, 칸이 무엇을 그리는지는 모른다.
 *
 * 모델 칩은 모델 메뉴(216px 공급자 띠)를 열고, 강도는 같은 EffortTrack 을 옆에 둔다. 평소 강도만 서고, 숨은 강도는 트랙의 ✦로 펼친다.
 * 모델을 바꾸면 사다리에 없는 강도는 자동으로 돌아가고, 고른 값은 모바일 새 대화 시트와 같은 자리에 기억한다.
 * 칩 줄은 `new-session-chips` 컨테이너다(new-session.css). 폭이 600px 미만이면 이 칸이 둘째 줄 오른쪽으로 내려가고,
 * 380px 미만에서는 `.effort-track-value` 를 숨긴다.
 */
export function NewSessionLaunchSlot({ groups, value, onChange, disabled, apexOpen, onApexOpenChange }: NewSessionLaunchSlotProps): ReactNode {
  return (
    <LaunchModelEffort
      groups={groups}
      model={value.model}
      effort={value.effort}
      disabled={disabled || groups.length === 0}
      apexOpen={apexOpen}
      onApexOpenChange={onApexOpenChange}
      placement="above"
      onChange={(model, effort) => {
        writeNewSessionModelEffort(model, effort);
        onChange({ model, effort });
      }}
    />
  );
}
