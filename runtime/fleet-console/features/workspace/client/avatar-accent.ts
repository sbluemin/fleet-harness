import { useCallback, useMemo, type CSSProperties } from "react";
import { resolveMongleLook, useAvatarBook } from "./avatar-events.js";
import { mongleBase, type AvatarBook } from "../shared/avatars.js";
import type { IdentityTone } from "../shared/identity-tones.js";

/** 아바타 키의 정체성 톤 — 저장된 톤, 없으면 베이스의 원래 색. 대화 강조색과 같은 규칙이라 그 색을 쓰는 표면은 이 함수를 거친다. */
export function avatarToneOf(book: AvatarBook | null, key: string): IdentityTone {
  const look = resolveMongleLook(book, key);
  return look.tone ?? mongleBase(look.base).tone;
}

/** 키마다 톤을 묻는 손잡이 — 한 화면에 아바타가 여럿(탭 그룹 등)일 때 훅을 키 수만큼 부르지 않게. 아바타 편집에 따라 갱신된다. */
export function useAvatarToneOf(): (key: string) => IdentityTone {
  const book = useAvatarBook();
  return useCallback((key: string) => avatarToneOf(book, key), [book]);
}

/** 아바타 편집과 함께 갱신되는 대화 강조색. 상태색·역할 마크와는 별개이며, 키가 없는 표면은 중립으로 남는다. */
export function useAvatarAccent(key: string | null): CSSProperties | undefined {
  const book = useAvatarBook();
  const tone = key === null ? null : avatarToneOf(book, key);
  return useMemo(() => tone === null ? undefined : ({
    "--conversation-accent": `var(--id-${tone})`,
    "--conversation-accent-body": `var(--mongle-${tone})`,
    "--conversation-bubble-fill": `color-mix(in oklab, var(--mongle-${tone}) var(--identity-bubble-body-share, 70%), var(--mongle-face))`,
    "--conversation-human-ink": "var(--text-on-identity)",
    "--conversation-action-ink": "var(--mongle-face)",
    "--conversation-action-idle-opacity": "var(--control-disabled-opacity)",
  } as CSSProperties), [tone]);
}
