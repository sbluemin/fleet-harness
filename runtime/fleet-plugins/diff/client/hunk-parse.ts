// ─── types ───────────────────────────────────────────────────────────────────

export type HunkLineKind = "hunk-label" | "add" | "del" | "ctx";

export interface ParsedLine {
  readonly kind: HunkLineKind;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

// ─── constants ───────────────────────────────────────────────────────────────

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/;

// ─── functions ───────────────────────────────────────────────────────────────

export function parseHunk(content: string): ParsedLine[] {
  if (!content) return [];

  const rawLines = content.split("\n");
  const result: ParsedLine[] = [];

  // 첫 번째 @@ 이전까지 파일 레벨 헤더(diff --git, index, ---, +++ 등) 드롭
  let headerEnd = 0;
  while (headerEnd < rawLines.length && rawLines[headerEnd]?.startsWith("@@") === false) {
    headerEnd++;
  }

  let oldLine = 0;
  let newLine = 0;

  for (const line of rawLines.slice(headerEnd)) {
    if (line.startsWith("@@")) {
      const m = HUNK_HEADER_RE.exec(line);
      if (m) {
        oldLine = parseInt(m[1] ?? "0", 10);
        newLine = parseInt(m[2] ?? "0", 10);
        const suffix = m[3]?.trimEnd() ?? "";
        const label = `@@ -${m[1] ?? ""} +${m[2] ?? ""} @@${suffix ? ` ${suffix.trimStart()}` : ""}`;
        result.push({ kind: "hunk-label", text: label });
      } else {
        result.push({ kind: "hunk-label", text: line });
      }
      continue;
    }

    if (line.startsWith("+")) {
      result.push({ kind: "add", text: line, newLine: newLine++ });
    } else if (line.startsWith("-")) {
      result.push({ kind: "del", text: line, oldLine: oldLine++ });
    } else {
      // ctx: 컨텍스트 라인 또는 Binary 라인 등 — 크래시 없이 통과
      result.push({ kind: "ctx", text: line, oldLine: oldLine++, newLine: newLine++ });
    }
  }

  return result;
}
