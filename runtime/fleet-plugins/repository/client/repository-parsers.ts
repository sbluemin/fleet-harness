import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import type { LogCommitEntry, RepoCandidate } from "../server/types.js";
import { getT } from "./i18n/index.js";

// ═══ fuzzy ═══════════════════════════════════════════════════════════════════

// 대소문자 무시 탐욕(greedy) subsequence 매칭. 인덱스는 Array.from(text) 기준 code-point 단위 —
// 렌더러도 같은 단위로 순회해야 surrogate pair가 깨지지 않는다. 매칭 실패 시 null, 빈 질의는 빈 배열.
export function fuzzyMatch(query: string, text: string): readonly number[] | null {
  const queryChars = Array.from(query.toLowerCase());
  const textChars = Array.from(text);
  const matches: number[] = [];
  let fromIndex = 0;
  for (const character of queryChars) {
    let found = -1;
    for (let index = fromIndex; index < textChars.length; index += 1) {
      if (textChars[index]!.toLowerCase() === character) { found = index; break; }
    }
    if (found < 0) return null;
    matches.push(found);
    fromIndex = found + 1;
  }
  return matches;
}

// ═══ log-parse ═══════════════════════════════════════════════════════════════

// ─── types ───────────────────────────────────────────────────────────────────

export type RefBadgeKind = "head" | "tag" | "branch" | "remote" | "worktree";

export interface RefBadge {
  readonly label: string;
  readonly kind: RefBadgeKind;
  readonly hasRemote?: boolean;
}

// ─── functions ───────────────────────────────────────────────────────────────

export function formatCommitTime(authorAt: number, now = new Date(), locale: ConsoleLocale | undefined = "en"): string {
  const date = new Date(authorAt * 1000);
  if (!Number.isFinite(date.getTime())) return "—";

  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfCommit = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayOffset = Math.round((startOfToday - startOfCommit) / 86_400_000);
  const t = getT(locale);

  if (dayOffset === 0) return t("repository.time.today", { time });
  if (dayOffset === 1) return t("repository.time.yesterday", { time });
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Conventional Commit 접두(`type(scope)!:`)를 제목 본문에서 분리한다 — Fork처럼 접두만 강조하기 위해서다.
 * 콜론 뒤 공백을 요구하므로 `https://…` 같은 스킴은 접두로 오인되지 않는다. 규약을 따르지 않는 제목은
 * 접두 없이 그대로 돌려주므로 호출부가 한 가지 경로만 렌더하면 된다.
 */
const CONVENTIONAL_SUBJECT_RE = /^([A-Za-z][\w-]*(?:\([^()]*\))?!?:)\s+(.+)$/;

export function splitCommitSubject(subject: string): { readonly prefix: string | null; readonly rest: string } {
  const match = CONVENTIONAL_SUBJECT_RE.exec(subject);
  if (!match) return { prefix: null, rest: subject };
  return { prefix: match[1]!, rest: match[2]! };
}

export function refBadges(entry: LogCommitEntry): RefBadge[] {
  const local: RefBadge[] = [];
  const remote: RefBadge[] = [];
  const tags: RefBadge[] = [];
  for (const ref of entry.refs) {
    if (ref === "HEAD") {
      local.push({ label: "HEAD", kind: "head" });
    } else if (ref.startsWith("HEAD -> refs/heads/")) {
      local.push({ label: ref.slice("HEAD -> refs/heads/".length), kind: "branch" });
    } else if (ref.startsWith("HEAD -> ")) {
      local.push({ label: ref.slice(8), kind: "branch" });
    } else if (ref.startsWith("tag: refs/tags/")) {
      tags.push({ label: ref.slice("tag: refs/tags/".length), kind: "tag" });
    } else if (ref.startsWith("tag: ")) {
      tags.push({ label: ref.slice(5), kind: "tag" });
    } else if (ref.startsWith("refs/remotes/")) {
      const label = ref.slice(13);
      // remote/HEAD 심볼릭 ref는 기본 브랜치 칩과 중복이므로 표시하지 않는다.
      if (!label.endsWith("/HEAD")) remote.push({ label, kind: "remote" });
    } else if (ref.startsWith("refs/worktrees/")) {
      local.push({ label: ref.slice(15), kind: "worktree" });
    } else if (ref.startsWith("refs/heads/")) {
      local.push({ label: ref.slice(11), kind: "branch" });
    } else {
      local.push({ label: ref, kind: "branch" });
    }
  }

  const remoteTargetIndex = local.findIndex((badge) => badge.kind === "branch");
  if (remoteTargetIndex < 0) return [...local, ...remote, ...tags.sort((left, right) => left.label.localeCompare(right.label))];
  const mergedLocal = local.map((badge, index) => index === remoteTargetIndex && remote.length > 0 ? { ...badge, hasRemote: true } : badge);
  return [...mergedLocal, ...tags.sort((left, right) => left.label.localeCompare(right.label))];
}

// ═══ hunk-parse ══════════════════════════════════════════════════════════════

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
  const wrap = (kind: string, value: string) => `<span class="repository-token-${kind}">${value}</span>`;
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

// ═══ repo-tree ═══════════════════════════════════════════════════════════════

// ─── types ───────────────────────────────────────────────────────────────────

export interface RepoTreeNode {
  dirs: { [key: string]: RepoTreeNode };
  repos: RepoCandidate[];
}

// "__proto__" 같은 유효한 디렉터리명이 상속 프로퍼티와 충돌하지 않도록 null-prototype 사전을 쓴다.
function createDirs(): { [key: string]: RepoTreeNode } {
  return Object.create(null) as { [key: string]: RepoTreeNode };
}

function createNode(): RepoTreeNode {
  return { dirs: createDirs(), repos: [] };
}

// ─── buildRepoTree ───────────────────────────────────────────────────────────

/**
 * nested 저장소의 relPath를 디렉터리 세그먼트로 분해해 트리를 구성한다.
 * 각 저장소는 자신의 relPath 마지막 세그먼트가 곧 자기 디렉터리이므로,
 * pop 후 나머지 상위 세그먼트만 dirs 체인으로 만들고 리프에 저장소를 담는다.
 * (repository-tree.tsx의 buildDiffTree와 같은 관용구.)
 * 각 노드의 dirs·repos는 알파벳(localeCompare)으로 정렬한다 —
 * 스캔 DFS 순 그대로 노출하면 사용자가 위치를 예측하기 어렵다.
 * 서버 relPath는 path.relative 결과라 OS 종속 구분자를 쓴다 — 세그먼트 분해에만
 * `\`→`/` 정규화 복사본을 쓰고, RepoCandidate 원본은 변형하지 않는다(선택/전환 계약).
 */
export function buildRepoTree(repos: readonly RepoCandidate[]): RepoTreeNode {
  const root = createNode();
  for (const repo of repos) {
    const parts = repo.relPath.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0);
    if (parts.length === 0) continue;
    parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.dirs[part]) node.dirs[part] = createNode();
      node = node.dirs[part]!;
    }
    node.repos.push(repo);
  }
  sortNode(root);
  return root;
}

