/**
 * 입력창이 답 칸이 되는 동안의 대상 — 한 줄 결정(`commodore-person-inbox.tsx`)이 지금 보는 결정 한 건. 같은 표면의 사령관 입력창이 읽는다.
 */

import type { ComposerQuote } from "../../execution/client/composer-primitives/quotes.js";

export interface CommodoreDecisionTarget {
  /** 입력창 안 머리표 — 결정 종류. */
  readonly kindLabel: string;
  /** 보내는 글에 붙는 인용 — 어느 목표의 어느 항목(종류)인지 사령관이 알아본다. */
  readonly quote: ComposerQuote;
  /**
   * 질문 하나(문항 1개)면 보낸 글이 그 질문의 직접 답이다. 그 밖(기준·검토·후속, 문항이 여럿인 질문)은 null — 글은 결정을 인용한
   * 일반 메시지로 가고 결정 상태는 바뀌지 않는다.
   */
  readonly answer: ((text: string) => Promise<void>) | null;
  /** 입력창 자리표 — 직접 답을 받지 않는 질문(문항이 여럿)은 「직접 답」을 약속하지 않는다. */
  readonly placeholder: string;
}
