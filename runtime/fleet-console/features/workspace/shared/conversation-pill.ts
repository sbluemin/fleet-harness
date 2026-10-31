import type { KeyboardEventHandler, ReactNode } from "react";

export interface ConversationPillOwner {
  readonly kind: "objective" | "commodore" | "surface";
  readonly id: string;
}

/** 원래 주인의 표식과 이름은 남기고, 그 뒤에 붙일 전언 상대와 동작만 건넨다. */
export interface ConversationPillTakeover {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly ownerLabel: string;
  readonly onOwnerPress?: (() => void) | undefined;
  readonly onKeyDown: KeyboardEventHandler<HTMLElement>;
  readonly content: ReactNode;
}

/** 실제 머리를 세운 호스트가 그 본문에만 제공한다. 반환한 해제는 자기 발행만 걷는다. */
export interface ConversationPillPort {
  readonly owner: ConversationPillOwner;
  readonly publish: (takeover: ConversationPillTakeover) => () => void;
}
