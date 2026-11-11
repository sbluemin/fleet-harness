import type { ReactElement, SVGProps } from "react";

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
