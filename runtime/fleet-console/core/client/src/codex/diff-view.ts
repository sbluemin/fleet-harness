// Codex의 단일 diff 문법. 승인 게이트 · 충돌 해결 · Cowork 초안 검토가 모두 이 모듈을
// 통해 그린다 — 세 화면이 각자 diff를 그리면 같은 뜻에 세 가지 표현이 생긴다.
//
// 채널 계약: 추가는 `positive`, 삭제는 `coral`을 쓴다. 둘 다 상태를 말하는 신호색이다.
// `brass`는 위치/포커스 채널이므로 diff에 쓰지 않는다(과거 Cowork 구현은 추가에 brass를
// 썼고, 그것이 채널 위반이었다).

import { renderMarkdown } from "@fleet-console/markdown/core";

import { markdownCopyOptions } from "../i18n/index.js";
import type { Translate } from "@fleet-console/sdk/i18n";
import type { CoreMessageKey } from "../i18n/index.js";
import { collapseDiffContext, countDiffLines, diffDraftBlocks, diffUnifiedLines } from "./cowork-diff.js";
import type { DiffCounts } from "./cowork-diff.js";
import { entryPath } from "./router.js";
import { escapeHtml } from "./utils.js";

type T = Translate<CoreMessageKey>;

const LINE_KIND_CLASS: Readonly<Record<string, string>> = {
  context: "codex-diff-line",
  added: "codex-diff-line is-added",
  removed: "codex-diff-line is-removed",
};

const LINE_KIND_SIGIL: Readonly<Record<string, string>> = {
  context: " ",
  added: "+",
  removed: "-",
};

/**
 * 두 본문은 서로 다른 저장 형태에서 온다 — 현재본은 파일, 제안본은 패치 안의 JSON 문자열.
 * 그래서 끝의 개행이나 줄 끝 공백만 달라도 "변경"으로 잡히고, 실제 변경이 그 노이즈에 묻힌다.
 * 의미 없는 차이를 먼저 지운 뒤에 비교한다.
 */
function normalizeForDiff(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

export function diffCounts(base: string, next: string): DiffCounts {
  return countDiffLines(diffUnifiedLines(normalizeForDiff(base), normalizeForDiff(next)));
}

/**
 * 유니파이드 라인 diff. 패치 승인과 충돌 해결처럼 "정확히 어느 글자가 달라졌는가"가
 * 판단 근거인 화면에서 쓴다.
 */
export function renderLineDiff(base: string, next: string, t: T): string {
  const lines = diffUnifiedLines(normalizeForDiff(base), normalizeForDiff(next));
  if (lines.every((line) => line.kind === "context")) {
    return `<p class="codex-diff-empty">${escapeHtml(t("codex.diff.identical"))}</p>`;
  }
  const rows = collapseDiffContext(lines)
    .map((entry) => {
      if (entry.kind === "gap") {
        return `<div class="codex-diff-gap" aria-hidden="true">${escapeHtml(
          t(entry.skipped === 1 ? "codex.diff.unchangedLines_one" : "codex.diff.unchangedLines_other", { count: entry.skipped }),
        )}</div>`;
      }
      const cls = LINE_KIND_CLASS[entry.kind] ?? "codex-diff-line";
      const sigil = LINE_KIND_SIGIL[entry.kind] ?? " ";
      // 빈 줄도 높이를 가져야 diff의 리듬이 유지된다.
      const text = entry.text.length > 0 ? escapeHtml(entry.text) : "&nbsp;";
      return `<div class="${cls}"><span class="codex-diff-sigil" aria-hidden="true">${sigil}</span><span class="codex-diff-text">${text}</span></div>`;
    })
    .join("");
  return `<div class="codex-diff" role="group" aria-label="${escapeHtml(t("codex.diff.ariaLabel"))}">${rows}</div>`;
}

/**
 * 렌더된 문서 관점의 블록 diff — 소스 라인이 아니라 "어느 문단이 바뀌었는가"를 본다.
 * Cowork 초안 검토처럼 결과물의 모양이 판단 근거인 화면에서 쓴다.
 */
export function renderBlockDiff(base: string, next: string, t: T): string {
  return diffDraftBlocks(normalizeForDiff(base), normalizeForDiff(next))
    .map((block) => {
      const html = renderMarkdown(block.markdown, {
        resolveWikiLink: (id) => entryPath(id),
        ...markdownCopyOptions(t),
      }).html;
      return block.kind === "same"
        ? html
        : `<div class="codex-diff-block is-${block.kind}">${html}</div>`;
    })
    .join("");
}

/** "+12 -3" 요약 칩. 변경이 없으면 null. */
export function renderDiffCountChip(counts: DiffCounts): string | null {
  if (counts.added === 0 && counts.removed === 0) return null;
  const parts: string[] = [];
  if (counts.added > 0) parts.push(`<span class="codex-diff-count is-added">+${counts.added}</span>`);
  if (counts.removed > 0) parts.push(`<span class="codex-diff-count is-removed">-${counts.removed}</span>`);
  return `<span class="codex-diff-counts">${parts.join("")}</span>`;
}
