import { renderMarkdown } from "@fleet-console/markdown/core";
import {
  applyCowork, cancelCowork, closeCowork, CoworkRequestError, createCoworkSession,
  fetchCoworkOptions, fetchCoworkTranscript, promptCowork, subscribeCoworkEvents,
  updateCoworkAnnotations, updateCoworkSelection, updateCoworkSettings,
} from "./api.js";
import type { CoworkAnnotationDto, CoworkOptionsResponse, CoworkSessionDto } from "./api.js";
import { diffDraftLines } from "./cowork-diff.js";
import { escapeHtml } from "./utils/html.js";

export interface CoworkController { destroy(): void; }
export interface MountCoworkOptions { theaterId: string | null; entryId: string; base: string; onApplied(): void; onExit(): void; }

interface Activity { role: "user" | "assistant" | "tool"; text: string; }
interface Settings { cli: string; model: string; effort: string; }
interface AnnotationCard { id: string; quote: string; comment: string; status: "pending" | "sent" | "done"; }
const SETTINGS_KEY = "fleet.codex.cowork.settings";

export async function mountCoworkInto(container: HTMLElement, options: MountCoworkOptions): Promise<CoworkController> {
  let disposed = false;
  let session: CoworkSessionDto | null = null;
  let unsubscribe: (() => void) | null = null;
  let lastEventId = 0;
  let optionsDto: CoworkOptionsResponse = { clis: [], models: [], efforts: [] };
  let settings = readSettings();
  let annotations: AnnotationCard[] = [];
  let selection = "";
  let selectionPosition: { top: number; left: number } | null = null;
  let activities: Activity[] = [];
  let streamingReply = false;
  let diffVisible = false;
  let error = "";

  const redraw = () => {
    if (disposed || !session) return;
    const changed = diffDraftLines(session.baseDraft || options.base, session.draft).filter(line => line.changed).length;
    const running = session.state === "running";
    const documentHtml = diffVisible
      ? `<div class="cowork-diff" aria-label="Draft line diff">${renderDiff(session.baseDraft || options.base, session.draft)}</div>`
      : renderMarkdown(session.draft).html;
    container.innerHTML = `<section class="cowork-margin" aria-label="Cowork annotations">
      <header class="cowork-margin-head">
        <div><p class="cowork-kicker">Codex · Cowork</p><h2>Draft annotations</h2></div>
        <div class="cowork-head-actions">
          <span class="cowork-status cowork-status--${escapeHtml(session.state)}" aria-live="polite">${escapeHtml(session.state.toUpperCase())}</span>
          <button type="button" class="cowork-action cowork-action--quiet" data-cowork-action="toggle-diff">${changed} changed lines</button>
          <button type="button" class="cowork-action cowork-action--quiet" data-cowork-action="discard" ${running ? "disabled" : ""}>Discard</button>
          <button type="button" class="cowork-action cowork-action--apply" data-cowork-action="apply" ${running || session.state === "applied" ? "disabled" : ""}>Apply</button>
        </div>
      </header>
      <div class="cowork-layout">
        <div class="cowork-document-wrap">
          <article class="markdown-body cowork-document" data-cowork-document>${documentHtml}</article>
          ${selection ? `<button type="button" class="cowork-selection-pill" data-cowork-action="comment" style="top:${selectionPosition?.top ?? 0}px;left:${selectionPosition?.left ?? 0}px">Comment</button>` : ""}
        </div>
        <aside class="cowork-margin-rail" aria-label="Annotations and activity">
          <p class="cowork-rail-label">Annotations · ${annotations.length}</p>
          <div class="cowork-annotation-list">${annotations.length ? annotations.map(renderAnnotation).join("") : '<p class="cowork-rail-empty">Select document text, then add a comment.</p>'}</div>
          <div class="cowork-activity" aria-live="polite"><p class="cowork-rail-label">Activity</p>${activities.length ? activities.map(renderActivity).join("") : '<p class="cowork-rail-empty">No activity yet.</p>'}</div>
        </aside>
      </div>
      <form class="cowork-batch-bar" data-cowork-form>
        <span class="cowork-batch-count">${annotations.length} annotation${annotations.length === 1 ? "" : "s"}</span>
        ${annotations.length === 0 ? '<input class="cowork-free-prompt" name="prompt" aria-label="Instruction" placeholder="Ask AI to revise this draft…">' : ""}
        <div class="cowork-selectors" aria-label="Agent settings">
          ${select("CLI", "cli", optionsDto.clis, settings.cli)}${select("Model", "model", optionsDto.models, settings.model)}${select("Effort", "effort", optionsDto.efforts, settings.effort)}
        </div>
        <button type="submit" class="cowork-action cowork-action--send" ${running ? "disabled" : ""}>Send to AI</button>
        ${running ? '<button type="button" class="cowork-action cowork-action--quiet" data-cowork-action="cancel">Cancel</button>' : ""}
      </form>
      ${error ? `<p class="cowork-error" role="alert">${escapeHtml(error)}</p>` : ""}
    </section>`;
  };

  const updateOptions = async () => {
    optionsDto = await fetchCoworkOptions(options.theaterId, settings.cli, settings.model || undefined);
    settings = {
      cli: optionsDto.clis.includes(settings.cli) ? settings.cli : optionsDto.clis[0] ?? "",
      model: optionsDto.models.includes(settings.model) ? settings.model : optionsDto.models[0] ?? "",
      effort: optionsDto.efforts.includes(settings.effort) ? settings.effort : optionsDto.efforts[0] ?? "",
    };
    saveSettings(settings);
  };

  try {
    await updateOptions();
    session = await createCoworkSession(options.theaterId, options.entryId, settings);
    if (session.cli || session.model || session.effort) {
      settings = { cli: session.cli ?? settings.cli, model: session.model ?? settings.model, effort: session.effort ?? settings.effort };
      saveSettings(settings);
    }
    annotations = session.annotations.map(annotationFromDto);
    try {
      activities = (await fetchCoworkTranscript(options.theaterId, session.id)).turns.map(turn => ({ role: turn.role, text: turn.text }));
    } catch { /* A new session has no transcript yet. */ }
    if (disposed) return { destroy() {} };
    subscribe();
    redraw();
  } catch (cause) {
    container.innerHTML = `<div class="codex-reader-error" role="alert">${escapeHtml(message(cause))}</div>`;
  }

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
      if (event.type === "tool" && event.text) activities.push({ role: "tool", text: event.text });
      if (event.type === "done") {
        streamingReply = false;
        annotations = annotations.map(annotation => annotation.status === "sent" ? { ...annotation, status: "done" } : annotation);
      }
      if (event.type === "error" || (event.type === "session" && wasRunning && session?.state !== "running")) {
        streamingReply = false;
        annotations = annotations.map(annotation => annotation.status === "sent" ? { ...annotation, status: "pending" } : annotation);
      }
      if (event.type === "error" && event.text) error = event.text;
      redraw();
    });
  }

  const onMouseUp = (event: MouseEvent) => {
    const range = window.getSelection();
    const quote = range?.toString().trim() ?? "";
    const document = container.querySelector<HTMLElement>("[data-cowork-document]");
    if (!quote || !document || !document.contains(range?.anchorNode ?? null)) return;
    selection = quote;
    selectionPosition = { top: Math.max(0, event.clientY - (container.getBoundingClientRect().top || 0) - 36), left: Math.max(0, event.clientX - (container.getBoundingClientRect().left || 0)) };
    redraw();
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-cowork-action]") : null;
    if (!target || !session) return;
    const action = target.dataset.coworkAction;
    if (action === "comment" && selection) void addAnnotation(selection);
    if (action === "delete-annotation" && target.dataset.annotationId) void deleteAnnotation(target.dataset.annotationId);
    if (action === "toggle-diff") { diffVisible = !diffVisible; redraw(); }
    if (action === "cancel") void mutate(() => cancelCowork(options.theaterId, session!.id)).then(() => {
      annotations = annotations.map(annotation => annotation.status === "sent" ? { ...annotation, status: "pending" } : annotation);
      redraw();
    }).catch(() => undefined);
    if (action === "discard") void mutate(() => closeCowork(options.theaterId, session!.id), options.onExit).catch(() => undefined);
    if (action === "apply" && window.confirm("Apply this draft to the entry?")) {
      void mutate(() => applyCowork(options.theaterId, session!.id, session!.revision), options.onApplied).catch(() => undefined);
    }
  };

  const onChange = (event: Event) => {
    if (event.target instanceof HTMLSelectElement && ["cli", "model", "effort"].includes(event.target.name)) {
      settings = { ...settings, [event.target.name]: event.target.value };
      saveSettings(settings);
      if (event.target.name !== "effort") {
        void updateOptions().then(() => mutate(() => updateCoworkSettings(options.theaterId, session!.id, settings))).then(redraw).catch(cause => { error = message(cause); redraw(); });
      } else void mutate(() => updateCoworkSettings(options.theaterId, session!.id, settings)).catch(() => undefined);
      return;
    }
    const textarea = event.target;
    if (textarea instanceof HTMLTextAreaElement && textarea.dataset.coworkComment) {
      annotations = annotations.map(annotation => annotation.id === textarea.dataset.coworkComment ? { ...annotation, comment: textarea.value, status: "pending" } : annotation);
      void persistAnnotations();
    }
  };

  const onSubmit = (event: SubmitEvent) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !session) return;
    event.preventDefault();
    const freePrompt = new FormData(form).get("prompt");
    const prompt = annotations.length > 0
      ? "Revise the draft to address every saved annotation. Preserve unrelated content and summarize the changes."
      : typeof freePrompt === "string" ? freePrompt.trim() : "";
    if (!prompt) return;
    activities.push({ role: "user", text: prompt });
    annotations = annotations.map(annotation => ({ ...annotation, status: "sent" }));
    redraw();
    void (async () => {
      try {
        await mutate(() => updateCoworkAnnotations(options.theaterId, session!.id, annotations.map(annotationToDto)));
        await mutate(() => promptCowork(options.theaterId, session!.id, prompt));
      } catch { /* mutate already surfaces the error. */ }
    })();
  };

  async function addAnnotation(quote: string): Promise<void> {
    if (!session) return;
    annotations = [...annotations, { id: annotationId(), quote, comment: "", status: "pending" }];
    selection = "";
    selectionPosition = null;
    redraw();
    try {
      await mutate(() => updateCoworkSelection(options.theaterId, session!.id, quote));
      await persistAnnotations();
    } catch { /* mutate already surfaces the error. */ }
  }

  async function deleteAnnotation(id: string): Promise<void> {
    annotations = annotations.filter(annotation => annotation.id !== id);
    redraw();
    try { await persistAnnotations(); } catch { /* mutate already surfaces the error. */ }
  }

  async function persistAnnotations(): Promise<void> {
    if (!session) return;
    await mutate(() => updateCoworkAnnotations(options.theaterId, session!.id, annotations.map(annotationToDto)));
  }

  async function mutate(run: () => Promise<CoworkSessionDto>, success?: () => void): Promise<void> {
    try {
      error = "";
      session = await run();
      redraw();
      success?.();
    } catch (cause) {
      error = cause instanceof CoworkRequestError && ["cowork_apply_stale", "cowork_apply_stale_revision", "cowork_apply_busy"].includes(cause.code)
        ? "This entry changed or is busy. Your draft is still available; refresh the entry before applying."
        : message(cause);
      redraw();
      throw cause;
    }
  }

  container.addEventListener("mouseup", onMouseUp);
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  return {
    destroy() {
      disposed = true;
      unsubscribe?.();
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("click", onClick);
      container.removeEventListener("change", onChange);
      container.removeEventListener("submit", onSubmit);
    },
  };
}

