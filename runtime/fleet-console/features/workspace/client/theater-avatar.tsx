import { theaterAvatarKey } from "@fleet-console/sdk/avatars";

import { KeyedAvatar } from "./avatars.js";
import { useTheaterContributionFace } from "./theater-contributions.js";

/**
 * Theater 의 아바타 — 그 Theater 사령관의 몽글 아바타다. 얼굴은 사이드바 Theater 머리 표식과 같은 사실에서 온다: 플러그인이
 * 머리 표식과 함께 주는 얼굴(`header.face`)을 읽고, 아무도 주지 않으면 쉼이다. 머리 표식(자기 단추를 품을 수 있다)을 옮겨 심지
 * 않으므로 칩·메뉴 행·팔레트 옵션처럼 단추 안에도 설 수 있고, 크기는 자리에 맞춘다.
 *
 * feature 레지스트리(feature-registry)를 읽으므로 avatars.tsx 밖 자기 모듈에 산다 — 아바타 모듈만 쓰는
 * 실행 본문·단위 테스트가 레지스트리 해석에 끌려가지 않게 한다.
 */
export function TheaterAvatar({ theaterId, size, label, decorative, className }: {
  readonly theaterId: string;
  readonly size: number;
  readonly label: string;
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  const face = useTheaterContributionFace(theaterId);
  // 운영자가 꺼진 사령관은 사이드바 머리 표식과 같은 규칙(`.mongle-avatar.is-off`)으로 흐려진다.
  return <KeyedAvatar avatarKey={theaterAvatarKey(theaterId)} role="commodore" state={face?.state ?? "idle"} off={face?.off} size={size} label={label} decorative={decorative} className={className} />;
}
