import { theaterAvatarKey, type MongleState } from "@fleet-console/sdk/avatars";
import { useMongleLook } from "@fleet-console/sdk/avatars/browser";
import { MongleAvatar } from "@fleet-console/sdk/components/mongle-avatar";

/**
 * 사령관의 몽글 아바타 — Theater 마다 하나, 베이스 위에 왼쪽 위 brass 별 배지가 얹힌다.
 *
 * 사이드바 사령관 줄의 자율 운영 스위치가 이 아바타를 그리고, Theater 머리 표식 칸(`TheaterContribution.mark`, 18px)도 이 컴포넌트를
 * 그대로 쓸 수 있다. 모습은 Console 의 아바타 책에서 읽는다 — 처음 배정은 사이드바가 맡고, 아직 없으면 Theater 키에서 정한 베이스다.
 */
export function CommodoreAvatar({ theaterId, state, size, label, decorative = false, className }: {
  readonly theaterId: string;
  readonly state: MongleState;
  readonly size: number;
  readonly label: string;
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  const look = useMongleLook(theaterAvatarKey(theaterId));
  return <MongleAvatar base={look.base} tone={look.tone} role="commodore" state={state} size={size} label={label} decorative={decorative} className={className} />;
}
