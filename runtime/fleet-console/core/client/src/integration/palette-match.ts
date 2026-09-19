/**
 * 팔레트 공용 매칭. 명령 모드와 검색 모드가 같은 규칙을 쓴다 — 모듈을 따로 둔 이유는
 * operation-search.ts와 palette-commands.ts가 서로를 끌어오지 않게 하기 위해서다.
 */

export interface PaletteCommandMatch {
  readonly score: number;
  readonly exactTokens: number;
  readonly matchedIndices: readonly number[];
}

export function searchTokens(query: string): readonly string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

export function fuzzyMatchPaletteLabel(label: string, query: string): PaletteCommandMatch | null {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return null;
  const { foldedLabel, foldMap } = foldPaletteLabel(label);
  const matchedIndices = new Set<number>();
  let score = 0;
  let exactTokens = 0;

  for (const token of tokens) {
    const exactStart = findBestExactStart(foldedLabel, token, label, foldMap);
    const foldedTokenIndices: number[] = [];
    if (exactStart !== -1) {
      for (let offset = 0; offset < token.length; offset += 1) {
        foldedTokenIndices.push(exactStart + offset);
      }
      score += 100;
      exactTokens += 1;
    } else {
      let searchFrom = 0;
      for (const character of token) {
        const matchedIndex = foldedLabel.indexOf(character, searchFrom);
        if (matchedIndex === -1) return null;
        for (let characterOffset = 0; characterOffset < character.length; characterOffset += 1) {
          foldedTokenIndices.push(matchedIndex + characterOffset);
        }
        searchFrom = matchedIndex + character.length;
      }
    }

    const tokenIndices = foldMap === null
      ? foldedTokenIndices
      : foldedTokenIndices
        .map((foldedIndex) => foldMap[foldedIndex]!)
        .filter((originalIndex, index, indices) => index === 0 || originalIndex !== indices[index - 1]);
    const scoreText = foldMap === null ? foldedLabel : label;
    for (let index = 0; index < tokenIndices.length; index += 1) {
      const matchedIndex = tokenIndices[index]!;
      const previousMatchedIndex = tokenIndices[index - 1];
      score += previousMatchedIndex !== undefined && matchedIndex === previousMatchedIndex + 1 ? 3 : 1;
      if (matchedIndex === 0 || scoreText[matchedIndex - 1] === " ") score += 2;
      if (foldMap !== null) matchedIndices.add(matchedIndex);
    }
  }

  return {
    score: score - label.length * 0.01,
    exactTokens,
    matchedIndices: [...matchedIndices].sort((left, right) => left - right),
  };
}

function foldPaletteLabel(label: string): {
  readonly foldedLabel: string;
  readonly foldMap: readonly number[] | null;
} {
  const foldedLabel = label.toLocaleLowerCase();
  if (label.length > 2_000) {
    return { foldedLabel, foldMap: null };
  }

  const foldMap: number[] = [];
  let previousPrefixLength = 0;
  for (let originalIndex = 0; originalIndex < label.length; originalIndex += 1) {
    const nextPrefixLength = label.slice(0, originalIndex + 1).toLocaleLowerCase().length;
    for (let foldedIndex = previousPrefixLength; foldedIndex < nextPrefixLength; foldedIndex += 1) {
      foldMap.push(originalIndex);
    }
    previousPrefixLength = nextPrefixLength;
  }
  return foldMap.length === foldedLabel.length
    ? { foldedLabel, foldMap }
    : { foldedLabel, foldMap: null };
}

function findBestExactStart(
  foldedLabel: string,
  token: string,
  label: string,
  foldMap: readonly number[] | null,
): number {
  let firstStart = -1;
  let searchFrom = 0;
  while (searchFrom <= foldedLabel.length - token.length) {
    const start = foldedLabel.indexOf(token, searchFrom);
    if (start === -1) break;
    if (firstStart === -1) firstStart = start;
    const boundaryIndex = foldMap?.[start] ?? start;
    const boundaryText = foldMap === null ? foldedLabel : label;
    if (boundaryIndex === 0 || boundaryText[boundaryIndex - 1] === " ") return start;
    searchFrom = start + 1;
  }
  return firstStart;
}

