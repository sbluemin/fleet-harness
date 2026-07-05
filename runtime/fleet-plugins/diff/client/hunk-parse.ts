// ─── types ───────────────────────────────────────────────────────────────────

export type HunkLineKind = "hunk-label" | "add" | "del" | "ctx" | "file-label";

export interface ParsedLine {
  readonly kind: HunkLineKind;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly oldPath?: string;
}

// ─── constants ───────────────────────────────────────────────────────────────

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/;
const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

// ─── functions ───────────────────────────────────────────────────────────────

export function parseHunk(content: string): ParsedLine[] {
  if (!content) return [];

  const rawLines = content.split("\n");
  // git diff 출력은 개행으로 끝나므로 split이 만든 마지막 빈 요소는 실제 라인이 아니다 — 거터 번호를 소모하기 전에 제거
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();
  const result: ParsedLine[] = [];

  let oldLine = 0;
  let newLine = 0;
  // 현재 파일 헤더 구간(diff --git ~ 첫 @@ 이전)인지
  let inHeader = true;

  for (const line of rawLines) {
    // "\ No newline at end of file" — 파일 내용이 아닌 diff 메타 어노테이션이므로 라인번호를 소모하지 않는다
    if (line.startsWith("\\")) continue;

    if (line.startsWith("diff --git ")) {
      // 새 파일 블록 시작 — b/ 경로를 파일 레이블로 삽입
      const m = DIFF_GIT_RE.exec(line);
      const oldPath = m?.[1];
      const newPath = m?.[2] ?? line;
      const oldPathField = (oldPath !== undefined && oldPath !== newPath) ? oldPath : undefined;
      result.push({ kind: "file-label", text: newPath, oldPath: oldPathField });
      inHeader = true;
      continue;
    }

    if (inHeader) {
      // diff --git ~ @@ 이전 헤더 라인 드롭(index, ---, +++, mode 변경 등)
      if (
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file mode") ||
        line.startsWith("deleted file mode") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to ") ||
        line.startsWith("similarity index") ||
        line.startsWith("dissimilarity index")
      ) {
        continue;
      }

      if (!line.startsWith("@@")) {
        // 헤더 구간의 알 수 없는 라인("Binary files ... differ" 등) — ctx로 보존
        if (line !== "") {
          // 뷰가 unified 프리픽스 1글자(slice(1))를 걷어내므로 ctx 규약대로 앞 공백을 붙인다
          result.push({ kind: "ctx", text: ` ${line}` });
        }
        continue;
      }
    }

    if (line.startsWith("@@")) {
      inHeader = false;
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
