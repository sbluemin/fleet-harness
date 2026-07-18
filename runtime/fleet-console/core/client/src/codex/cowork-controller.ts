import { renderMarkdown } from "@fleet-console/markdown/core";
import {
  applyCowork, cancelCowork, closeCowork, CoworkRequestError, createCoworkSession,
  fetchCoworkOptions, peekCoworkEntrySession, promptCowork, subscribeCoworkEvents,
  updateCoworkAnnotations, updateCoworkSelection, updateCoworkSettings,
} from "./api.js";
import type { CoworkAnnotationDto, CoworkOptionsResponse, CoworkSessionDto } from "./api.js";
import { diffDraftBlocks, diffDraftLines } from "./cowork-diff.js";
import type { DraftLine } from "./cowork-diff.js";
import { entryPath } from "./router.js";
import { escapeAttribute, escapeHtml } from "./utils/html.js";

export interface CoworkController { destroy(): void; }

export interface MountCoworkInlineOptions {
  theaterId: string | null;
  entryId: string;
  /** 렌더 중복 제거용 엔트리 제목 */
  title: string;
  /** 리딩 뷰를 감싸는 article — 필/도크의 포지셔닝 호스트 */
  article: HTMLElement;
  /** 엔트리 마크다운이 렌더된 본문 요소 — 초안 렌더 시 이 내용만 교체 */
  body: HTMLElement;
  onApplied(): void;
}

interface Activity { role: "assistant" | "tool"; text: string; }
interface Settings { cli: string; model: string; effort: string; }
interface AnnotationCard { id: string; quote: string; comment: string; status: "pending" | "sent" | "done"; }

