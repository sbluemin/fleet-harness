/**
 * Shell 종류 마크 — 화면 + 프롬프트 stroke 글리프 하나.
 *
 * Shell Operation은 에이전트 턴 축을 발행하지 않는다. 그래서 호스트 크롬이 Shell 자리에
 * 활동 비콘(초록 유휴 발광 / 중공 종료 사각)을 그리면 그건 없는 상태를 있는 것처럼 말하는
 * 것이다. 그 자리를 이 글리프가 대신한다 — 상태가 아니라 정체성이므로 살아있든 종료됐든
 * 같은 그림이다.
 *
 * 크기·색은 소비처가 CSS로 정한다(글리프에는 width/height·색 속성이 없다). 터미널 플러그인의
 * 실행 아이콘과 Console 크롬의 종류 마크가 같은 획을 쓰도록 SDK가 유일한 원본을 갖는다.
 */
export function ShellGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.8" y="3.4" width="10.4" height="9.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.15" />
      <path d="M5 6.6 6.8 8.4 5 10.2M8.4 10.2h2.8" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
