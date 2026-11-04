/** 지금 값과 제안 문안을 낱말 단위로 맞댄다. 바뀐 부분만 밑줄·취소선으로 남긴다. */
export function wordDiff(before: string, after: string): { readonly before: readonly DiffPiece[]; readonly after: readonly DiffPiece[] } {
  const left = before.split(/(\s+)/);
  const right = after.split(/(\s+)/);
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

export interface DiffPiece {
  text: string;
  readonly mark: "same" | "del" | "ins";
}
