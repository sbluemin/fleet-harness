import type { ReactElement, SVGProps } from "react";

/**
 * 라우팅 선택의 글리프 — 모델 메뉴·트리거·표식이 이 하나만을 쓴다.
 * 색은 호출부가 `fc-coord-route`(기존 `--aurora`)로 얹는다. 글리프 자체는 currentColor다.
 */
export function RoutingGlyph(props: SVGProps<SVGSVGElement>): ReactElement {
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
