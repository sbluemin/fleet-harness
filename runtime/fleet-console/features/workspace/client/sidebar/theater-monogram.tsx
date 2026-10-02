import "./theater-monogram.css";

const FULL_WIDTH_GLYPH = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}！-｠￠-￦]/u;

/** 글자 선택은 theaterInitials가 맡고, 칩 안의 한 줄 조판만 공유한다. */
export function TheaterMonogram({ children, compact = false }: { readonly children: string; readonly compact?: boolean }) {
  const wide = FULL_WIDTH_GLYPH.test(children);
  return <span className={`theater-monogram${wide ? " is-wide" : ""}${compact ? " is-compact" : ""}`}>{children}</span>;
}
