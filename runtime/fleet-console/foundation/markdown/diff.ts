// 렌더 문서 관점의 순수 블록/라인 diff. DOM·Node 의존이 없어 브라우저(Cowork·Codex
// 리더)와 호스트(드라이독 diffstat)가 같은 구현을 공유한다 — 구현을 어느 한쪽에
// 복제하지 말 것.
export interface DraftLine {
  readonly text: string;
  readonly changed: boolean;
}

// LCS 행렬은 before×after 셀만큼 커진다 — 1MB 초안(수만 라인)이면 수백 MB 할당으로
// 브라우저가 멈추므로, 상한을 넘으면 선형(위치 비교) 폴백으로 강등한다.
const MAX_LCS_CELLS = 1 << 20;

export interface SnippetDiffLine {
  readonly text: string;
  readonly sign: " " | "+" | "-";
  /** 제공된 발췌 안의 위치다. 실제 파일 행 번호라고 주장하지 않는다. */
  readonly before?: number;
  readonly after?: number;
}

/** 렌더된 초안과 상한 있는 도구 old/new 입력 비교가 같은 LCS 정렬을 쓴다. */
export function diffSnippetLines(base: string, draft: string): readonly SnippetDiffLine[] {
  const before = base.replace(/\r\n/g, "\n").split("\n");
  const after = draft.replace(/\r\n/g, "\n").split("\n");
  const rows = before.length + 1;
  const columns = after.length + 1;
  if (rows * columns > MAX_LCS_CELLS) {
    return [
      ...before.map((text, index) => ({ sign: "-" as const, text, before: index + 1 })),
      ...after.map((text, index) => ({ sign: "+" as const, text, after: index + 1 })),
    ];
  }
  const lcs = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const result: SnippetDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      result.push({ sign: " ", text: before[i]!, before: i + 1, after: j + 1 }); i += 1; j += 1;
    } else if (i < before.length && (j >= after.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      result.push({ sign: "-", text: before[i]!, before: i + 1 }); i += 1;
    } else {
      result.push({ sign: "+", text: after[j]!, after: j + 1 }); j += 1;
    }
  }
  return result;
}

/** 렌더된 Cowork 초안에 맞는 작은 브라우저 전용 LCS diff. */
export function diffDraftLines(base: string, draft: string): readonly DraftLine[] {
  const before = base.replace(/\r\n/g, "\n").split("\n");
  const after = draft.replace(/\r\n/g, "\n").split("\n");
  if ((before.length + 1) * (after.length + 1) > MAX_LCS_CELLS) {
    return after.map((text, index) => ({ text, changed: before[index] !== text }));
  }
  return diffSnippetLines(base, draft)
    .filter((row) => row.sign !== "-")
    .map((row) => ({ text: row.text, changed: row.sign === "+" }));
}

export interface DraftBlock {
  readonly markdown: string;
  readonly kind: "same" | "added" | "removed";
}

/**
 * 마크다운 블록 단위 diff — 사용자에게는 소스 라인이 아니라 "렌더된 문서에서 어느
 * 문단/코드블록이 바뀌었는가"를 보여주기 위한 것. 수정된 블록은 removed(구) 다음
 * added(신) 순서로 나오고, 인접한 같은 종류의 블록은 하나의 런으로 합쳐진다.
 */
export function diffDraftBlocks(base: string, draft: string): readonly DraftBlock[] {
  const before = splitMarkdownBlocks(base);
  const after = splitMarkdownBlocks(draft);
  const rows = before.length + 1;
  const columns = after.length + 1;
  const result: DraftBlock[] = [];
  if (rows * columns > MAX_LCS_CELLS) {
    const max = Math.max(before.length, after.length);
    for (let k = 0; k < max; k += 1) {
      const b = before[k];
      const a = after[k];
      if (a !== undefined && a === b) result.push({ markdown: a, kind: "same" });
      else {
        if (b !== undefined) result.push({ markdown: b, kind: "removed" });
        if (a !== undefined) result.push({ markdown: a, kind: "added" });
      }
    }
    return mergeBlockRuns(result);
  }
  const lcs = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      result.push({ markdown: after[j]!, kind: "same" }); i += 1; j += 1;
    } else if (i < before.length && (j >= after.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      result.push({ markdown: before[i]!, kind: "removed" }); i += 1;
    } else {
      result.push({ markdown: after[j]!, kind: "added" }); j += 1;
    }
  }
  return mergeBlockRuns(result);
}

// 코드펜스 내부의 빈 줄로는 블록을 쪼개면 안 된다 — 펜스 상태를 추적하며 분할한다.
function splitMarkdownBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!fence && trimmed === "") {
      if (current.length) { blocks.push(current.join("\n")); current = []; }
      continue;
    }
    current.push(line);
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null;
    } else {
      const open = trimmed.match(/^(`{3,}|~{3,})/);
      if (open) fence = open[1]!;
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

function mergeBlockRuns(blocks: readonly DraftBlock[]): DraftBlock[] {
  const merged: DraftBlock[] = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    if (last && last.kind === block.kind) {
      merged[merged.length - 1] = { markdown: `${last.markdown}\n\n${block.markdown}`, kind: last.kind };
    } else {
      merged.push(block);
    }
  }
  return merged;
}
