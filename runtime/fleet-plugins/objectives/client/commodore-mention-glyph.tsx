/**
 * Quick Launch '@' 덱에서 사령관 행의 정체성 마크 — 덱 행·선택 칩이 같은 이 하나를 그린다.
 *
 * 둥근 판에서 별을 뚫어 낸 모양(evenodd)이고, 색은 currentColor 로 받아 CSS 가 brass-ink 를 준다. 호스트가 17×17 칸에
 * svg 를 채워 넣으므로 viewBox 는 정사각으로 둔다. 사이드바 사령관 줄의 자율 운영 스위치도 같은 마크를 그리며, 그때는
 * className 으로 스위치 전용 색·크기 규칙을 받는다. 사령관의 목표 줄 끝 표식도 같은 마크이고, 색·크기는 호스트가 준다.
 */
export function CommodoreMentionGlyph({ className = "objectives-commodore-mention-glyph" }: { readonly className?: string } = {}) {
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

/** 사령관의 목표 줄 끝 표식 — 색(켬·끔)과 크기는 호스트 표식 칸이 정하므로 이 마크의 기본 색 규칙을 싣지 않는다. */
export const renderCommodoreRowGlyph = () => <CommodoreMentionGlyph className="objectives-commodore-row-mark-glyph" />;

/** 맡기지 않은 목표의 줄 끝 표식 — 같은 판과 별의 외곽선. 누르면 사령관에게 맡긴다(호스트가 줄에 올릴 때만 세운다). */
export const renderCommodoreRowGlyphOff = () => (
  <svg className="objectives-commodore-row-mark-glyph" viewBox="0 0 16 16" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.3" d="M5 2.2h6A2.8 2.8 0 0 1 13.8 5v6a2.8 2.8 0 0 1-2.8 2.8H5A2.8 2.8 0 0 1 2.2 11V5A2.8 2.8 0 0 1 5 2.2Z" />
    <path fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" d="M8 4.25 9.01 6.96 11.9 7.08 9.64 8.88 10.41 11.67 8 10.07 5.59 11.67 6.36 8.88 4.1 7.08 6.99 6.96Z" />
  </svg>
);
