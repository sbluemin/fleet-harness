import { renderMarkdown } from "@fleet-console/markdown/core";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { getGlobalSettingsStoreState } from "../global-settings-store.js";
import { getT, markdownCopyOptions } from "../i18n/index.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";
import {
  applyCowork, cancelCowork, closeCowork, CoworkRequestError, createCoworkSession,
  fetchCoworkOptions, peekCoworkEntrySession, promptCowork, subscribeCoworkEvents,
  updateCoworkAnnotations, updateCoworkSelection, updateCoworkSettings,
} from "./api.js";
import type { CoworkAnnotationDto, CoworkOptionsResponse, CoworkSessionDto } from "./api.js";
import { diffDraftBlocks, diffDraftLines } from "@fleet-console/markdown/diff";
import type { DraftLine } from "@fleet-console/markdown/diff";
import { CoworkAgentMenu } from "./cowork-agent-menu.js";
import { entryPath } from "./router.js";
import { escapeAttribute, escapeHtml } from "./utils.js";

function resolveActiveLocale() {
  const preference = getGlobalSettingsStoreState().state?.language ?? "auto";
  const navigatorLanguage =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language.toLowerCase()
      : "";
  return resolveConsoleLanguage(preference, navigatorLanguage);
}

function consoleT() {
  return getT(resolveActiveLocale());
}

export interface CoworkController { destroy(): void; }

export interface MountCoworkInlineOptions {
  theaterId: string | null;
  entryId: string;
  /** 렌더 중복 제거용 엔트리 제목 */
  title: string;
  /** 리딩 뷰를 감싸는 article — 선택 필/코멘트 컴포저의 포지셔닝 호스트 */
  article: HTMLElement;
  /** 엔트리 마크다운이 렌더된 본문 요소 — 초안 렌더 시 이 내용만 교체 */
  body: HTMLElement;
  /**
   * 도크(컴포저 바)가 정박할 프레임 경계 요소. 본문 스크롤 흐름 밖에 두어야
   * 읽는 중인 문단을 가리지 않는다. 생략 시 article 말미(레거시 흐름 내 위치).
   */
  dockHost?: HTMLElement;
  onApplied(): void;
}

interface Settings { model: string; effort: string; }
interface AnnotationCard { id: string; quote: string; comment: string; status: "pending" | "sent" | "done"; }
interface PromptAttempt { cancelled: boolean; submitted: boolean; }
type RevisionOutcome = "idle" | "running" | "complete" | "stopped";

const SETTINGS_KEY = "fleet.codex.cowork.settings";
const BATCH_INSTRUCTION = "Revise the draft to address every saved annotation. Preserve unrelated content and summarize the changes.";
const STREAM_RENDER_DELAY_MS = 32;

/**
 * 리딩 뷰 인라인 Cowork 증강 — 별도 화면 전환 없이 엔트리 문서 위에서 동작한다.
 * 드래그 선택 → 플로팅 Comment 필 → 코멘트 컴포저 → 하단 플로팅 도크(일괄 전송·Apply)로 이어지며,
 * 세션은 첫 코멘트 시점에 지연 생성되고 기존 활성 세션은 peek으로 자동 복원된다.
 */
