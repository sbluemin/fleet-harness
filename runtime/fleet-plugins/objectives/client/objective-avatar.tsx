import { operationAvatarKey, type MongleRole, type MongleState } from "@fleet-console/sdk/avatars";
import { useMongleLook } from "@fleet-console/sdk/avatars/browser";
import { MongleAvatar } from "@fleet-console/sdk/components/mongle-avatar";

import type { Objective } from "../server/types.js";

/**
 * 목표 표면의 몽글 아바타 — 지휘관과 구성원의 얼굴.
 *
 * 키는 그 사람의 Operation 이다 — 지휘관은 목표 id, 구성원은 구성원 id(곧 그 Operation id)라 사이드바와 같은 모습이 선다.
 * 모습은 Console 의 아바타 책에서 읽기만 한다. 처음 배정은 사이드바가 맡고, 아직 없으면 키에서 정한 베이스다.
 *
 * 표식은 늘 장식이다(aria-hidden) — 이름은 곁의 글자가 말한다. 크기는 자리마다 CSS 가 정한다.
 * 같은 사람이 임무 줄·메뉴·그래프에 여러 번 서므로, 움직임은 명단 한 자리(`still={false}`)에만 두고 나머지는 얼굴과 배지로만 상태를 말한다.
 */
export function ObjectiveAvatar({ operationId, role, state, still = true }: {
  readonly operationId: string;
  readonly role: Extract<MongleRole, "commander" | "member">;
  readonly state: MongleState;
  readonly still?: boolean;
}) {
  const look = useMongleLook(operationAvatarKey(operationId));
  return <MongleAvatar base={look.base} tone={look.tone} role={role} state={state} size={20} label="" decorative className={`objectives-avatar${still ? " is-still" : ""}`} />;
}

/** 보드가 읽는 활동 낱말 → 아바타 상태. 세션이 없거나 사라진 자리(closed·unknown)는 시작 전 얼굴이다. */
export function mongleStateOfActivity(activity: string): MongleState {
  switch (activity) {
    case "running":
    case "background": return "running";
    case "awaiting": return "awaiting";
    case "idle": return "idle";
    case "ended": return "ended";
    default: return "fresh";
  }
}

/** 지휘관의 얼굴 — 사이드바 목표 줄과 같은 우선순위(검토 대기 › 결정 요청 › 자기 활동)다. */
export function commanderMongleState(objective: Objective, ownActivity: string): MongleState {
  if (objective.awaitingReview) return "review";
  if (objective.decisionRequest && !objective.done) return "decision";
  return mongleStateOfActivity(ownActivity);
}
