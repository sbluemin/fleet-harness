import type { ReactElement, SVGProps } from "react";

/**
 * 사령관 표시에 쓰는 작은 기호 — 색은 currentColor 로 받고, 크기·색 규칙은 부르는 자리가 className·props 로 준다.
 * 사령관 자신의 얼굴은 `CommodoreAvatar` 가 그린다.
 */

/**
 * 사령관을 가리키는 작은 기호 — 둥근 판에서 별을 뚫어 낸 모양(evenodd)이다. 사령관 자신의 얼굴은 `CommodoreAvatar` 가 그리고,
 * 이 기호는 「자율 운영」 스위치(Theater 우클릭 메뉴)·사령관의 질문 카드·Theater Inbox 섹션처럼 사령관에 관한 것을 표시하는 자리에 선다.
 * 색은 currentColor 로 받고, 크기·색 규칙은 부르는 자리가 className 으로 준다. viewBox 는 정사각으로 둔다.
 */
export function CommodoreMentionGlyph({ className }: { readonly className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M5 1.5h6A3.5 3.5 0 0 1 14.5 5v6a3.5 3.5 0 0 1-3.5 3.5H5A3.5 3.5 0 0 1 1.5 11V5A3.5 3.5 0 0 1 5 1.5ZM8 4.25 9.01 6.96 11.9 7.08 9.64 8.88 10.41 11.67 8 10.07 5.59 11.67 6.36 8.88 4.1 7.08 6.99 6.96Z"
      />
    </svg>
  );
}

/**
 * 「라우팅」의 글리프 — 지휘관 모델 선택기의 행과 트리거가 이 하나만 쓴다. 한 점에서 여러 갈래로 나뉘어 하나를 고르는 모양이다.
 * 색은 호출부가 `objectives-commodore-judgment`(`--aurora`)로 얹는다. 글리프 자체는 currentColor다.
 */
export function CommodoreJudgmentGlyph(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <circle cx="3.6" cy="8" r="1.6" />
      <path d="M5.2 8h2.3M7.5 8c1.6 0 2-4.2 3.8-4.2M7.5 8c1.6 0 2 4.2 3.8 4.2" />
      <circle cx="12.9" cy="3.8" r="1.25" />
      <circle cx="12.9" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12.9" cy="12.2" r="1.25" />
    </svg>
  );
}

export function CommodoreJudgmentMark(): ReactElement {
  return <span className="objectives-commodore-judgment" aria-hidden="true"><CommodoreJudgmentGlyph /></span>;
}
