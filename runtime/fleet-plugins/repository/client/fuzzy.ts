// 대소문자 무시 탐욕(greedy) subsequence 매칭. 인덱스는 Array.from(text) 기준 code-point 단위 —
// 렌더러도 같은 단위로 순회해야 surrogate pair가 깨지지 않는다. 매칭 실패 시 null, 빈 질의는 빈 배열.
export function fuzzyMatch(query: string, text: string): readonly number[] | null {
  const queryChars = Array.from(query.toLowerCase());
  const textChars = Array.from(text);
  const matches: number[] = [];
  let fromIndex = 0;
  for (const character of queryChars) {
    let found = -1;
    for (let index = fromIndex; index < textChars.length; index += 1) {
      if (textChars[index]!.toLowerCase() === character) { found = index; break; }
    }
    if (found < 0) return null;
    matches.push(found);
    fromIndex = found + 1;
  }
  return matches;
}
