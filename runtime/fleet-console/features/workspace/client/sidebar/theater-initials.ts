// 사이드바 칩·섹션 머리가 렌더마다 부른다 — 글자 분리(Intl.Segmenter)가 싸지 않아 이름별로 한 번만 계산한다.
const initialsCache = new Map<string, string>();
let segmenter: Intl.Segmenter | null = null;

export function theaterInitials(label: string): string {
  let initials = initialsCache.get(label);
  if (initials === undefined) {
    if (initialsCache.size >= 256) initialsCache.clear();
    initials = computeInitials(label);
    initialsCache.set(label, initials);
  }
  return initials;
}

function computeInitials(label: string): string {
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
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(value)].map((segment) => segment.segment);
  }
  return Array.from(value);
}
