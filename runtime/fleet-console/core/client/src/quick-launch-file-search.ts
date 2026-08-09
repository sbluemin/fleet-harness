export interface QuickLaunchFileToken {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface PendingPaste {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function parseQuickLaunchFileToken(prompt: string, caret: number): QuickLaunchFileToken | null {
  const before = prompt.slice(0, caret);
  const match = /(?:^|\s)@([^\s]*)$/u.exec(before);
  if (!match) return null;
  const typedQuery = match[1] ?? "";
  const start = caret - typedQuery.length - 1;
  let end = caret;
  while (end < prompt.length && !/\s/u.test(prompt[end] ?? "")) end += 1;
  return { start, end, query: prompt.slice(start + 1, end) };
}

export function isTokenInsideRanges(token: QuickLaunchFileToken, ranges: readonly TextRange[]): boolean {
  return ranges.some((range) => token.start < range.end && token.end > range.start);
}

export function updatePastedRanges(
  previous: string,
  next: string,
  ranges: readonly TextRange[],
  pendingPaste: PendingPaste | null,
): readonly TextRange[] {
  let prefix = 0;
  const prefixLimit = Math.min(previous.length, next.length);
  while (prefix < prefixLimit && previous[prefix] === next[prefix]) prefix += 1;

  let suffix = 0;
  const previousRemaining = previous.length - prefix;
  const nextRemaining = next.length - prefix;
  while (
    suffix < previousRemaining
    && suffix < nextRemaining
    && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix += 1;

  const removedEnd = previous.length - suffix;
  const insertedEnd = next.length - suffix;
  const delta = insertedEnd - removedEnd;
  const transformed = ranges.flatMap((range): TextRange[] => {
    if (removedEnd === prefix && insertedEnd > prefix) {
      if (prefix <= range.start) return [{ start: range.start + delta, end: range.end + delta }];
      if (prefix < range.end) return [{ start: range.start, end: range.end + delta }];
      return [range];
    }
    if (range.end <= prefix) return [range];
    if (range.start >= removedEnd) return [{ start: range.start + delta, end: range.end + delta }];
    const start = Math.min(range.start, prefix);
    const end = Math.max(start, range.end + delta, insertedEnd);
    return end > start ? [{ start, end }] : [];
  });

  if (pendingPaste) {
    const pasteEnd = pendingPaste.start + pendingPaste.text.length;
    transformed.push({ start: pendingPaste.start, end: pasteEnd });
  }
  return mergeRanges(transformed);
}

function mergeRanges(ranges: readonly TextRange[]): readonly TextRange[] {
  const sorted = [...ranges].filter((range) => range.end > range.start).sort((left, right) => left.start - right.start);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push(range);
      continue;
    }
    merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
  }
  return merged;
}
