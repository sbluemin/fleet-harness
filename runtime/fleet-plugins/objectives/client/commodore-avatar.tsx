import { theaterAvatarKey, type MongleState } from "@fleet-console/sdk/avatars";
import { useMongleLook } from "@fleet-console/sdk/avatars/browser";
import { MongleAvatar } from "@fleet-console/sdk/components/mongle-avatar";

/**
 * 사령관의 몽글 아바타 — Theater 마다 하나, 베이스 위에 왼쪽 위 brass 별 배지가 얹힌다.
 *
 * 사이드바 Theater 머리 표식 칸(`TheaterContribution.mark`, 18px)이 이 아바타를 그린다. 모습은 Console 의 아바타 책에서 읽는다 —
 * 처음 배정은 사이드바가 맡고, 아직 없으면 Theater 키에서 정한 베이스다.
 */
export function CommodoreAvatar({ theaterId, state, size, label, decorative = false, off = false, className }: {
  readonly theaterId: string;
  readonly state: MongleState;
  readonly size: number;
  readonly label: string;
  readonly decorative?: boolean;
  /** 자율 운영이 꺼진 사령관 — 호스트의 공유 규칙(`.mongle-avatar.is-off`)으로 흐려진다. */
  readonly off?: boolean;
  readonly className?: string;
}) {
  const look = useMongleLook(theaterAvatarKey(theaterId));
  return <MongleAvatar base={look.base} tone={look.tone} role="commodore" state={state} size={size} label={label} decorative={decorative} off={off} className={className} />;
}
