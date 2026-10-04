/**
 * Quick Launch '@' 덱에서 사령관 행의 정체성 마크 — 덱 행·선택 칩이 같은 이 하나를 그린다.
 *
 * 임시 글리프다: 사이드바 사령관 줄의 켜진 스위치(채운 brass 사각)를 그대로 빌렸다. 최종 글리프는 시안 비교를 거쳐
 * 이 컴포넌트의 본문만 갈아 끼운다. 호스트가 17×17 칸에 svg 를 채워 넣으므로 viewBox 만 정사각으로 둔다.
 */
export function CommodoreMentionGlyph() {
  return (
    <svg className="objectives-commodore-mention-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="3" />
    </svg>
  );
}
