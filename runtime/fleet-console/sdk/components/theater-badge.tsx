export function theaterInitials(label: string): string {
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const graphemes = (value: string) => segmenter ? [...segmenter.segment(value)].map((item) => item.segment) : Array.from(value);
  const words = label.trim().split(/[\s\-_.]+/).filter(Boolean);
  const initials = words.length > 1
    ? words.flatMap((word) => graphemes(word).slice(0, 1))
    : graphemes(label).filter((grapheme) => /[\p{L}\p{N}]/u.test(grapheme));
  return initials.slice(0, 2).join("").toUpperCase() || "--";
}
