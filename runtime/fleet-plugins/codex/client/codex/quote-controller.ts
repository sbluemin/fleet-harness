import type { ComposerQuoteAttachResult, ComposerQuoteKind, ComposerQuoteTarget } from "@fleet-console/sdk/composer/quotes";
import type { ComposerQuoteTargetOption } from "@fleet-console/sdk/plugin";

import { getT, resolveActiveLocale } from "../i18n/index.js";
import { hostCapabilities } from "../host.js";
import { escapeAttribute, escapeHtml } from "./utils.js";

/**
 * 문서에서 고른 문장을 지휘관·사령관의 입력창에 인용 칩으로 바로 붙인다(목표 80c157b0 · D안).
 *
 * Codex 는 댓글을 모아 두지 않는다 — 「댓글」·「질문」을 누르는 즉시 받는 쪽 컴포저 초안에 칩이 서고, 사람은 그 지휘관·사령관의
 * 채팅에서 지시를 써서 보낸다. 붙이기는 보내기가 아니다. 받는 쪽 목록과 붙이기는 호스트 능력(`composer.quoteTargets`·
 * `attachQuote`)이 중개한다. 지휘관이 고친 내용은 Wiki 패치로 와서 이 문서 머리의 「검토 대기 패치」로 이어진다.
 */

export interface QuoteSelectionController { destroy(): void; }

export interface MountQuoteSelectionOptions {
  readonly theaterId: string | null;
  readonly entryId: string;
  readonly title: string;
  /** 선택 알약의 포지셔닝 호스트. */
  readonly article: HTMLElement;
  /** 문장을 고를 수 있는 본문. */
  readonly body: HTMLElement;
}

interface Selection { readonly quote: string; readonly top: number; readonly left: number }

// Theater 별로 마지막으로 고른 붙일 곳 — 문서를 옮겨 다녀도 같은 지휘관에게 이어 붙인다(플러그인 번들 안 페이지 메모리).
const chosenTargets = new Map<string, string>();

function targetKey(target: ComposerQuoteTarget): string {
  return target.kind === "operation" ? `op:${target.operationId}` : `plugin:${target.pluginId}:${target.targetId}`;
}

function t() {
  return getT(resolveActiveLocale());
}

function targetName(option: ComposerQuoteTargetOption): string {
  return option.group === "commodore" ? t()("codex.quote.commodoreName", { name: option.label }) : option.label;
}

const ICON_COMMENT = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 13h2.5L13 5.5 10.5 3 3 10.5V13Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const ICON_QUESTION = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M6.4 6.3a1.7 1.7 0 1 1 2.4 1.6c-.5.2-.8.6-.8 1.1v.4M8 11.3v.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

