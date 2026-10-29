import type { ReactNode } from "react";
/**
 * Objective이 아닌 새 세션 컴포저 '@' 행선지 하나.
 *
 * '@' 덱은 Objective 카테고리 아래에 이 기여를 `categoryLabel`별로 세운다. 호스트는 라벨의 뜻을
 * 해석하지 않는다 — 어느 플러그인의 무엇인지만 알고, 이름과 능력 문구는 그 표면을 가진 플러그인만
 * 안다.
 *
 * Objective 행선지와 달리 Theater도 활동 상태도 없다. 그래서 행은 상태 배지를 달지 않고,
 * 대신 `capabilityLabel`이 **고르기 전에** 무엇을 할 수 있는 대상인지 말한다 — 바로 윗줄의
 * Objective은 파일을 읽고 이 대상은 못 읽을 수 있어, 능력 차이를 선택 후에 알리면 늦다.
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
  /** 행 머리의 정체성 마크. Objective 행의 Theater 이니셜 자리와 같다. */
  readonly renderMark?: () => ReactNode;
}


export interface ClientComposerCapability {
  /**
   * Brings up the host's new session composer and puts the caret in it. Whether that is the desktop
   * new session screen or the phone's new conversation sheet is the host's business, not the plugin's.
   *
   * `mentionObjectiveId` addresses the composer at that Objective, exactly as typing an `@` mention
   * does. The host still applies its own addressing rules — an Objective that cannot be messaged,
   * or is waiting on its own prompt, is left unaddressed. A mention seed starts a fresh address:
   * leftover unsent draft from a previous close is discarded, not preserved across this open.
   *
   * `draft` seeds the prompt text instead — used to hand a plugin's text (an aide's answer, a
   * snippet) to the composer. It replaces any unsent draft; it never submits.
   */
  // 플러그인 행선지(`mentionTarget`)는 draft를 명시하지 않으면 쓰던 초안을 보존한다.
  open(options?: { readonly mentionObjectiveId?: string; readonly mentionTarget?: MentionTargetAddress; readonly draft?: string }): void;
}
