export interface DraftLine {
  readonly text: string;
  readonly changed: boolean;
}

// LCS 행렬은 before×after 셀만큼 커진다 — 1MB 초안(수만 라인)이면 수백 MB 할당으로
// 브라우저가 멈추므로, 상한을 넘으면 선형(위치 비교) 폴백으로 강등한다.
const MAX_LCS_CELLS = 1 << 20;

/** A small, browser-only LCS diff suitable for rendered Cowork drafts. */
export function diffDraftLines(base: string, draft: string): readonly DraftLine[] {
  const before = base.replace(/\r\n/g, "\n").split("\n");
  const after = draft.replace(/\r\n/g, "\n").split("\n");
  const rows = before.length + 1;
  const columns = after.length + 1;
  if (rows * columns > MAX_LCS_CELLS) {
    return after.map((text, index) => ({ text, changed: before[index] !== text }));
  }
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