function sortNode(node: RepoTreeNode): void {
  node.repos.sort((a, b) => a.name.localeCompare(b.name));
  const entries = Object.entries(node.dirs).sort(([a], [b]) => a.localeCompare(b));
  node.dirs = createDirs();
  for (const [key, child] of entries) {
    sortNode(child);
    node.dirs[key] = child;
  }
}

// ─── compressRepoFolder ──────────────────────────────────────────────────────

/**
 * VS Code 스타일 폴더 압축: 자식 디렉터리 하나 + 저장소 없음 체인을
 * "a/b" 한 라벨로 합쳐 최종 노드와 함께 돌려준다 (DiffTreeFolder 미러).
 */
export function compressRepoFolder(dirKey: string, node: RepoTreeNode): { label: string; node: RepoTreeNode } {
  let label = dirKey;
  let resolved = node;
  while (Object.keys(resolved.dirs).length === 1 && resolved.repos.length === 0) {
    const onlyKey = Object.keys(resolved.dirs)[0]!;
    label += "/" + onlyKey;
    resolved = resolved.dirs[onlyKey]!;
  }
  return { label, node: resolved };
}

// ─── countRepos ──────────────────────────────────────────────────────────────

export function countRepos(node: RepoTreeNode): number {
  let total = node.repos.length;
  for (const child of Object.values(node.dirs)) total += countRepos(child);
  return total;
}

// ─── shortRefName ────────────────────────────────────────────────────────────

/** 풀 refname을 사람이 읽는 짧은 이름으로 강등한다 — 와이어 계약(풀 refname)은 그대로 두고 표시만 바꾼다. */
export function shortRefName(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return ref;
}
