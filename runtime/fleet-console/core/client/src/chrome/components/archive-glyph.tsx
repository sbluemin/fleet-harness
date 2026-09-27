/**
 * 보관 글리프(G1 보관 상자) — 캡션·사이드바 칩·우클릭 메뉴·⌘K·모바일·보관함이 같은 모양을 쓴다.
 * 뚜껑과 몸통의 윤곽이 최소화(─)와 확실히 달라 캡션에서 나란히 서도 헷갈리지 않는다.
 * 12단위 상자에 그리고 크기는 부르는 쪽 CSS가 정한다.
 */
export function ArchiveGlyph({ strokeWidth = 1.25 }: { readonly strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.4" y="2" width="9.2" height="2.6" rx=".7" />
      <path d="M2.3 4.6v4.9c0 .5.4.9.9.9h5.6c.5 0 .9-.4.9-.9V4.6M4.8 6.9h2.4" />
    </svg>
  );
}
