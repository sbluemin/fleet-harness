/*
 * Fleet 브라우저의 별도 도구모음 칸(레일 엔트리 `fleet-browser`)은 걷혔다 — 대화 머리의 지구본 하나가 「Fleet 브라우저 /
 * Session 브라우저」 카드를 열고, ⇧⌘B 는 전역 단축키가 Fleet 브라우저를 바로 여닫는다(app.tsx). 이 파일은 카드·팔레트가 쓰는
 * 글리프만 남긴다.
 */

/**
 * Fleet 브라우저 글리프 — 시안 G1: 지구본 + 바깥 궤도 호.
 * Operation 브라우저의 기존 지구본과 같은 가족의 변주다.
 * 16 격자, stroke 1.35, round cap/join, fill none.
 */
export function FleetBrowserGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="4.6" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M3.4 8h9.2M8 3.4c1.8 1.8 1.8 7.4 0 9.2M8 3.4c-1.8 1.8-1.8 7.4 0 9.2"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <path d="M12.2 3.4a5 5 0 0 1 0 9.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}
