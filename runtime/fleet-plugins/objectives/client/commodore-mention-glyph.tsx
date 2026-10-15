/**
 * 사령관을 가리키는 작은 기호 — 둥근 판에서 별을 뚫어 낸 모양(evenodd)이다. 사령관 자신의 얼굴은 `CommodoreAvatar` 가 그리고,
 * 이 기호는 「자율 운영」 스위치(Theater 우클릭 메뉴)·사령관의 질문 카드·Theater Inbox 섹션·사령관의 목표 줄 끝 표식처럼
 * 사령관에 관한 것을 표시하는 자리에 선다. 색은 currentColor 로 받고, 크기·색 규칙은 부르는 자리가 className 으로 준다.
 * viewBox 는 정사각으로 둔다.
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

/** 사령관의 목표 줄 끝 표식 — 색(켬·끔)과 크기는 호스트 표식 칸이 정하므로 이 마크의 기본 색 규칙을 싣지 않는다. */
export const renderCommodoreRowGlyph = () => <CommodoreMentionGlyph className="objectives-commodore-row-mark-glyph" />;

/** 맡기지 않은 목표의 줄 끝 표식 — 같은 판과 별의 외곽선. 누르면 사령관에게 맡긴다(호스트가 줄에 올릴 때만 세운다). */
export const renderCommodoreRowGlyphOff = () => (
  <svg className="objectives-commodore-row-mark-glyph" viewBox="0 0 16 16" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.3" d="M5 2.2h6A2.8 2.8 0 0 1 13.8 5v6a2.8 2.8 0 0 1-2.8 2.8H5A2.8 2.8 0 0 1 2.2 11V5A2.8 2.8 0 0 1 5 2.2Z" />
    <path fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" d="M8 4.25 9.01 6.96 11.9 7.08 9.64 8.88 10.41 11.67 8 10.07 5.59 11.67 6.36 8.88 4.1 7.08 6.99 6.96Z" />
  </svg>
);
