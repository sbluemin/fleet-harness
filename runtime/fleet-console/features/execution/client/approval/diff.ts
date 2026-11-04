/**
 * 지금 값과 제안 문안을 낱말 단위로 맞댄다. 바뀐 부분만 밑줄·취소선으로 남긴다.
 * 토큰 수 곱이 상한을 넘으면 LCS 표를 만들지 않고, 같은 앞·뒤만 맞추고 가운데는 통째로 지움·추가다.
 */
const MAX_DIFF_CELLS = 160_000;

export function wordDiff(before: string, after: string): { readonly before: readonly DiffPiece[]; readonly after: readonly DiffPiece[] } {
  const left = before.split(/(\s+)/);
  const right = after.split(/(\s+)/);
  if (left.length * right.length > MAX_DIFF_CELLS) return coarseDiff(left, right);
  const scores = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const row = scores[i]!;
      const next = scores[i + 1]!;
      row[j] = left[i] === right[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const beforePieces: DiffPiece[] = [];
  const afterPieces: DiffPiece[] = [];
  let i = 0;
  let j = 0;
  const push = (pieces: DiffPiece[], text: string, mark: DiffPiece["mark"]) => {
    if (!text) return;
    const last = pieces.at(-1);
    if (last && last.mark === mark) last.text += text;
    else pieces.push({ text, mark });
  };
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push(beforePieces, left[i]!, "same");
      push(afterPieces, right[j]!, "same");
      i += 1;
      j += 1;
    } else if (scores[i + 1]![j]! >= scores[i]![j + 1]!) {
      push(beforePieces, left[i]!, /^\s+$/.test(left[i]!) ? "same" : "del");
      i += 1;
    } else {
      push(afterPieces, right[j]!, /^\s+$/.test(right[j]!) ? "same" : "ins");
      j += 1;
    }
  }
  while (i < left.length) { push(beforePieces, left[i]!, /^\s+$/.test(left[i]!) ? "same" : "del"); i += 1; }
  while (j < right.length) { push(afterPieces, right[j]!, /^\s+$/.test(right[j]!) ? "same" : "ins"); j += 1; }
  return { before: beforePieces, after: afterPieces };
}

/** 긴 문안. 같은 앞·뒤를 남기고 가운데는 한 덩어리로 지우고 넣는다. */
function coarseDiff(left: readonly string[], right: readonly string[]): { readonly before: readonly DiffPiece[]; readonly after: readonly DiffPiece[] } {
  let prefix = 0;
  const limit = Math.min(left.length, right.length);
  while (prefix < limit && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;
  const beforePieces: DiffPiece[] = [];
  const afterPieces: DiffPiece[] = [];
  const push = (pieces: DiffPiece[], text: string, mark: DiffPiece["mark"]) => {
    if (!text) return;
    const last = pieces.at(-1);
    if (last && last.mark === mark) last.text += text;
    else pieces.push({ text, mark });
  };
  for (let index = 0; index < prefix; index += 1) {
    push(beforePieces, left[index]!, "same");
    push(afterPieces, right[index]!, "same");
  }
  for (let index = prefix; index < left.length - suffix; index += 1) push(beforePieces, left[index]!, "del");
  for (let index = prefix; index < right.length - suffix; index += 1) push(afterPieces, right[index]!, "ins");
  for (let index = 0; index < suffix; index += 1) {
    const leftAt = left.length - suffix + index;
    const rightAt = right.length - suffix + index;
    push(beforePieces, left[leftAt]!, "same");
    push(afterPieces, right[rightAt]!, "same");
  }
  return { before: beforePieces, after: afterPieces };
}

export interface DiffPiece {
  text: string;
  readonly mark: "same" | "del" | "ins";
}
