import { useMemo, type CSSProperties } from "react";
import { resolveMongleLook, useAvatarBook } from "./avatar-events.js";
import { mongleBase } from "../shared/avatars.js";

/** 아바타 편집과 함께 갱신되는 대화 강조색. 상태색·역할 마크와는 별개이며, 키가 없는 표면은 중립으로 남는다. */
export function useAvatarAccent(key: string | null): CSSProperties | undefined {
  const book = useAvatarBook();
  const look = key === null ? null : resolveMongleLook(book, key);
  const tone = look === null ? null : look.tone ?? mongleBase(look.base).tone;
  return useMemo(() => tone === null ? undefined : ({
    "--conversation-accent": `var(--id-${tone})`,
    "--conversation-accent-body": `var(--mongle-${tone})`,
    "--conversation-human-ink": "var(--mongle-face)",
  } as CSSProperties), [tone]);
}
