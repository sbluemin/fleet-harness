import type { ReactNode } from "react";

import type { LocalizedText } from "../i18n/types.js";

/**
 * 온보딩 기여 — Console 코어 기능과 플러그인이 같은 계약으로 자기 온보딩을 등록한다.
 *
 * 등록한 쪽이 문구·앵커·일러스트의 단일 원천이고, 호스트 엔진은 내용을 모른 채 순서만 소유한다:
 * 웰컴(한 장의 카드 속 슬라이드) → 엔트리 힌트 → 투어, 각 단계 안에서는 코어 기여가 플러그인 기여보다 먼저다.
 * 본 기록은 사용자 설정(seenFeatureTours)에 키로 남고, 키는 아래 규칙으로 기여에서 파생된다.
 */
export interface OnboardingContribution {
  /** 기여 이름 공간. 웰컴·힌트의 기본 본 기록 키가 여기서 파생된다(`<id>.welcome`, `<id>.rail-hint`). */
  readonly id: string;
  readonly welcome?: OnboardingWelcomeSlide;
  readonly entryHint?: OnboardingEntryHint;
  readonly tours?: readonly OnboardingTour[];
}

/**
 * 업데이트로 새로 생긴 기능을 기존 사용자에게 알리는 슬라이드. 호스트는 안 본 슬라이드만 모아 카드 한 장으로 넘겨 보이고,
 * 처음 설치한 사용자에게는 보이지 않는다 — 그들에게는 설치 시점의 기능이 전부 처음이라 "새로 생겼다"가 성립하지 않는다.
 */
export interface OnboardingWelcomeSlide {
  readonly title: LocalizedText;
  readonly body: LocalizedText;
  /** 이 기능을 어디서 이어서 익히는지 — 보통 엔트리 힌트나 투어가 받는 자리를 가리킨다. */
  readonly next?: LocalizedText;
  /** 테마 토큰만 쓰는 일러스트. */
  readonly art?: () => ReactNode;
  /** 이미 배포된 키를 이어 쓸 때만 지정한다. 기본값 `<id>.welcome`. */
  readonly seenKey?: string;
}

/** 아직 열어 본 적 없는 우측 레일 진입점 옆에 한 번 서는 말풍선. 진입점을 열거나 닫으면 본 것이다. */
export interface OnboardingEntryHint {
  readonly railEntryId: string;
  readonly title: LocalizedText;
  readonly body: LocalizedText;
  /** 단축키 표기를 곁들일 Console 단축키 명령 id. */
  readonly shortcutCommandId?: string;
  /** 이미 배포된 키를 이어 쓸 때만 지정한다. 기본값 `<id>.rail-hint`. */
  readonly seenKey?: string;
}

/**
 * 화면 안의 컨트롤을 차례로 짚는 투어. 본 기록 키는 `<tour.id>.walkthrough` / `<tour.id>.spotlight`이므로
 * 투어 id는 Console 전체에서 유일해야 하고, 한 번 배포한 id는 바꾸지 않는다.
 *
 * 발동은 첫 non-null 앵커가 화면에 선 순간이다. 앵커는 등록한 쪽이 소유한 DOM을 짚는 CSS 선택자이고,
 * 다른 번들의 DOM을 짚어야 할 때는 그 번들이 세운 의미 속성으로만 짚는다.
 */
export interface OnboardingTour {
  readonly id: string;
  /** 존재만 알리는 한 스텝. 워크스루를 끝내면 함께 본 것으로 친다. */
  readonly spotlight?: OnboardingTourStep | null;
  readonly walkthrough: readonly OnboardingTourStep[];
  /** 다른 투어를 막 끝낸 화면에서는 시작하지 않고, 그 화면을 떠난 다음 방문에 선다. */
  readonly deferAfterAnotherTour?: boolean;
}

export interface OnboardingTourStep {
  readonly anchor: string | null;
  readonly title: LocalizedText;
  readonly body: LocalizedText;
  /** 사용법을 한 문장으로 보이는 예시(프롬프트 등). */
  readonly example?: LocalizedText;
}
