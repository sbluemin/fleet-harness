import type { ReactNode } from "react";
import type { ComposerQuote, ComposerQuoteAttachResult, ComposerQuoteTarget } from "../client/composer-primitives/quotes.js";
/**
 * Operation이 아닌 새 세션 컴포저 '@' 행선지 하나.
 *
 * '@' 덱은 Operation 카테고리 아래에 이 기여를 `categoryLabel`별로 세운다. 호스트는 라벨의 뜻을
 * 해석하지 않는다 — 어느 플러그인의 무엇인지만 알고, 이름과 능력 문구는 그 표면을 가진 플러그인만
 * 안다.
 *
 * Operation 행선지와 달리 Theater도 활동 상태도 없다. 그래서 행은 상태 배지를 달지 않고,
 * 대신 `capabilityLabel`이 **고르기 전에** 무엇을 할 수 있는 대상인지 말한다 — 바로 윗줄의
 * Operation은 파일을 읽고 이 대상은 못 읽을 수 있어, 능력 차이를 선택 후에 알리면 늦다.
 */
/** 플러그인 행선지의 불투명 좌표. 이름·대화·권한은 계속 플러그인이 소유한다. */
export interface MentionTargetAddress {
  readonly pluginId: string;
  readonly targetId: string;
}


export interface MentionTargetDescriptor {
  /** 플러그인 안에서 고유한 id. 호스트는 `${pluginId}:${id}`로 이름공간을 나눠 쓴다. */
  readonly id: string;
  /** 행에 보이는 이름. 사용자가 '@' 뒤에 타이핑해 거르는 값이기도 하다. */
  readonly label: string;
  /** 카테고리 밴드 문구. 같은 값을 가진 행끼리 한 카테고리로 묶인다. */
  readonly categoryLabel: string;
  /** 카테고리 머리와 행 배지에 함께 서는 짧은 능력 문구(예: "웹 전용"). */
  readonly capabilityLabel?: string;
  /** 보조 기술에 읽히는 긴 설명. 능력 한계를 여기서 완전한 문장으로 말한다. 검색은 이 문장을 읽지 않는다. */
  readonly description?: string;
  /**
   * 행에 보이지 않지만 '@' 검색이 이 행을 찾는 데 쓰는 말 — 표시 이름이 사용자가 아는 다른 이름을 가릴 때
   * (별칭에 가려진 원래 이름 등) 그 이름을 싣는다. 번역 문장이 아니라 이름 낱말이어야 엉뚱한 일치가 없다.
   * 구버전 호스트는 이 필드를 읽지 않는다(apiVersion 은 같다) — 없으면 `label` 로만 찾힌다.
   */
  readonly keywords?: readonly string[];
  /** 행 머리의 정체성 마크. Operation 행의 Theater 이니셜 자리와 같다. */
  readonly renderMark?: () => ReactNode;
}


export interface ClientComposerCapability {
  /**
   * Brings up the host's new session composer and puts the caret in it. Whether that is the desktop
   * new session screen or the phone's new conversation sheet is the host's business, not the plugin's.
   *
   * `mentionOperationId` addresses the composer at that Operation, exactly as typing an `@` mention
   * does. The host still applies its own addressing rules — an Operation that cannot be messaged,
   * or is waiting on its own prompt, is left unaddressed. A mention seed starts a fresh address:
   * leftover unsent draft from a previous close is discarded, not preserved across this open.
   *
   * `draft` seeds the prompt text instead — used to hand a plugin's text (an aide's answer, a
   * snippet) to the composer. It replaces any unsent draft; it never submits.
   */
  // 플러그인 행선지(`mentionTarget`)는 draft를 명시하지 않으면 쓰던 초안을 보존한다.
  open(options?: { readonly mentionOperationId?: string; readonly mentionTarget?: MentionTargetAddress; readonly draft?: string }): void;
  /**
   * 고른 문장을 받는 쪽 입력창의 초안에 인용 칩으로 붙인다 — 이미지 첨부와 같은 자리다. 보내지 않는다: 발사는 언제나 사람의 Enter 다.
   * 받는 쪽은 채팅 모드 Operation 이거나 `receiveQuotes` 로 나선 플러그인의 대상이다. 입력창이 화면에 없어도 초안에 남아,
   * 그 대화를 열면 칩이 서 있다. 받을 수 없는 곳이면 `unavailable`.
   */
  attachQuote?(target: ComposerQuoteTarget, quote: ComposerQuote): ComposerQuoteAttachResult;
  /** 이 Theater 에서 지금 인용을 받을 수 있는 곳 — 채팅 모드 지휘관과, 나선 플러그인의 대상(사령관 등). */
  quoteTargets?(theaterId: string): readonly ComposerQuoteTargetOption[];
  /** `quoteTargets`·`attachQuote` 가 다른 답을 낼 수 있을 때 깨운다(Operation 목록·플러그인 대상이 바뀜). */
  subscribeQuoteTargets?(listener: () => void): () => void;
  /**
   * 플러그인이 자기 비-Operation 대상(예: 사령관)의 인용을 받겠다고 나선다. `targets` 는 그 Theater 에서 지금 받을 수 있는 대상,
   * `receive` 는 붙이기 — 플러그인이 자기 초안에 칩을 세우고 결과를 돌려준다. 돌려준 함수로 물러난다.
   */
  receiveQuotes?(pluginId: string, receiver: ComposerQuoteReceiver): () => void;
}


/** 인용을 받을 수 있는 곳 하나. */
export interface ComposerQuoteTargetOption {
  readonly target: ComposerQuoteTarget;
  readonly label: string;
  /** 「사령관」·「지휘관」처럼 줄을 묶는 이름. */
  readonly group: "commodore" | "commander";
  /**
   * 지금 화면에 선 대화면 true — 붙일 곳의 기본값이다. 한 목록에 많아야 하나다: 플러그인 대상이 지금 열려 있다고 알리면
   * 그 대상이 서고 Operation 은 서지 않는다.
   */
  readonly current?: boolean;
}


export interface ComposerQuoteReceiver {
  /** `current` 는 그 대상의 대화가 지금 화면에 서 있을 때만 true 로 싣는다(예: 가운데 칸에 연 사령관 대화). */
  readonly targets: (theaterId: string) => readonly { readonly targetId: string; readonly label: string; readonly current?: boolean }[];
  readonly receive: (targetId: string, quote: ComposerQuote) => ComposerQuoteAttachResult;
  /** 대상 목록이 바뀌면 깨운다. */
  readonly subscribe?: (listener: () => void) => () => void;
}
