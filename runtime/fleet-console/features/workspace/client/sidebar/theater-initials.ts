export function theaterInitials(label: string): string {
  // 하이픈/언더스코어/점도 단어 경계로 취급 — "fleet-harness" → "FH" (재가 시안 문법)
  const words = label.trim().split(/[\s\-_.]+/).filter(Boolean);
  const initials = words.length > 1
    ? words.flatMap((word) => firstGrapheme(word))
    : graphemes(label).filter((grapheme) => /[\p{L}\p{N}]/u.test(grapheme));
  return initials.slice(0, 2).join("").toUpperCase() || "--";
}

function firstGrapheme(value: string): string[] {
  return graphemes(value).slice(0, 1);
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((segment) => segment.segment);
  }
  return Array.from(value);
}
