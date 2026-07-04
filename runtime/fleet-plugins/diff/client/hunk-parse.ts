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
  // git diff 출력은 개행으로 끝나므로 split이 만든 마지막 빈 요소는 실제 라인이 아니다 — 거터 번호를 소모하기 전에 제거
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();
  const result: ParsedLine[] = [];

  // 첫 번째 @@ 이전까지 파일 레벨 헤더(diff --git, index, ---, +++ 등) 드롭
  let headerEnd = 0;
  while (headerEnd < rawLines.length && rawLines[headerEnd]?.startsWith("@@") === false) {
    headerEnd++;
  }

  // hunk가 하나도 없는 diff(바이너리 수정, 모드 변경 등)는 파일 헤더 4종만 걷어내고
  // 나머지 정보성 라인("Binary files ... differ" 등)을 라인번호 없는 ctx로 보존한다
  if (headerEnd === rawLines.length) {
    for (const line of rawLines) {
      if (line === "") continue;
      if (
        line.startsWith("diff --git") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      ) {
        continue;
      }
      // 뷰가 unified 프리픽스 1글자(slice(1))를 걷어내므로 ctx 규약대로 앞 공백을 붙인다
      result.push({ kind: "ctx", text: ` ${line}` });
    }
    return result;
  }

  let oldLine = 0;
  let newLine = 0;

  for (const line of rawLines.slice(headerEnd)) {
    // "\ No newline at end of file" — 파일 내용이 아닌 diff 메타 어노테이션이므로 라인번호를 소모하지 않는다
    if (line.startsWith("\\")) continue;

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
