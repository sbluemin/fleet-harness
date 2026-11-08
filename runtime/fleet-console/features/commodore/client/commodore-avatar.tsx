import { commodoreAvatarKey, type MongleActivity, type MongleState } from "../../workspace/shared/avatars.js";
import { useMongleLook } from "../../workspace/client/avatar-events.js";
import { MongleAvatar } from "../../workspace/client/components/mongle-avatar.js";
import { useCommodore } from "./commodore-state.js";

/**
 * 사령관의 몽글 아바타 — 사령관(UUID)마다 하나, 베이스 위에 왼쪽 위 brass 별 배지가 얹힌다.
 *
 * 사이드바 사령관 머리 표식 칸(`TheaterContribution.mark`, 18px)이 이 아바타를 그린다. 모습은 Console 의 아바타 책에서 읽는다 —
 * 처음 배정은 사이드바가 맡고, 아직 없으면 사령관 키에서 정한 베이스다. 작업 중일 때의 연기는 지휘관과 같은 계열(`run.step`)이다.
 */

/**
 * 도는 턴의 계열 — 지휘관 아바타의 `useObjectiveMongleActivity`와 같은 구독 형태다. 턴이 아니면 null(쉼)이다.
 * `run.step`은 기록을 열지 않는 표면(사이드바 머리 표식)까지 닿으므로, 대화를 열지 않아도 연기가 흐른다.
 */
export function useCommodoreMongleActivity(commodoreId: string | null | undefined): MongleActivity | null {
  const { view } = useCommodore(commodoreId ?? null);
  if (!view || view.run.phase !== "turn") return null;
  return view.run.step ?? null;
}

export function CommodoreAvatar({ commodoreId, state, size, label, decorative = false, className, figure }: {
  readonly commodoreId: string;
  readonly state: MongleState;
  readonly size: number;
  readonly label: string;
  readonly decorative?: boolean;
  readonly className?: string;
  /** 진급 사령관을 견장·날개 윗부분과 날개짓까지 그린다 — 사이드바 목록 행의 큰 얼굴 전용. */
  readonly figure?: boolean;
}) {
  const look = useMongleLook(commodoreAvatarKey(commodoreId));
  // 작업 중일 때만 턴의 계열을 연기로 싣는다 — 지휘관 `ObjectiveAvatar`와 같은 조건이다.
  const activity = useCommodoreMongleActivity(state === "running" ? commodoreId : null);
  return <MongleAvatar base={look.base} tone={look.tone} role="commodore" state={state} activity={activity} size={size} label={label} decorative={decorative} className={className} figure={figure} />;
}
