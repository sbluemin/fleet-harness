// ─── types ───────────────────────────────────────────────────────────────────

export type HunkLineKind = "hunk-label" | "meta" | "add" | "del" | "ctx" | "file-label";

export interface ParsedLine {
  readonly kind: HunkLineKind;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly oldPath?: string;
}

const KEYWORDS = new Set(["import", "export", "from", "const", "let", "var", "function", "return", "await", "async", "new", "interface", "type", "extends", "implements", "class", "if", "else", "for", "while", "switch", "case", "of", "in", "typeof", "void", "null", "undefined", "true", "false", "as", "default", "throw", "try", "catch", "describe", "it", "expect", "require", "module", "public", "private", "readonly"]);

/** Receives escaped source only; every generated span therefore remains inert markup. */
export function highlightEscapedDiffCode(code: string): string {
  let out = "";
  let i = 0;
  const wrap = (kind: string, value: string) => `<span class="diff-token-${kind}">${value}</span>`;
  while (i < code.length) {
    const char = code[i]!;
    if (char === "&") { const end = code.indexOf(";", i + 1); if (end >= 0) { out += code.slice(i, end + 1); i = end + 1; continue; } }
    if ((char === "/" && code[i + 1] === "/") || char === "#") { out += wrap("comment", code.slice(i)); break; }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char; const start = i++;
      while (i < code.length) { if (code[i] === "\\") { i += 2; continue; } if (code[i++] === quote) break; }
      out += wrap("string", code.slice(start, i)); continue;
    }
    if (/[0-9]/.test(char) && !/[A-Za-z0-9_$]/.test(code[i - 1] ?? "")) { const start = i; while (i < code.length && /[0-9.xXa-fA-F]/.test(code[i]!)) i++; out += wrap("number", code.slice(start, i)); continue; }
    if (/[A-Za-z_$]/.test(char)) { const start = i; while (i < code.length && /[A-Za-z0-9_$]/.test(code[i]!)) i++; const word = code.slice(start, i); out += KEYWORDS.has(word) ? wrap("keyword", word) : /^[A-Z]/.test(word) ? wrap("type", word) : word; continue; }
    if ("{}()[].,;:=<>+-*/&|?!".includes(char)) { out += wrap("punctuation", char); i++; continue; }
    out += char; i++;
  }
  return out;
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
      // 사용자에게 변경 이유를 알려주는 rename/mode 메타데이터는 hunk가 없어도 보존한다.
      if (
        line.startsWith("new file mode") ||
        line.startsWith("deleted file mode") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to ") ||
        line.startsWith("similarity index") ||
        line.startsWith("dissimilarity index")
      ) {
        result.push({ kind: "meta", text: line });
        continue;
      }

      // 순수 Git 헤더 노이즈는 드롭한다.
      if (
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
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
