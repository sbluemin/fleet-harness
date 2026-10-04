/**
 * Quick Launch '@' 덱에서 사령관 행의 정체성 마크 — 덱 행·선택 칩이 같은 이 하나를 그린다.
 *
 * 둥근 판에서 별을 뚫어 낸 모양(evenodd)이고, 색은 currentColor 로 받아 CSS 가 brass-ink 를 준다. 호스트가 17×17 칸에
 * svg 를 채워 넣으므로 viewBox 는 정사각으로 둔다. 사이드바 사령관 줄의 자율 운영 스위치도 같은 마크를 그리며, 그때는
 * className 으로 스위치 전용 색·크기 규칙을 받는다.
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