export function mountCoworkInline(options: MountCoworkInlineOptions): CoworkController {
  let disposed = false;
  let session: CoworkSessionDto | null = null;
  let unsubscribe: (() => void) | null = null;
  let lastEventId = 0;
  let optionsDto: CoworkOptionsResponse = { models: [], efforts: [] };
  let settings = readSettings();
  let annotations: AnnotationCard[] = [];
  let reply = "";
  let renderedReplyText = "";
  let renderedReplyHtml = "";
  let revisionRenderTimer: number | null = null;
  let revisionInstruction = "";
  let revisionOutcome: RevisionOutcome = "idle";
  let revisionCollapsed = false;
  let selection: { quote: string; top: number; left: number } | null = null;
  let composerOpen = false;
  let panelOpen = false;
  let configOpen = false;
  let confirmAction: "apply" | "discard" | null = null;
  let diffVisible = false;
  // 이번 마운트에서 직접 보낸 실행의 완료만 diff 자동 전환 대상(리플레이 done 제외).
  let awaitingResult = false;
  // 서버의 running DTO가 돌아오기 전에도 전송을 잠가 동일 프롬프트의 재진입을 막는다.
  let promptPending = false;
  let promptAttempt: PromptAttempt | null = null;
  let promptText = "";
  let error = "";
  let lastBodyKey = "published";
  let lastDockHtml: string | null = null;
  let diffMemo: { base: string; draft: string; lines: readonly DraftLine[] } | null = null;
  let settingsSelectRoot: Root | null = null;

  // SSE 이벤트마다 LCS를 다시 돌리지 않도록 draft 쌍 기준으로 메모한다.
  const draftLines = (): readonly DraftLine[] => {
    if (!session) return [];
    if (!diffMemo || diffMemo.base !== session.baseDraft || diffMemo.draft !== session.draft) {
      diffMemo = { base: session.baseDraft, draft: session.draft, lines: diffDraftLines(session.baseDraft, session.draft) };
    }
    return diffMemo.lines;
  };

  const publishedHtml = options.body.innerHTML;
  const anchor = document.createElement("div");
  anchor.className = "cowork-anchor";
  const dockZone = document.createElement("div");
  dockZone.className = "cowork-dock-zone";
  const tip = document.createElement("div");
  tip.className = "cowork-tip";
  tip.hidden = true;
  options.article.classList.add("cowork-host");
  options.article.append(anchor, tip);
  // 도크는 스크롤포트 밖 프레임 경계에 선다 — 본문 위 부유(가림)를 만들지 않는다.
  (options.dockHost ?? options.article).append(dockZone);

  const unmountSettingsSelect = () => {
    settingsSelectRoot?.unmount();
    settingsSelectRoot = null;
  };

  const mountSettingsSelectIfNeeded = () => {
    if (!configOpen || disposed) return;
    const host = dockZone.querySelector<HTMLElement>("[data-cowork-settings-host]");
    if (!host) return;
    if (!settingsSelectRoot) settingsSelectRoot = createRoot(host);
    settingsSelectRoot.render(createElement(CoworkAgentMenu, {
      models: optionsDto.models,
      efforts: optionsDto.efforts,
      model: settings.model,
      effort: settings.effort,
      onSelect: handleSelect,
    }));
  };

  // 세션 설정 동기화는 한 번에 하나만 비행한다 — 트랙 드래그는 단을 지날 때마다 변경을 내므로,
  // 병렬 POST의 완료 순서가 뒤집히면 중간 강도가 세션의 최종값으로 남는다. 비행 중 변경은 표시만
  // 해 두고, 착지 후 그 시점의 최신 settings로 한 번만 더 보낸다(중간 값은 싣지 않는다).
  // 드레인 전체가 하나의 프라미스로 남는 것은 send()를 위해서다 — 큐가 비기 전에 프롬프트가
  // 출발하면, 도크가 보여 주는 값이 아니라 중간 값으로 턴이 돈다.
  let settingsSyncInFlight = false;
  let settingsSyncQueued = false;
  let settingsSyncDrain: Promise<void> = Promise.resolve();
  const syncSessionSettings = () => {
    if (!session || disposed) return;
    if (settingsSyncInFlight) {
      settingsSyncQueued = true;
      return;
    }
    settingsSyncInFlight = true;
    settingsSyncDrain = (async () => {
      do {
        settingsSyncQueued = false;
        try {
          const next = await updateCoworkSettings(options.theaterId, session!.id, settings);
          if (!disposed) session = next;
        } catch (cause) {
          error = cause instanceof Error ? cause.message : consoleT()("codex.cowork.requestFailed");
          renderDock();
        }
      } while (settingsSyncQueued && !disposed);
      settingsSyncInFlight = false;
    })();
  };

  const handleSelect = (model: string, effort: string) => {
    const modelChanged = model !== settings.model;
    settings = { model, effort };
    saveSettings(settings);
    if (modelChanged) {
      // 모델이 바뀌면 강도 사다리가 달라질 수 있다 — 재조회가 강도를 정규화한 뒤 도크를 다시 세운다.
      void updateOptions()
        .then(() => { syncSessionSettings(); renderDock(); })
        .catch((cause) => { error = cause instanceof Error ? cause.message : consoleT()("codex.cowork.requestFailed"); renderDock(); });
      return;
    }
    // 강도만 바뀌면 도크 HTML을 다시 세우지 않는다 — 재구축은 메뉴의 React 루트를 갈아치워
    // 드래그 중인 트랙과 열린 플라이아웃을 죽인다. 칩 표식은 제자리 패치, 메뉴는 리렌더만 한다.
    patchChipEffort();
    mountSettingsSelectIfNeeded();
    syncSessionSettings();
  };

  // 칩의 강도 표식 — 사다리 위 몇 번째 단인지 실행 메뉴 손잡이와 같은 글리프로 되비친다.
  const chipEffortGauge = (): string => {
    const total = optionsDto.efforts.length;
    const rung = optionsDto.efforts.indexOf(settings.effort) + 1;
    if (total === 0 || rung === 0) return "";
    const bars = Array.from({ length: total }, (_unused, index) => {
      const height = total === 1 ? 8 : 2 + (index * 6) / (total - 1);
      return `<rect x="${index * 2.5}" y="${8 - height}" width="1.5" height="${height}" rx="0.5"${index < rung ? ' data-lit="true"' : ""}></rect>`;
    }).join("");
    const width = total * 2.5 - 1;
    return `<span class="cowork-chip-effort" data-cowork-chip-effort data-effort-level="${escapeAttribute(settings.effort)}" aria-hidden="true"><svg class="operation-launch-variant-effort-gauge" viewBox="0 0 ${width} 8" width="${width}" height="8">${bars}</svg></span>`;
  };

  const patchChipEffort = () => {
    const holder = dockZone.querySelector<HTMLElement>("[data-cowork-chip-effort]");
    if (!holder) return;
    holder.dataset.effortLevel = settings.effort;
    const rung = optionsDto.efforts.indexOf(settings.effort) + 1;
    holder.querySelectorAll("rect").forEach((rect, index) => {
      if (index < rung) rect.setAttribute("data-lit", "true");
      else rect.removeAttribute("data-lit");
    });
  };

  // ── 렌더 ────────────────────────────────────────────────────────────────────

  const renderBody = () => {
    if (disposed) return;
    const t = consoleT();
    const engaged = !!session && session.state !== "closed";
    const key = !engaged ? "published" : diffVisible ? `diff:${session!.draft}` : `draft:${session!.draft}`;
    if (key === lastBodyKey) return;
    lastBodyKey = key;
    if (!engaged) { options.body.innerHTML = publishedHtml; return; }
    options.body.innerHTML = diffVisible
      ? `<div class="cowork-rendered-diff" aria-label="${escapeAttribute(t("codex.cowork.draftChangesAria"))}">${renderRenderedDiff(stripFrontmatter(session!.baseDraft), stripFrontmatter(session!.draft))}</div>`
      : renderMarkdown(stripFrontmatter(session!.draft), { omitDuplicateTitle: options.title, resolveWikiLink: (id) => entryPath(id), ...markdownCopyOptions(t) }).html;
  };

  const renderAnchor = () => {
    if (disposed) return;
    if (!selection) { anchor.innerHTML = ""; return; }
    const t = consoleT();
    // 중앙 정렬(translateX(-50%)) 기준이므로 요소 절반 폭만큼 안쪽으로 클램프해야
    // 문서 좌우 경계에서 잘리지 않는다. 컴포저 폭은 CSS min(340px, 86%)와 동기.
    const hostWidth = options.article.getBoundingClientRect().width || 0;
    const half = composerOpen ? Math.min(340, hostWidth * 0.86) / 2 + 8 : 56;
    const left = Math.min(Math.max(selection.left, half), Math.max(hostWidth - half, half));
    const at = `style="top:${selection.top}px;left:${left}px"`;
    anchor.innerHTML = composerOpen
      ? `<div class="cowork-composer" ${at} role="dialog" aria-label="${escapeAttribute(t("codex.cowork.addCommentAria"))}">
          <blockquote>${escapeHtml(clip(selection.quote, 140))}</blockquote>
          <textarea class="cowork-composer-input" rows="2" placeholder="${escapeAttribute(t("codex.cowork.commentPlaceholder"))}" aria-label="${escapeAttribute(t("codex.cowork.commentAria"))}"></textarea>
          <div class="cowork-composer-actions">
            <button type="button" class="cowork-ghost" data-cowork-action="cancel-comment">${escapeHtml(t("common.cancel"))}</button>
            <button type="button" class="cowork-solid" data-cowork-action="add-comment">${escapeHtml(t("codex.cowork.add"))}</button>
          </div>
        </div>`
      : `<button type="button" class="cowork-pill" data-cowork-action="comment" ${at}><span aria-hidden="true">✦</span>${escapeHtml(t("codex.cowork.comment"))}</button>`;
    if (composerOpen) anchor.querySelector<HTMLTextAreaElement>(".cowork-composer-input")?.focus();
  };

  const renderDock = () => {
    if (disposed) return;
    const t = consoleT();
    // 도크(채팅박스)는 세션 유무와 무관하게 엔트리를 열면 항상 떠 있다.
    // 세션은 첫 전송/코멘트 시점에 지연 생성된다.
    const engaged = !!session && session.state !== "closed" && session.state !== "applied";
    dockZone.classList.add("is-open");
    const running = promptPending || (engaged && session!.state === "running" && revisionOutcome !== "complete" && revisionOutcome !== "stopped");
    options.body.classList.toggle("is-cowork-running", running);
    // 삭제-전용 변경은 라인 diff에 changed 라인이 없으므로 draft 불일치로 판정해야 한다.
    const dirty = engaged && session!.baseDraft !== session!.draft;
    const changed = dirty ? draftLines().filter(line => line.changed).length : 0;
    setDockHtml(`
      ${renderRevisionStream(running)}
      ${panelOpen ? renderPanel() : ""}
      ${configOpen ? renderConfig() : ""}
      ${dirty && !running ? renderReview(changed) : ""}
      <div class="cowork-bar${running ? " is-running" : ""}" data-cowork-form>
        ${running ? '<span class="cowork-glow" aria-hidden="true"></span>' : ""}
        ${annotations.length > 0 || panelOpen ? `<button type="button" class="cowork-chip${panelOpen ? " is-active" : ""}" data-cowork-action="toggle-panel" aria-expanded="${panelOpen}" aria-label="${escapeAttribute(t("codex.cowork.annotationsAria"))}" ${running ? "disabled" : ""}><span aria-hidden="true">✦</span>${annotations.length}</button>` : ""}
        <input class="cowork-dock-input" name="prompt" autocomplete="off" value="${escapeAttribute(promptText)}" placeholder="${escapeAttribute(annotations.length ? t("codex.cowork.instructionOptional") : t("codex.cowork.askAi"))}" aria-label="${escapeAttribute(t("codex.cowork.instructionAria"))}" ${running ? "disabled" : ""}>
        <button type="button" class="cowork-chip cowork-chip--config${configOpen ? " is-active" : ""}" data-cowork-action="toggle-config" aria-expanded="${configOpen}" aria-label="${escapeAttribute(t("codex.cowork.agentSettingsAria"))}" ${running ? "disabled" : ""}>${escapeHtml(settings.model || "agent")}${chipEffortGauge()}</button>
        ${running
          ? `<button type="button" class="cowork-send cowork-stop" data-cowork-action="cancel-run" aria-label="${escapeAttribute(t("codex.cowork.stopAria"))}"><span aria-hidden="true"></span></button>`
          : `<button type="button" class="cowork-send" data-cowork-action="send" aria-label="${escapeAttribute(t("codex.cowork.sendToAi"))}">↑</button>`}
      </div>
      ${error ? `<p class="cowork-error" role="alert">${escapeHtml(error)}</p>` : ""}`);
    mountSettingsSelectIfNeeded();
  };

  const renderRevisionStream = (running: boolean): string => {
    const t = consoleT();
    const visible = running || revisionOutcome !== "idle";
    if (!visible) return "";
    const state = running ? "running" : revisionOutcome;
    const stateLabel = running ? t("codex.cowork.editingEntry") : revisionOutcome === "complete" ? t("codex.cowork.revisionComplete") : t("codex.cowork.revisionStopped");
    const streamToggleLabel = revisionCollapsed ? t("codex.cowork.expandStream") : t("codex.cowork.collapseStream");
    const hasContent = !!(revisionInstruction || reply || running);
    return `<section class="cowork-revision-stream is-${state}${revisionCollapsed ? " is-collapsed" : ""}" aria-label="${escapeAttribute(t("codex.cowork.revisionStreamAria"))}">
      ${running ? '<span class="cowork-revision-scan" aria-hidden="true"></span>' : ""}
      <header class="cowork-revision-head"><span class="cowork-revision-mark" aria-hidden="true">✳</span><span class="cowork-revision-copy"><strong>Cowork</strong><small>${escapeHtml(stateLabel)}</small></span>${hasContent ? `<button type="button" class="cowork-revision-toggle" data-cowork-action="toggle-revision" aria-expanded="${!revisionCollapsed}" aria-label="${escapeAttribute(streamToggleLabel)}"><span aria-hidden="true"></span></button>` : ""}</header>
      ${hasContent ? `<div class="cowork-revision-content" aria-hidden="${revisionCollapsed}"><div class="cowork-revision-content-inner">
        ${revisionInstruction || reply ? `<div class="cowork-revision-body">
          ${revisionInstruction ? `<p class="cowork-revision-instruction">${escapeHtml(revisionInstruction)}</p>` : ""}
          ${reply ? `<div class="cowork-revision-output-scroll"><div class="cowork-revision-output markdown-body">${renderedReplyHtml}</div></div>` : ""}
        </div>` : ""}
        ${running ? `<footer class="cowork-revision-status" role="status" aria-live="polite"><i aria-hidden="true"></i><span><strong>${escapeHtml(t("codex.cowork.writingRevision"))}</strong></span></footer>` : ""}
      </div></div>` : ""}
    </section>`;
  };

  const cancelRevisionRender = () => {
    if (revisionRenderTimer !== null) window.clearTimeout(revisionRenderTimer);
    revisionRenderTimer = null;
  };

  const renderReplyMarkdown = () => {
    if (renderedReplyText === reply) return;
    renderedReplyText = reply;
    renderedReplyHtml = reply ? renderMarkdown(reply, markdownCopyOptions(consoleT())).html : "";
  };

  const patchRevisionOutput = () => {
    renderReplyMarkdown();
    const output = dockZone.querySelector<HTMLElement>(".cowork-revision-output");
    if (!output) { renderDock(); return; }
    output.innerHTML = renderedReplyHtml;
    const scroll = output.closest<HTMLElement>(".cowork-revision-output-scroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  };

  const scheduleRevisionOutput = () => {
    if (revisionRenderTimer !== null) return;
    revisionRenderTimer = window.setTimeout(() => {
      revisionRenderTimer = null;
      if (!disposed) patchRevisionOutput();
    }, STREAM_RENDER_DELAY_MS);
  };

  const flushRevisionOutput = () => {
    cancelRevisionRender();
    renderReplyMarkdown();
  };

  // 스트리밍 중 동일 마크업 재구축은 등장 애니메이션 재시작(깜빡임)을 유발하므로,
  // 실제 변경이 있을 때만 교체하고 포커스 중이던 입력은 복원한다.
  const setDockHtml = (html: string) => {
    if (html === lastDockHtml) return;
    unmountSettingsSelect();
    lastDockHtml = html;
    const active = document.activeElement;
    const focusKey = active instanceof HTMLInputElement && active.name === "prompt" && dockZone.contains(active)
      ? "prompt"
      : active instanceof HTMLTextAreaElement && active.dataset.coworkComment && dockZone.contains(active)
        ? `comment:${active.dataset.coworkComment}`
        : null;
    dockZone.innerHTML = html;
    if (focusKey === "prompt") {
      const input = dockZone.querySelector<HTMLInputElement>(".cowork-dock-input");
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    } else if (focusKey?.startsWith("comment:")) {
      const textarea = dockZone.querySelector<HTMLTextAreaElement>(`[data-cowork-comment="${CSS.escape(focusKey.slice(8))}"]`);
      textarea?.focus();
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  };

  const renderPanel = () => {
    const t = consoleT();
    return `
    <div class="cowork-popover cowork-panel" role="region" aria-label="${escapeAttribute(t("codex.cowork.annotationsAria"))}">
      ${annotations.length === 0 ? `<p class="cowork-empty">${escapeHtml(t("codex.cowork.emptyAnnotations"))}</p>` : annotations.map(card => `
        <article class="cowork-card is-${card.status}">
          <blockquote>${escapeHtml(clip(card.quote, 160))}</blockquote>
          <textarea data-cowork-comment="${escapeAttribute(card.id)}" aria-label="${escapeAttribute(t("codex.cowork.commentAria"))}" placeholder="${escapeAttribute(t("codex.cowork.addCommentPlaceholder"))}" ${card.status === "sent" ? "disabled" : ""}>${escapeHtml(card.comment)}</textarea>
          <footer><span class="cowork-card-status">${escapeHtml(card.status === "sent" ? t("codex.cowork.statusSent") : card.status === "done" ? t("codex.cowork.statusDone") : t("codex.cowork.statusReady"))}</span><button type="button" class="cowork-x" data-cowork-action="delete-annotation" data-annotation-id="${escapeAttribute(card.id)}" aria-label="${escapeAttribute(t("codex.cowork.deleteAnnotation"))}">×</button></footer>
        </article>`).join("")}
    </div>`;
  };

  const renderConfig = () => {
    const t = consoleT();
    // 정렬 스트립은 바와 같은 폭이다 — 팝오버가 도크 중앙이 아니라 여는 칩(설정) 쪽에 선다.
    return `
    <div class="cowork-config-row">
      <div class="cowork-popover cowork-config" role="region" aria-label="${escapeAttribute(t("codex.cowork.agentSettingsAria"))}">
        <div data-cowork-settings-host></div>
      </div>
    </div>`;
  };

  const renderReview = (changed: number) => {
    const t = consoleT();
    if (confirmAction) {
      const question = confirmAction === "apply" ? t("codex.cowork.applyConfirm") : t("codex.cowork.discardConfirm");
      const proceed = confirmAction === "apply" ? "apply-confirm" : "discard-confirm";
      return `<div class="cowork-review is-confirm"><span>${escapeHtml(question)}</span><button type="button" class="cowork-solid${confirmAction === "discard" ? " cowork-solid--danger" : ""}" data-cowork-action="${proceed}">${escapeHtml(confirmAction === "apply" ? t("codex.cowork.apply") : t("codex.cowork.discard"))}</button><button type="button" class="cowork-ghost" data-cowork-action="confirm-back">${escapeHtml(t("codex.cowork.back"))}</button></div>`;
    }
    const changedLabel = changed > 0
      ? t(changed === 1 ? "codex.cowork.changedLines_one" : "codex.cowork.changedLines_other", { count: changed })
      : t("codex.cowork.removedContent");
    return `<div class="cowork-review"><span class="cowork-review-count"><i aria-hidden="true"></i>${escapeHtml(changedLabel)}</span><button type="button" class="cowork-ghost" data-cowork-action="toggle-diff">${escapeHtml(diffVisible ? t("codex.cowork.viewDraft") : t("codex.cowork.viewDiff"))}</button><button type="button" class="cowork-solid" data-cowork-action="apply-arm">${escapeHtml(t("codex.cowork.apply"))}</button><button type="button" class="cowork-ghost" data-cowork-action="discard-arm">${escapeHtml(t("codex.cowork.discard"))}</button></div>`;
  };

  // 어노테이션 인용문을 렌더된 본문에 하이라이트(mark)로 표시한다. 인용문이 여러 텍스트
  // 노드에 걸치면 노드별 조각으로 나눠 감싸고, 편집으로 사라진 인용문은 조용히 생략한다.
  const applyMarks = () => {
    if (disposed) return;
    for (const mark of [...options.body.querySelectorAll("mark.cowork-mark")]) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    }
    options.body.normalize();
    if (diffVisible) return;
    for (const card of annotations) {
      if (card.quote) markQuote(card);
    }
  };

  const markQuote = (card: AnnotationCard) => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(options.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    let full = "";
    const starts: number[] = [];
    for (const node of nodes) { starts.push(full.length); full += node.data; }
    const at = full.indexOf(card.quote);
    if (at < 0) return;
    const end = at + card.quote.length;
    for (let index = 0; index < nodes.length; index += 1) {
      const nodeStart = starts[index]!;
      const nodeEnd = nodeStart + nodes[index]!.data.length;
      const from = Math.max(at, nodeStart);
      const to = Math.min(end, nodeEnd);
      if (from >= to) continue;
      const range = document.createRange();
      range.setStart(nodes[index]!, from - nodeStart);
      range.setEnd(nodes[index]!, to - nodeStart);
      const mark = document.createElement("mark");
      mark.className = "cowork-mark";
      mark.dataset.annotationId = card.id;
      try { range.surroundContents(mark); } catch { /* 요소 경계와 겹치는 조각은 생략한다. */ }
    }
  };

  const showTip = (mark: HTMLElement) => {
    const card = annotations.find(a => a.id === mark.dataset.annotationId);
    if (!card) { tip.hidden = true; return; }
    tip.textContent = card.comment.trim() || consoleT()("codex.cowork.noCommentYet");
    tip.hidden = false;
    const rect = mark.getBoundingClientRect();
    const host = options.article.getBoundingClientRect();
    // 중앙 정렬(translateX(-50%))이므로 실측 절반 폭만큼 안쪽으로 클램프해야 경계에서 잘리지 않는다.
    const half = tip.offsetWidth / 2 + 8;
    tip.style.top = `${Math.max(rect.top - host.top - 6, 0)}px`;
    tip.style.left = `${Math.min(Math.max(rect.left + rect.width / 2 - host.left, half), Math.max(host.width - half, half))}px`;
  };

  const redraw = () => { renderBody(); renderDock(); applyMarks(); };

  // ── 세션 수명주기 ───────────────────────────────────────────────────────────

  const updateOptions = async () => {
    optionsDto = await fetchCoworkOptions(options.theaterId, settings.model || undefined);
    // 저장값이 무효하면 제품 기본값(sonnet/low)을 우선 채택한다.
    const fallbackModel = optionsDto.defaultModel && optionsDto.models.includes(optionsDto.defaultModel) ? optionsDto.defaultModel : optionsDto.models[0] ?? "";
    const fallbackEffort = optionsDto.defaultEffort && optionsDto.efforts.includes(optionsDto.defaultEffort) ? optionsDto.defaultEffort : optionsDto.efforts[0] ?? "";
    settings = {
      model: optionsDto.models.includes(settings.model) ? settings.model : fallbackModel,
      effort: optionsDto.efforts.includes(settings.effort) ? settings.effort : fallbackEffort,
    };
    saveSettings(settings);
  };

  const engage = async (next: CoworkSessionDto) => {
    session = next;
    // 지연 생성 경로에서는 서버에 아직 저장되지 않은 로컬 카드(첫 코멘트)를 보존해야 한다.
    const restored: AnnotationCard[] = next.annotations.map(annotationFromDto);
    const known = new Set(restored.map(card => card.id));
    annotations = [...restored, ...annotations.filter(card => !known.has(card.id))];
    if (next.cli || next.model || next.effort) {
      settings = { model: next.model ?? settings.model, effort: next.effort ?? settings.effort };
      saveSettings(settings);
    }
    try { await updateOptions(); } catch { /* 설정 팝오버가 비어 보일 뿐, 편집은 계속 가능하다. */ }
    if (disposed) return;
    // 세션에 저장된 모델이 레지스트리에서 사라져 정규화로 바뀌었으면, 첫 실행이
    // 무효 모델로 접속하지 않도록 서버 세션 설정을 즉시 동기화한다.
    if (session && (session.model !== settings.model || session.effort !== settings.effort)) {
      try { session = await updateCoworkSettings(options.theaterId, session.id, settings); } catch { /* 전송 시 오류로 표면화된다. */ }
    }
    if (disposed) return;
    subscribe();
    redraw();
  };

  const ensureSession = async (): Promise<CoworkSessionDto> => {
    if (session && session.state !== "closed" && session.state !== "applied") return session;
    const created = await createCoworkSession(options.theaterId, options.entryId, settings);
    await engage(created);
    return created;
  };

  // 도크는 즉시 표시하고, 옵션 목록(CLI/모델/effort)도 세션 없이 미리 채운다.
  renderDock();
  void updateOptions().then(renderDock).catch(() => undefined);
  void (async () => {
    try {
      const existing = await peekCoworkEntrySession(options.theaterId, options.entryId);
      if (!disposed && existing) await engage(existing);
    } catch { /* peek 실패는 dormant 유지 — 선택 시 생성 경로가 살아있다. */ }
  })();

  function subscribe(): void {
    if (!session) return;
    unsubscribe?.();
    unsubscribe = subscribeCoworkEvents(options.theaterId, session.id, lastEventId, (event, id) => {
      if (id && id <= lastEventId) return;
      lastEventId = Math.max(lastEventId, id);
      const wasRunning = session?.state === "running";
      if (event.session) session = event.session;
      if (event.type === "transcript" && event.text && session?.state === "running") {
        reply = revisionOutcome === "running" ? reply + event.text : event.text;
        revisionOutcome = "running";
        scheduleRevisionOutput();
        return;
      }
      // 도구 호출 상세는 사용자에게 출력하지 않는다 — 러닝 상태는 일반 문구로만 표시.
      if (event.type === "done") {
        flushRevisionOutput();
        // 제출 전에 취소된 지연 생성 요청은 뒤늦은 이벤트로 완료 처리하지 않는다.
        if (!promptAttempt?.cancelled || promptAttempt.submitted) {
          const completedObservedRun = wasRunning || awaitingResult || revisionOutcome === "stopped" || !!reply || !!revisionInstruction;
          revisionOutcome = completedObservedRun ? "complete" : "idle";
          annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "done" } : card);
          // AI 응답이 실제 변경(삭제-전용 포함)을 남겼으면 렌더드 diff로 전환해 검토를 유도한다.
          if (awaitingResult) {
            awaitingResult = false;
            if (session && session.baseDraft !== session.draft) diffVisible = true;
          }
        }
      }
      if (event.type === "error" || (event.type === "session" && wasRunning && session?.state !== "running")) {
        flushRevisionOutput();
        revisionOutcome = "stopped";
        awaitingResult = false;
        annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "pending" } : card);
      }
      if (event.type === "error" && event.text) error = event.text;
      redraw();
    });
  }

  // ── 어노테이션 & 전송 ───────────────────────────────────────────────────────

  async function addAnnotation(quote: string, comment: string): Promise<void> {
    annotations = [...annotations, { id: annotationId(), quote, comment, status: "pending" }];
    selection = null;
    composerOpen = false;
    renderAnchor();
    renderDock();
    applyMarks();
    try {
      await ensureSession();
      await mutate(() => updateCoworkSelection(options.theaterId, session!.id, quote));
      await persistAnnotations();
    } catch { /* mutate가 오류를 표면화한다. */ }
  }

  async function deleteAnnotation(id: string): Promise<void> {
    annotations = annotations.filter(card => card.id !== id);
    renderDock();
    applyMarks();
    tip.hidden = true;
    try { await persistAnnotations(); } catch { /* mutate가 오류를 표면화한다. */ }
  }

  async function persistAnnotations(): Promise<void> {
    if (!session) return;
    await mutate(() => updateCoworkAnnotations(options.theaterId, session!.id, annotations.map(annotationToDto)));
  }

  async function send(): Promise<void> {
    if (promptPending || session?.state === "running") return;
    // 이미 반영된(done) 카드는 재전송 대상에서 제외한다.
    const outgoing = annotations.filter(card => card.status !== "done");
    const localInstruction = promptText.trim();
    const prompt = localInstruction || (outgoing.length ? BATCH_INSTRUCTION : "");
    if (!prompt) return;
    const attempt: PromptAttempt = { cancelled: false, submitted: false };
    promptAttempt = attempt;
    promptPending = true;
    annotations = outgoing.map(card => ({ ...card, status: "sent" }));
    cancelRevisionRender();
    reply = "";
    renderedReplyText = "";
    renderedReplyHtml = "";
    revisionInstruction = localInstruction;
    revisionOutcome = "running";
    revisionCollapsed = false;
    promptText = "";
    panelOpen = false;
    configOpen = false;
    renderDock();
    applyMarks();
    try {
      // 도크 상시 표시: 세션이 아직 없으면 첫 전송 시점에 만든다.
      await ensureSession();
      if (attempt.cancelled || promptAttempt !== attempt) return;
      await mutate(() => updateCoworkAnnotations(options.theaterId, session!.id, annotations.map(annotationToDto)));
      if (attempt.cancelled || promptAttempt !== attempt) return;
      // 설정 쓰기 큐가 빌 때까지 기다린다 — 드래그 직후 곧장 보낸 프롬프트가 큐에 남은 최신
      // 강도보다 먼저 도착하면, 도크가 보여 주는 값이 아니라 중간 값으로 턴이 돈다.
      await settingsSyncDrain;
      if (attempt.cancelled || promptAttempt !== attempt) return;
      attempt.submitted = true;
      await mutate(() => promptCowork(options.theaterId, session!.id, prompt));
      awaitingResult = true;
    } catch {
      if (!attempt.cancelled && promptAttempt === attempt) {
        awaitingResult = false;
        revisionOutcome = "idle";
        annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "pending" } : card);
      }
    } finally {
      if (!attempt.cancelled && promptAttempt === attempt) {
        promptPending = false;
        promptAttempt = null;
        renderDock();
      }
    }
  }

  // Discard는 초안만 버린다 — 도크(작업 흐름)는 유지해야 하므로 곧바로 새 세션을 연다.
  async function discard(): Promise<void> {
    if (!session) return;
    const closing = session.id;
    try {
      error = "";
      await closeCowork(options.theaterId, closing);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : consoleT()("codex.cowork.requestFailed");
      renderDock();
      return;
    }
    unsubscribe?.();
    unsubscribe = null;
    lastEventId = 0;
    annotations = [];
    cancelRevisionRender();
    reply = "";
    renderedReplyText = "";
    renderedReplyHtml = "";
    revisionInstruction = "";
    revisionOutcome = "idle";
    revisionCollapsed = false;
    confirmAction = null;
    diffVisible = false;
    try {
      await engage(await createCoworkSession(options.theaterId, options.entryId, settings));
    } catch {
      session = null;
      redraw();
    }
  }

  async function mutate(run: () => Promise<CoworkSessionDto>): Promise<void> {
    try {
      error = "";
      session = await run();
      redraw();
    } catch (cause) {
      const t = consoleT();
      error = cause instanceof CoworkRequestError && ["cowork_apply_stale", "cowork_apply_stale_revision", "cowork_apply_busy"].includes(cause.code)
        ? t("codex.cowork.applyStale")
        : cause instanceof Error ? cause.message : t("codex.cowork.requestFailed");
      redraw();
      throw cause;
    }
  }

  // ── 이벤트 ──────────────────────────────────────────────────────────────────

  const onMouseUp = (event: MouseEvent) => {
    if (composerOpen || session?.state === "running") return;
    // 필/컴포저 위에서의 mouseup은 앵커를 재구축하면 안 된다 — click 이벤트가
    // 도달하기 전에 대상 요소가 교체되어 버튼이 무반응이 된다.
    if (event.target instanceof Node && anchor.contains(event.target)) return;
    const range = window.getSelection();
    const quote = range?.toString().trim() ?? "";
    if (!quote || !range || range.rangeCount === 0 || !options.body.contains(range.anchorNode)) return;
    const rect = range.getRangeAt(0).getBoundingClientRect();
    const host = options.article.getBoundingClientRect();
    // 클램프는 렌더 시점(요소 폭 기준)에 하므로 여기서는 원시 중심 좌표만 저장한다.
    selection = {
      quote,
      top: rect.bottom - host.top + 8,
      left: Math.min(Math.max(rect.left + rect.width / 2 - host.left, 0), Math.max(host.width, 0)),
    };
    renderAnchor();
  };

  const onMouseDown = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    // 필 클릭 시 브라우저의 선택 해제를 막아 하이라이트를 유지한다.
    if (event.target.closest(".cowork-pill")) { event.preventDefault(); return; }
    if (!anchor.contains(event.target) && selection) { selection = null; composerOpen = false; renderAnchor(); }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof Element && event.target.closest(".cowork-revision-output")) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      if (selection || composerOpen) { selection = null; composerOpen = false; renderAnchor(); }
      else if (panelOpen || configOpen || confirmAction) { panelOpen = false; configOpen = false; confirmAction = null; renderDock(); }
      return;
    }
    const target = event.target;
    if (event.key === "Enter" && !event.shiftKey && target instanceof HTMLTextAreaElement && target.classList.contains("cowork-composer-input")) {
      event.preventDefault();
      submitComposer();
    }
    if (event.key === "Enter" && target instanceof HTMLInputElement && target.name === "prompt") {
      event.preventDefault();
      void send();
    }
  };

  const submitComposer = () => {
    const comment = anchor.querySelector<HTMLTextAreaElement>(".cowork-composer-input")?.value.trim() ?? "";
    if (!selection) return;
    void addAnnotation(selection.quote, comment);
  };

  const onClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const revisionOutput = event.target.closest(".cowork-revision-output");
    if (revisionOutput) event.stopPropagation();
    const copyButton = event.target.closest<HTMLElement>('[data-action="copy-code"]');
    if (copyButton) {
      event.stopPropagation();
      const code = copyButton.closest("pre")?.getAttribute("data-code");
      if (code) copyCodeToClipboard(copyButton, code);
      return;
    }
    if (revisionOutput) return;
    const target = event.target.closest<HTMLElement>("[data-cowork-action]");
    if (!target) return;
    const action = target.dataset.coworkAction;
    if (action === "comment") { composerOpen = true; renderAnchor(); }
    if (action === "cancel-comment") { selection = null; composerOpen = false; renderAnchor(); }
    if (action === "add-comment") submitComposer();
    if (action === "toggle-panel") { panelOpen = !panelOpen; configOpen = false; renderDock(); }
    if (action === "toggle-config") { configOpen = !configOpen; panelOpen = false; renderDock(); }
    if (action === "toggle-revision") {
      revisionCollapsed = !revisionCollapsed;
      const stream = target.closest<HTMLElement>(".cowork-revision-stream");
      stream?.classList.toggle("is-collapsed", revisionCollapsed);
      target.setAttribute("aria-expanded", String(!revisionCollapsed));
      target.setAttribute("aria-label", revisionCollapsed ? consoleT()("codex.cowork.expandStream") : consoleT()("codex.cowork.collapseStream"));
      stream?.querySelector<HTMLElement>(".cowork-revision-content")?.setAttribute("aria-hidden", String(revisionCollapsed));
    }
    if (action === "send") void send();
    if (action === "cancel-run" && promptPending && promptAttempt && !promptAttempt.submitted) {
      promptAttempt.cancelled = true;
      promptPending = false;
      awaitingResult = false;
      revisionOutcome = "stopped";
      annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "pending" } : card);
      renderDock();
      applyMarks();
      return;
    }
    if (action === "toggle-diff") { diffVisible = !diffVisible; redraw(); }
    if (action === "delete-annotation" && target.dataset.annotationId) void deleteAnnotation(target.dataset.annotationId);
    if (action === "apply-arm") { confirmAction = "apply"; renderDock(); }
    if (action === "discard-arm") { confirmAction = "discard"; renderDock(); }
    if (action === "confirm-back") { confirmAction = null; renderDock(); }
    if (action === "apply-confirm" && session) {
      confirmAction = null;
      void mutate(() => applyCowork(options.theaterId, session!.id, session!.revision)).then(() => options.onApplied()).catch(() => undefined);
    }
    if (action === "discard-confirm") { void discard(); }
    if (action === "cancel-run" && session) {
      void mutate(() => cancelCowork(options.theaterId, session!.id)).then(() => {
        revisionOutcome = "stopped";
        annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "pending" } : card);
        renderDock();
      }).catch(() => undefined);
    }
  };

  const onMouseOverMark = (event: MouseEvent) => {
    const mark = event.target instanceof Element ? event.target.closest<HTMLElement>("mark.cowork-mark") : null;
    if (mark) showTip(mark);
    else if (!tip.hidden) tip.hidden = true;
  };
  const onMouseLeaveArticle = () => { tip.hidden = true; };

  const onInput = (event: Event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(".cowork-revision-output")) {
      event.stopPropagation();
      return;
    }
    if (target instanceof HTMLInputElement && target.name === "prompt") { promptText = target.value; return; }
    if (target instanceof HTMLTextAreaElement && target.dataset.coworkComment) {
      const id = target.dataset.coworkComment;
      annotations = annotations.map(card => card.id === id ? { ...card, comment: target.value, status: "pending" } : card);
    }
  };

  const onChange = (event: Event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(".cowork-revision-output")) {
      event.stopPropagation();
      return;
    }
    if (target instanceof HTMLTextAreaElement && target.dataset.coworkComment) void persistAnnotations().catch(() => undefined);
  };

  options.article.addEventListener("mouseup", onMouseUp);
  options.article.addEventListener("mousedown", onMouseDown);
  options.article.addEventListener("keydown", onKeyDown);
  options.article.addEventListener("click", onClick);
  options.article.addEventListener("input", onInput);
  options.article.addEventListener("change", onChange);
  options.article.addEventListener("mouseover", onMouseOverMark);
  options.article.addEventListener("mouseleave", onMouseLeaveArticle);
  // 도크가 article 밖 프레임 경계에 있으면 도크 상호작용 위임을 도크 존에 따로 건다.
  // (article 내 레거시 배치에서는 버블링이 닿으므로 이중 등록 시 토글류가 두 번 뒤집힌다.)
  const dockDetached = !options.article.contains(dockZone);
  if (dockDetached) {
    dockZone.addEventListener("keydown", onKeyDown);
    dockZone.addEventListener("click", onClick);
    dockZone.addEventListener("input", onInput);
    dockZone.addEventListener("change", onChange);
  }

  return {
    destroy() {
      disposed = true;
      cancelRevisionRender();
      unmountSettingsSelect();
      unsubscribe?.();
      options.article.removeEventListener("mouseup", onMouseUp);
      options.article.removeEventListener("mousedown", onMouseDown);
      options.article.removeEventListener("keydown", onKeyDown);
      options.article.removeEventListener("click", onClick);
      options.article.removeEventListener("input", onInput);
      options.article.removeEventListener("change", onChange);
      options.article.removeEventListener("mouseover", onMouseOverMark);
      options.article.removeEventListener("mouseleave", onMouseLeaveArticle);
      if (dockDetached) {
        dockZone.removeEventListener("keydown", onKeyDown);
        dockZone.removeEventListener("click", onClick);
        dockZone.removeEventListener("input", onInput);
        dockZone.removeEventListener("change", onChange);
      }
      anchor.remove();
      dockZone.remove();
      tip.remove();
      options.body.classList.remove("is-cowork-running");
      options.article.classList.remove("cowork-host");
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function copyCodeToClipboard(button: HTMLElement, code: string): void {
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  let write: Promise<void>;
  try { write = clipboard.writeText(code); } catch { return; }
  const original = button.textContent;
  void write.then(() => {
    if (!button.isConnected) return;
    button.textContent = consoleT()("codex.cowork.copied");
    window.setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1_200);
  }).catch(() => undefined);
}

// 소스 라인이 아닌 "렌더된 문서" 관점의 diff — 변경 블록은 하이라이트, 삭제 블록은
// 흐림+취소선으로 문서 흐름 안에 표시된다.
function renderRenderedDiff(base: string, draft: string): string {
  return diffDraftBlocks(base, draft).map(block => {
    const html = renderMarkdown(block.markdown, { resolveWikiLink: (id) => entryPath(id), ...markdownCopyOptions(consoleT()) }).html;
    return block.kind === "same" ? html : `<div class="cowork-block cowork-block--${block.kind}">${html}</div>`;
  }).join("");
}
function annotationToDto(card: AnnotationCard): CoworkAnnotationDto { return { id: card.id, quote: card.quote, comment: card.comment.trim() || consoleT()("codex.cowork.defaultComment") }; }
function annotationFromDto(dto: CoworkAnnotationDto): AnnotationCard { return { id: dto.id, quote: dto.quote, comment: dto.comment, status: "pending" }; }
function stripFrontmatter(markdown: string): string { return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); }
function clip(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function annotationId(): string { return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
// 저장돼 있던 `cli`는 읽지 않는다 — Cowork가 Agent CLI를 고르지 않게 되면서 의미가 사라졌다.
// 목록에서 빠진 모델(fable 계열 등)의 옛 저장값도 마이그레이션이 필요 없다 — 옵션 재조회가
// 목록 밖 값을 기본값으로 되돌린다.
function readSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return { model: typeof saved.model === "string" ? saved.model : "", effort: typeof saved.effort === "string" ? saved.effort : "low" };
  } catch { return { model: "", effort: "low" }; }
}
function saveSettings(settings: Settings): void { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Storage is optional. */ } }