export function mountQuoteSelection(options: MountQuoteSelectionOptions): QuoteSelectionController {
  const anchor = document.createElement("div");
  anchor.className = "codex-quote-anchor";
  const toast = document.createElement("div");
  toast.className = "codex-quote-toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.hidden = true;
  options.article.classList.add("codex-quote-host");
  options.article.append(anchor, toast);

  let selection: Selection | null = null;
  let menuOpen = false;
  let disposed = false;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const theaterKey = options.theaterId ?? "";
  const composer = () => hostCapabilities.bound()?.composer ?? null;

  const targets = (): readonly ComposerQuoteTargetOption[] => {
    if (!options.theaterId) return [];
    return composer()?.quoteTargets?.(options.theaterId) ?? [];
  };

  /** 고른 곳이 아직 있으면 그곳, 없으면 지금 보는 대화, 그도 없으면 사령관, 그다음 첫 지휘관. */
  const resolveTarget = (list: readonly ComposerQuoteTargetOption[]): ComposerQuoteTargetOption | null => {
    const chosen = chosenTargets.get(theaterKey);
    return list.find((option) => targetKey(option.target) === chosen)
      ?? list.find((option) => option.current)
      ?? list.find((option) => option.group === "commodore")
      ?? list[0]
      ?? null;
  };

  const showToast = (message: string) => {
    toast.textContent = message;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
  };

  const render = () => {
    if (disposed) return;
    if (!selection) { anchor.innerHTML = ""; return; }
    const tr = t();
    const list = targets();
    const target = resolveTarget(list);
    // 위치는 그린 뒤 알약의 실제 폭으로 문서 안에 맞춘다(placePill). 좁은 패널에서도 가로로 넘치지 않는다.
    const at = `style="top:${selection.top}px;left:${selection.left}px"`;
    if (!target) {
      anchor.innerHTML = `<div class="codex-quote-pill is-empty" ${at} role="note">${escapeHtml(tr("codex.quote.noTarget"))}</div>`;
      return;
    }
    const menu = menuOpen ? `<div class="codex-quote-menu" role="menu" aria-label="${escapeAttribute(tr("codex.quote.targetMenu"))}">
      ${(["commodore", "commander"] as const).map((group) => {
        const rows = list.filter((option) => option.group === group);
        if (rows.length === 0) return "";
        return `<span class="codex-quote-menu-head">${escapeHtml(tr(group === "commodore" ? "codex.quote.groupCommodore" : "codex.quote.groupCommander"))}</span>${rows.map((option) => `
          <button type="button" role="menuitemradio" aria-checked="${targetKey(option.target) === targetKey(target.target)}" data-quote-target="${escapeAttribute(targetKey(option.target))}">
            <span class="codex-quote-menu-name">${escapeHtml(option.label)}</span>${option.current ? `<span class="codex-quote-menu-note">${escapeHtml(tr("codex.quote.current"))}</span>` : ""}
          </button>`).join("")}`;
      }).join("")}
    </div>` : "";
    anchor.innerHTML = `<div class="codex-quote-pill" ${at} role="group" aria-label="${escapeAttribute(tr("codex.quote.pillAria", { name: targetName(target) }))}">
      <button type="button" data-quote-kind="comment">${ICON_COMMENT}<span>${escapeHtml(tr("codex.quote.comment"))}</span></button>
      <span class="codex-quote-sep" aria-hidden="true"></span>
      <button type="button" data-quote-kind="question">${ICON_QUESTION}<span>${escapeHtml(tr("codex.quote.question"))}</span></button>
      <button type="button" class="codex-quote-to" data-quote-menu aria-haspopup="menu" aria-expanded="${menuOpen}" title="${escapeAttribute(`${tr("codex.quote.targetMenu")} · ${targetName(target)}`)}"><span class="codex-quote-to-name">→ ${escapeHtml(targetName(target))}</span><span aria-hidden="true" class="codex-quote-chev">▾</span></button>
      ${menu}
    </div>`;
    placePill();
    if (menuOpen) anchor.querySelector<HTMLButtonElement>('.codex-quote-menu [aria-checked="true"]')?.focus({ preventScroll: true });
  };

  /** 알약 중심을 선택 아래에 두되, 실제 폭의 절반만큼 안쪽으로 당겨 문서 좌우 경계 안에 둔다. */
  const placePill = () => {
    const pill = anchor.querySelector<HTMLElement>(".codex-quote-pill");
    if (!pill || !selection) return;
    const hostWidth = options.article.clientWidth;
    const half = pill.offsetWidth / 2 + 8;
    pill.style.left = `${Math.min(Math.max(selection.left, half), Math.max(hostWidth - half, half))}px`;
  };

  const clearSelection = () => {
    selection = null;
    menuOpen = false;
    render();
  };

  const resultMessage = (result: ComposerQuoteAttachResult, option: ComposerQuoteTargetOption): string => {
    const tr = t();
    if (result === "attached") return tr("codex.quote.attached", { name: targetName(option) });
    if (result === "duplicate") return tr("codex.quote.duplicate", { name: targetName(option) });
    if (result === "limit") return tr("codex.quote.limit", { name: targetName(option) });
    return tr("codex.quote.unavailable", { name: targetName(option) });
  };

  const attach = (kind: ComposerQuoteKind) => {
    if (!selection) return;
    const option = resolveTarget(targets());
    const attachQuote = composer()?.attachQuote;
    if (!option || !attachQuote) { showToast(t()("codex.quote.noTarget")); return; }
    const result = attachQuote(option.target, {
      kind,
      excerpt: selection.quote,
      source: { label: options.title, ref: `[[wiki:${options.entryId}]]` },
    });
    showToast(resultMessage(result, option));
    if (result === "attached" || result === "duplicate") {
      window.getSelection()?.removeAllRanges();
      clearSelection();
      // 지금 보이지 않는 지휘관이면 그 대화로 데려간다 — 붙은 칩과 다음 할 일(지시 쓰기)이 거기 있다.
      if (option.target.kind === "operation" && !option.current) hostCapabilities.bound()?.operations?.focus(option.target.operationId);
    }
  };

  const onMouseUp = (event: MouseEvent) => {
    // 알약 위에서의 mouseup 은 앵커를 다시 세우면 안 된다 — click 이 닿기 전에 단추가 바뀐다.
    if (event.target instanceof Node && anchor.contains(event.target)) return;
    const range = window.getSelection();
    const quote = range?.toString().replace(/\s+/g, " ").trim() ?? "";
    if (!quote || !range || range.rangeCount === 0 || !options.body.contains(range.anchorNode)) { if (selection) clearSelection(); return; }
    const rect = range.getRangeAt(0).getBoundingClientRect();
    const host = options.article.getBoundingClientRect();
    selection = {
      quote,
      top: rect.bottom - host.top + 8,
      left: Math.min(Math.max(rect.left + rect.width / 2 - host.left, 0), Math.max(host.width, 0)),
    };
    menuOpen = false;
    render();
  };

  const onMouseDown = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    // 알약을 누를 때 브라우저가 선택을 풀지 않게 한다 — 무엇을 붙이는지 계속 보인다.
    if (event.target.closest(".codex-quote-pill")) { event.preventDefault(); return; }
    if (selection && !anchor.contains(event.target)) clearSelection();
  };

  const onClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element) || !anchor.contains(event.target)) return;
    const kind = event.target.closest<HTMLElement>("[data-quote-kind]")?.dataset.quoteKind;
    if (kind === "comment" || kind === "question") { attach(kind); return; }
    if (event.target.closest("[data-quote-menu]")) { menuOpen = !menuOpen; render(); return; }
    const picked = event.target.closest<HTMLElement>("[data-quote-target]")?.dataset.quoteTarget;
    if (picked) {
      chosenTargets.set(theaterKey, picked);
      menuOpen = false;
      render();
      anchor.querySelector<HTMLButtonElement>("[data-quote-menu]")?.focus({ preventScroll: true });
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !selection) return;
    event.stopPropagation();
    if (menuOpen) { menuOpen = false; render(); anchor.querySelector<HTMLButtonElement>("[data-quote-menu]")?.focus({ preventScroll: true }); return; }
    clearSelection();
  };

  // 받는 쪽 목록이 바뀌면(지휘관이 생기거나 사령관이 꺼짐) 떠 있는 알약을 다시 그린다.
  const unsubscribeTargets = composer()?.subscribeQuoteTargets?.(() => { if (selection) render(); }) ?? (() => undefined);
  options.article.addEventListener("mouseup", onMouseUp);
  options.article.addEventListener("mousedown", onMouseDown);
  options.article.addEventListener("click", onClick);
  options.article.addEventListener("keydown", onKeyDown);

  return {
    destroy() {
      disposed = true;
      unsubscribeTargets();
      if (toastTimer) clearTimeout(toastTimer);
      options.article.removeEventListener("mouseup", onMouseUp);
      options.article.removeEventListener("mousedown", onMouseDown);
      options.article.removeEventListener("click", onClick);
      options.article.removeEventListener("keydown", onKeyDown);
      anchor.remove();
      toast.remove();
      options.article.classList.remove("codex-quote-host");
    },
  };
}
