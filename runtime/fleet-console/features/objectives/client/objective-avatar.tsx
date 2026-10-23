import { mongleStateOf, operationAvatarKey, type MongleFacts, type MongleRole, type MongleState } from "@fleet-console/sdk/avatars";
import { useMongleLook } from "@fleet-console/sdk/avatars/browser";
import { MongleAvatar } from "@fleet-console/sdk/components/mongle-avatar";

import type { Objective } from "../shared/types.js";

/**
 * 목표 표면의 몽글 아바타 — 지휘관과 구성원의 얼굴.
 *
 * 키는 그 사람의 Operation 이다 — 지휘관은 목표 id, 구성원은 구성원 id(곧 그 Operation id)라 사이드바와 같은 모습이 선다.
 * 모습은 Console 의 아바타 책에서 읽기만 한다. 처음 배정은 사이드바가 맡고, 아직 없으면 키에서 정한 베이스다.
 *
 * 표식은 늘 장식이다(aria-hidden) — 이름은 곁의 글자가 말한다. 크기는 자리마다 CSS 가 정한다.
 * 같은 사람이 임무 줄·메뉴·그래프에 여러 번 서므로, 움직임은 명단 한 자리(`still={false}`)에만 두고 나머지는 얼굴과 배지로만 상태를 말한다.
 */
export function ObjectiveAvatar({ operationId, role, state, still = true, size = 20 }: {
  readonly operationId: string;
  readonly role: Extract<MongleRole, "commander" | "member">;
  readonly state: MongleState;
  readonly still?: boolean;
  /** 그리는 크기 — 얼굴의 세부 단계를 정한다. 보이는 크기는 자리마다 CSS 가 맞춘다. */
  readonly size?: number;
}) {
  const look = useMongleLook(operationAvatarKey(operationId));
  return <MongleAvatar base={look.base} tone={look.tone} role={role} state={state} size={size} label="" decorative className={`objectives-avatar${still ? " is-still" : ""}`} />;
}

/** 보드가 읽는 활동 낱말 → 얼굴의 활동 사실. 세션이 없거나 사라진 자리(closed·unknown)는 시작 전이다. */
function activityFacts(activity: string): Pick<MongleFacts, "session" | "activity"> {
  switch (activity) {
    case "running":
    case "background":
    case "awaiting":
    case "idle":
    case "ended": return { activity };
    default: return { session: false };
  }
}

/**
 * 구성원의 얼굴 — 사이드바·지휘관 탭 레일과 같은 기준(`mongleStateOf`)이다. 활동은 그 구성원 자기 값이고, 그 Operation 이 맡은
 * 임무가 모두 끝났으면(지금 기다리거나 일하지 않을 때) 끝난 얼굴이다.
 */
export function memberMongleState(objective: Pick<Objective, "missions">, memberId: string, activity: string): MongleState {
  const own = objective.missions.filter((mission) => mission.operationId === memberId);
  return mongleStateOf({ ...activityFacts(activity), workDone: own.length > 0 && own.every((mission) => mission.done) });
}

/**
 * 지휘관의 얼굴 — 다른 표면과 같은 기준이다(검토 대기 › 결정 요청 › 활동). 활동은 구성원 활동을 끌어올린 값(`activity`)이라,
 * 구성원이 일하거나 기다리면 지휘관도 그렇게 보인다.
 */
export function commanderMongleState(objective: Objective, activity: string): MongleState {
  return mongleStateOf({ ...activityFacts(activity), awaitingReview: objective.awaitingReview, decisionRequest: !!objective.decisionRequest && !objective.done });
}