const SETTINGS_KEY = "fleet.codex.cowork.settings";
const BATCH_INSTRUCTION = "Revise the draft to address every saved annotation. Preserve unrelated content and summarize the changes.";

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
  let optionsDto: CoworkOptionsResponse = { clis: [], models: [], efforts: [] };
  let settings = readSettings();
  let annotations: AnnotationCard[] = [];
  let activities: Activity[] = [];
  let streamingReply = false;
  let selection: { quote: string; top: number; left: number } | null = null;
  let composerOpen = false;
  let panelOpen = false;
  let configOpen = false;
  let confirmAction: "apply" | "discard" | null = null;
  let summaryVisible = false;
  let diffVisible = false;
  let promptText = "";
  let error = "";
  let lastBodyKey = "published";
  let lastDockHtml: string | null = null;
  let diffMemo: { base: string; draft: string; lines: readonly DraftLine[] } | null = null;

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
  options.article.classList.add("cowork-host");
  options.article.append(anchor, dockZone);

  // ── 렌더 ────────────────────────────────────────────────────────────────────

  const renderBody = () => {
    if (disposed) return;
    const engaged = !!session && session.state !== "closed";
    const key = !engaged ? "published" : diffVisible ? `diff:${session!.draft}` : `draft:${session!.draft}`;
    if (key === lastBodyKey) return;
    lastBodyKey = key;
    if (!engaged) { options.body.innerHTML = publishedHtml; return; }
    options.body.innerHTML = diffVisible
      ? `<div class="cowork-rendered-diff" aria-label="Draft changes">${renderRenderedDiff(stripFrontmatter(session!.baseDraft), stripFrontmatter(session!.draft))}</div>`
      : renderMarkdown(stripFrontmatter(session!.draft), { omitDuplicateTitle: options.title, resolveWikiLink: (id) => entryPath(id) }).html;
  };

  const renderAnchor = () => {
    if (disposed) return;
    if (!selection) { anchor.innerHTML = ""; return; }
    // 중앙 정렬(translateX(-50%)) 기준이므로 요소 절반 폭만큼 안쪽으로 클램프해야
    // 문서 좌우 경계에서 잘리지 않는다. 컴포저 폭은 CSS min(340px, 86%)와 동기.
    const hostWidth = options.article.getBoundingClientRect().width || 0;
    const half = composerOpen ? Math.min(340, hostWidth * 0.86) / 2 + 8 : 56;
    const left = Math.min(Math.max(selection.left, half), Math.max(hostWidth - half, half));
    const at = `style="top:${selection.top}px;left:${left}px"`;
    anchor.innerHTML = composerOpen
      ? `<div class="cowork-composer" ${at} role="dialog" aria-label="Add a comment">
          <blockquote>${escapeHtml(clip(selection.quote, 140))}</blockquote>
          <textarea class="cowork-composer-input" rows="2" placeholder="What should change here?" aria-label="Comment"></textarea>
          <div class="cowork-composer-actions">
            <button type="button" class="cowork-ghost" data-cowork-action="cancel-comment">Cancel</button>
            <button type="button" class="cowork-solid" data-cowork-action="add-comment">Add</button>
          </div>
        </div>`
      : `<button type="button" class="cowork-pill" data-cowork-action="comment" ${at}><span aria-hidden="true">✦</span>Comment</button>`;
    if (composerOpen) anchor.querySelector<HTMLTextAreaElement>(".cowork-composer-input")?.focus();
  };

  const renderDock = () => {
    if (disposed) return;
    const engaged = !!session && session.state !== "closed" && session.state !== "applied";
    dockZone.classList.toggle("is-open", engaged);
    if (!engaged) { dockZone.innerHTML = ""; lastDockHtml = null; return; }
    const running = session!.state === "running";
    const changed = draftLines().filter(line => line.changed).length;
    const summary = summaryVisible ? [...activities].reverse().find(a => a.role === "assistant")?.text ?? "" : "";
    const ticker = [...activities].reverse().find(a => a.role === "tool")?.text ?? "AI is editing…";
    setDockHtml(`
      ${summary ? `<div class="cowork-summary" role="status"><span aria-hidden="true">✦</span><p>${escapeHtml(summary)}</p><button type="button" class="cowork-x" data-cowork-action="dismiss-summary" aria-label="Dismiss summary">×</button></div>` : ""}
      ${panelOpen ? renderPanel() : ""}
      ${configOpen ? renderConfig() : ""}
      ${changed > 0 && !running ? renderReview(changed) : ""}
      <div class="cowork-bar" data-cowork-form>
        ${running
          ? `<span class="cowork-glow" aria-hidden="true"></span><span class="cowork-spinner" aria-hidden="true"></span><span class="cowork-ticker" aria-live="polite">${escapeHtml(clip(ticker, 90))}</span><button type="button" class="cowork-ghost" data-cowork-action="cancel-run">Stop</button>`
          : `<button type="button" class="cowork-chip${panelOpen ? " is-active" : ""}" data-cowork-action="toggle-panel" aria-expanded="${panelOpen}" aria-label="Annotations"><span aria-hidden="true">✦</span>${annotations.length}</button>
             <input class="cowork-dock-input" name="prompt" value="${escapeAttribute(promptText)}" placeholder="${annotations.length ? "Add an instruction (optional)…" : "Ask AI to revise this entry…"}" aria-label="Instruction">
             <button type="button" class="cowork-chip cowork-chip--config${configOpen ? " is-active" : ""}" data-cowork-action="toggle-config" aria-expanded="${configOpen}" aria-label="Agent settings">${escapeHtml(settings.cli || "agent")}</button>
             <button type="button" class="cowork-send" data-cowork-action="send" aria-label="Send to AI">↑</button>`}
      </div>
      ${error ? `<p class="cowork-error" role="alert">${escapeHtml(error)}</p>` : ""}`);
  };

  // 스트리밍 중 동일 마크업 재구축은 등장 애니메이션 재시작(깜빡임)을 유발하므로,
  // 실제 변경이 있을 때만 교체하고 포커스 중이던 입력은 복원한다.
  const setDockHtml = (html: string) => {
    if (html === lastDockHtml) return;
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

  const renderPanel = () => `
    <div class="cowork-popover cowork-panel" role="region" aria-label="Annotations">
      ${annotations.length === 0 ? '<p class="cowork-empty">Select text in the document to add a comment.</p>' : annotations.map(card => `
        <article class="cowork-card is-${card.status}">
          <blockquote>${escapeHtml(clip(card.quote, 160))}</blockquote>
          <textarea data-cowork-comment="${escapeAttribute(card.id)}" aria-label="Comment" placeholder="Add a comment" ${card.status === "sent" ? "disabled" : ""}>${escapeHtml(card.comment)}</textarea>
          <footer><span class="cowork-card-status">${card.status === "sent" ? "Sent" : card.status === "done" ? "Done" : "Ready"}</span><button type="button" class="cowork-x" data-cowork-action="delete-annotation" data-annotation-id="${escapeAttribute(card.id)}" aria-label="Delete annotation">×</button></footer>
        </article>`).join("")}
    </div>`;

  const renderConfig = () => `
    <div class="cowork-popover cowork-config" role="region" aria-label="Agent settings">
      ${select("CLI", "cli", optionsDto.clis, settings.cli)}${select("Model", "model", optionsDto.models, settings.model)}${select("Effort", "effort", optionsDto.efforts, settings.effort)}
    </div>`;

  const renderReview = (changed: number) => {
    if (confirmAction) {
      const question = confirmAction === "apply" ? "Apply these changes to the entry?" : "Discard this draft?";
      const proceed = confirmAction === "apply" ? "apply-confirm" : "discard-confirm";
      return `<div class="cowork-review is-confirm"><span>${question}</span><button type="button" class="cowork-solid${confirmAction === "discard" ? " cowork-solid--danger" : ""}" data-cowork-action="${proceed}">${confirmAction === "apply" ? "Apply" : "Discard"}</button><button type="button" class="cowork-ghost" data-cowork-action="confirm-back">Back</button></div>`;
    }
    return `<div class="cowork-review"><span class="cowork-review-count"><i aria-hidden="true"></i>${changed} changed line${changed === 1 ? "" : "s"}</span><button type="button" class="cowork-ghost" data-cowork-action="toggle-diff">${diffVisible ? "View draft" : "View diff"}</button><button type="button" class="cowork-solid" data-cowork-action="apply-arm">Apply</button><button type="button" class="cowork-ghost" data-cowork-action="discard-arm">Discard</button></div>`;
  };

  const redraw = () => { renderBody(); renderDock(); };

  // ── 세션 수명주기 ───────────────────────────────────────────────────────────

  const updateOptions = async () => {
    optionsDto = await fetchCoworkOptions(options.theaterId, settings.cli, settings.model || undefined);
    settings = {
      cli: optionsDto.clis.includes(settings.cli) ? settings.cli : optionsDto.clis[0] ?? "",
      model: optionsDto.models.includes(settings.model) ? settings.model : optionsDto.models[0] ?? "",
      effort: optionsDto.efforts.includes(settings.effort) ? settings.effort : optionsDto.efforts[0] ?? "",
    };
    saveSettings(settings);
  };

  const engage = async (next: CoworkSessionDto) => {
    session = next;
    // 지연 생성 경로에서는 서버에 아직 저장되지 않은 로컬 카드(첫 코멘트)를 보존해야 한다.
    const restored = next.annotations.map(annotationFromDto);
    const known = new Set(restored.map(card => card.id));
    annotations = [...restored, ...annotations.filter(card => !known.has(card.id))];
    if (next.cli || next.model || next.effort) {
      settings = { cli: next.cli ?? settings.cli, model: next.model ?? settings.model, effort: next.effort ?? settings.effort };
      saveSettings(settings);
    }
    try { await updateOptions(); } catch { /* 설정 팝오버가 비어 보일 뿐, 편집은 계속 가능하다. */ }
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
        const last = activities[activities.length - 1];
        if (streamingReply && last?.role === "assistant") last.text += event.text;
        else { activities.push({ role: "assistant", text: event.text }); streamingReply = true; }
      }
      if (event.type === "tool" && event.text) { activities.push({ role: "tool", text: event.text }); streamingReply = false; }
      if (event.type === "done") {
        streamingReply = false;
        summaryVisible = activities.some(a => a.role === "assistant");
        annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "done" } : card);
      }
      if (event.type === "error" || (event.type === "session" && wasRunning && session?.state !== "running")) {
        streamingReply = false;
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
    try {
      await ensureSession();
      await mutate(() => updateCoworkSelection(options.theaterId, session!.id, quote));
      await persistAnnotations();
    } catch { /* mutate가 오류를 표면화한다. */ }
  }

  async function deleteAnnotation(id: string): Promise<void> {
    annotations = annotations.filter(card => card.id !== id);
    renderDock();
    try { await persistAnnotations(); } catch { /* mutate가 오류를 표면화한다. */ }
  }

  async function persistAnnotations(): Promise<void> {
    if (!session) return;
    await mutate(() => updateCoworkAnnotations(options.theaterId, session!.id, annotations.map(annotationToDto)));
  }

  async function send(): Promise<void> {
    if (!session || session.state === "running") return;
    // 이미 반영된(done) 카드는 재전송 대상에서 제외한다.
    const outgoing = annotations.filter(card => card.status !== "done");
    const prompt = promptText.trim() || (outgoing.length ? BATCH_INSTRUCTION : "");
    if (!prompt) return;
    annotations = outgoing.map(card => ({ ...card, status: "sent" }));
    summaryVisible = false;
    promptText = "";
    panelOpen = false;
    configOpen = false;
    renderDock();
    try {
      await mutate(() => updateCoworkAnnotations(options.theaterId, session!.id, annotations.map(annotationToDto)));
      await mutate(() => promptCowork(options.theaterId, session!.id, prompt));
    } catch {
      annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "pending" } : card);
      renderDock();
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
      error = cause instanceof Error ? cause.message : "Cowork request failed.";
      renderDock();
      return;
    }
    unsubscribe?.();
    unsubscribe = null;
    lastEventId = 0;
    annotations = [];
    activities = [];
    confirmAction = null;
    summaryVisible = false;
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
      error = cause instanceof CoworkRequestError && ["cowork_apply_stale", "cowork_apply_stale_revision", "cowork_apply_busy"].includes(cause.code)
        ? "This entry changed or is busy. Your draft is safe; reopen the entry before applying."
        : cause instanceof Error ? cause.message : "Cowork request failed.";
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
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-cowork-action]") : null;
    if (!target) return;
    const action = target.dataset.coworkAction;
    if (action === "comment") { composerOpen = true; renderAnchor(); }
    if (action === "cancel-comment") { selection = null; composerOpen = false; renderAnchor(); }
    if (action === "add-comment") submitComposer();
    if (action === "toggle-panel") { panelOpen = !panelOpen; configOpen = false; renderDock(); }
    if (action === "toggle-config") { configOpen = !configOpen; panelOpen = false; renderDock(); }
    if (action === "send") void send();
    if (action === "toggle-diff") { diffVisible = !diffVisible; redraw(); }
    if (action === "dismiss-summary") { summaryVisible = false; renderDock(); }
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
        annotations = annotations.map(card => card.status === "sent" ? { ...card, status: "pending" } : card);
        renderDock();
      }).catch(() => undefined);
    }
  };

  const onInput = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.name === "prompt") { promptText = target.value; return; }
    if (target instanceof HTMLTextAreaElement && target.dataset.coworkComment) {
      const id = target.dataset.coworkComment;
      annotations = annotations.map(card => card.id === id ? { ...card, comment: target.value, status: "pending" } : card);
    }
  };

  const onChange = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && ["cli", "model", "effort"].includes(target.name)) {
      // CLI가 바뀌면 이전 CLI의 model/effort는 무효 — 리셋해야 새 CLI의 기본 목록을 받는다.
      settings = target.name === "cli"
        ? { cli: target.value, model: "", effort: "" }
        : { ...settings, [target.name]: target.value };
      saveSettings(settings);
      if (!session) return;
      if (target.name !== "effort") {
        void updateOptions()
          .then(() => mutate(() => updateCoworkSettings(options.theaterId, session!.id, settings)))
          .then(renderDock)
          .catch(cause => { error = cause instanceof Error ? cause.message : "Cowork request failed."; renderDock(); });
      } else void mutate(() => updateCoworkSettings(options.theaterId, session!.id, settings)).catch(() => undefined);
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

  return {
    destroy() {
      disposed = true;
      unsubscribe?.();
      options.article.removeEventListener("mouseup", onMouseUp);
      options.article.removeEventListener("mousedown", onMouseDown);
      options.article.removeEventListener("keydown", onKeyDown);
      options.article.removeEventListener("click", onClick);
      options.article.removeEventListener("input", onInput);
      options.article.removeEventListener("change", onChange);
      anchor.remove();
      dockZone.remove();
      options.article.classList.remove("cowork-host");
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function select(label: string, name: string, values: readonly string[], current: string): string {
  return `<label class="cowork-selector"><span>${label}</span><select name="${name}" ${values.length ? "" : "disabled"}>${values.map(value => `<option value="${escapeAttribute(value)}" ${value === current ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select></label>`;
}
// 소스 라인이 아닌 "렌더된 문서" 관점의 diff — 변경 블록은 하이라이트, 삭제 블록은
// 흐림+취소선으로 문서 흐름 안에 표시된다.
function renderRenderedDiff(base: string, draft: string): string {
  return diffDraftBlocks(base, draft).map(block => {
    const html = renderMarkdown(block.markdown, { resolveWikiLink: (id) => entryPath(id) }).html;
    return block.kind === "same" ? html : `<div class="cowork-block cowork-block--${block.kind}">${html}</div>`;
  }).join("");
}
function annotationToDto(card: AnnotationCard): CoworkAnnotationDto { return { id: card.id, text: `[${card.quote}]\n${card.comment.trim() || "Please revise this passage."}` }; }
function annotationFromDto(dto: CoworkAnnotationDto): AnnotationCard {
  const divider = dto.text.indexOf("]\n");
  return divider > 0 && dto.text.startsWith("[")
    ? { id: dto.id, quote: dto.text.slice(1, divider), comment: dto.text.slice(divider + 2), status: "pending" }
    : { id: dto.id, quote: "", comment: dto.text, status: "pending" };
}
function stripFrontmatter(markdown: string): string { return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); }
function clip(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function annotationId(): string { return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function readSettings(): Settings { try { const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}"); return { cli: typeof saved.cli === "string" ? saved.cli : "codex", model: typeof saved.model === "string" ? saved.model : "", effort: typeof saved.effort === "string" ? saved.effort : "" }; } catch { return { cli: "codex", model: "", effort: "" }; } }
function saveSettings(settings: Settings): void { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Storage is optional. */ } }
