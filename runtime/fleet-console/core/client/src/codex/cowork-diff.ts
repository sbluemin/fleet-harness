export interface DraftLine {
  readonly text: string;
  readonly changed: boolean;
}

/** A small, browser-only LCS diff suitable for rendered Cowork drafts. */
export function diffDraftLines(base: string, draft: string): readonly DraftLine[] {
  const before = base.replace(/\r\n/g, "\n").split("\n");
  const after = draft.replace(/\r\n/g, "\n").split("\n");
  const rows = before.length + 1;
  const columns = after.length + 1;
  const lcs = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const result: DraftLine[] = [];
  let i = 0;
  let j = 0;
  while (j < after.length) {
    if (i < before.length && before[i] === after[j]) {
      result.push({ text: after[j]!, changed: false }); i += 1; j += 1;
    } else if (i < before.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      i += 1;
    } else {
      result.push({ text: after[j]!, changed: true }); j += 1;
    }
  }
  return result;
}