function select(label: string, name: string, values: readonly string[], current: string): string {
  return `<label class="cowork-selector"><span>${label}</span><select name="${name}" ${values.length ? "" : "disabled"}>${values.map(value => `<option value="${escapeHtml(value)}" ${value === current ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select></label>`;
}
function renderDiff(base: string, draft: string): string { return diffDraftLines(base, draft).map((line, index) => `<div class="cowork-diff-line${line.changed ? " is-changed" : ""}"><span>${index + 1}</span><code>${escapeHtml(line.text)}</code></div>`).join(""); }
function renderAnnotation(annotation: AnnotationCard): string {
  const status = annotation.status === "sent" ? '<span class="cowork-spinner" aria-hidden="true"></span>Sent' : annotation.status === "done" ? "Done" : "Pending";
  return `<article class="cowork-annotation-card"><button type="button" class="cowork-annotation-delete" data-cowork-action="delete-annotation" data-annotation-id="${escapeHtml(annotation.id)}" aria-label="Delete annotation">×</button><blockquote>${escapeHtml(annotation.quote)}</blockquote><textarea data-cowork-comment="${escapeHtml(annotation.id)}" aria-label="Annotation comment" placeholder="Add a comment" ${annotation.status === "sent" ? "disabled" : ""}>${escapeHtml(annotation.comment)}</textarea><p class="cowork-annotation-status is-${annotation.status}">${status}</p></article>`;
}
function renderActivity(activity: Activity): string { return `<p class="cowork-activity-item cowork-activity-item--${activity.role}"><strong>${activity.role === "tool" ? "Tool" : activity.role === "assistant" ? "AI" : "You"}</strong>${escapeHtml(activity.text)}</p>`; }
function annotationToDto(annotation: AnnotationCard): CoworkAnnotationDto { return { id: annotation.id, text: `[${annotation.quote}]\n${annotation.comment.trim() || "Please revise this passage."}` }; }
function annotationFromDto(annotation: CoworkAnnotationDto): AnnotationCard {
  const divider = annotation.text.indexOf("]\n");
  return divider > 0 && annotation.text.startsWith("[")
    ? { id: annotation.id, quote: annotation.text.slice(1, divider), comment: annotation.text.slice(divider + 2), status: "pending" }
    : { id: annotation.id, quote: "", comment: annotation.text, status: "pending" };
}
function annotationId(): string { return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function readSettings(): Settings { try { const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}"); return { cli: typeof saved.cli === "string" ? saved.cli : "codex", model: typeof saved.model === "string" ? saved.model : "", effort: typeof saved.effort === "string" ? saved.effort : "" }; } catch { return { cli: "codex", model: "", effort: "" }; } }
function saveSettings(settings: Settings): void { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Storage is optional. */ } }
function message(error: unknown): string { return error instanceof Error ? error.message : "Cowork request failed."; }
