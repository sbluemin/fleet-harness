import { renderMarkdown } from "@fleet-console/markdown/core";
import {
  applyCowork, cancelCowork, closeCowork, CoworkRequestError, createCoworkSession,
  fetchCoworkOptions, fetchCoworkSession, promptCowork, subscribeCoworkEvents,
  fetchCoworkTranscript, updateCoworkAnnotations, updateCoworkSelection, updateCoworkSettings,
} from "./api.js";
import type { CoworkAnnotationDto, CoworkOptionsResponse, CoworkSessionDto } from "./api.js";
import { diffDraftLines } from "./cowork-diff.js";
import { escapeHtml } from "./utils/html.js";

export interface CoworkController { destroy(): void; }
export interface MountCoworkOptions { theaterId: string | null; entryId: string; base: string; onApplied(): void; onExit(): void; }

interface Transcript { role: "user" | "assistant" | "system"; text: string; }
interface Settings { cli: string; model: string; effort: string; }
const SETTINGS_KEY = "fleet.codex.cowork.settings";

export async function mountCoworkInto(container: HTMLElement, options: MountCoworkOptions): Promise<CoworkController> {
  let disposed = false;
  let session: CoworkSessionDto | null = null;
  let unsubscribe: (() => void) | null = null;
  let lastEventId = 0;
  let optionsDto: CoworkOptionsResponse = { clis: [], models: [], efforts: [] };
  let settings = readSettings();
  let annotations: CoworkAnnotationDto[] = [];
  let quote = "";
  let transcripts: Transcript[] = [];
  let streamingReply = false;
  let error = "";

  const redraw = () => {
    if (disposed || !session) return;
    const current = renderMarkdown(options.base).html;
    const draft = renderMarkdown(session.draft).html;
    const changed = diffDraftLines(session.baseDraft || options.base, session.draft).filter(line => line.changed).length;
    container.innerHTML = `<section class="cowork-studio" aria-label="AI draft studio">
      <header class="cowork-studio-head"><div><p class="cowork-kicker">Codex · Cowork</p><h2>Draft studio</h2></div>
      <div class="cowork-head-actions"><span class="cowork-status" aria-live="polite">${escapeHtml(session.state === "running" ? "Writing" : session.state)}</span>
      <button type="button" class="cowork-action cowork-action--quiet" data-cowork-action="discard">Discard</button>
      <button type="button" class="cowork-action cowork-action--apply" data-cowork-action="apply" ${session.state === "running" || session.state === "applied" ? "disabled" : ""}>Apply draft</button></div></header>
      <div class="cowork-selectors" aria-label="Draft settings">
        ${select("CLI", "cli", optionsDto.clis, settings.cli)}${select("Model", "model", optionsDto.models, settings.model)}${select("Effort", "effort", optionsDto.efforts, settings.effort)}
      </div>
      <div class="cowork-panes"><article class="cowork-pane cowork-pane--current"><header><span>Current</span><button type="button" data-cowork-action="comment" ${quote ? "" : "disabled"}>Comment</button></header><div class="markdown-body cowork-markdown" data-cowork-current>${current}</div>
        <div class="cowork-annotations">${annotations.map(annotation => `<span class="cowork-annotation-chip">${escapeHtml(annotation.text)}</span>`).join("")}</div></article>
        <article class="cowork-pane cowork-pane--draft"><header><span>AI Draft</span><small>${changed} changed lines</small></header><div class="cowork-diff" aria-label="Draft changed lines">${renderDiff(session.baseDraft || options.base, session.draft)}</div><div class="markdown-body cowork-markdown">${draft}</div></article></div>
      <footer class="cowork-chat"><div class="cowork-transcript" aria-live="polite">${transcripts.map(turn => `<p class="cowork-turn cowork-turn--${turn.role}"><strong>${turn.role === "user" ? "You" : turn.role === "assistant" ? "AI" : "Cowork"}</strong>${escapeHtml(turn.text)}</p>`).join("")}</div>
        ${quote ? `<div class="cowork-quote"><span>${escapeHtml(quote)}</span><button type="button" data-cowork-action="clear-quote" aria-label="Remove quote">×</button></div>` : ""}
        <form class="cowork-composer" data-cowork-form><textarea name="prompt" rows="2" placeholder="Tell the draft what to change" aria-label="Message draft" ${session.state === "running" ? "disabled" : ""}></textarea>
        <button type="submit" class="cowork-action cowork-action--send" ${session.state === "running" ? "disabled" : ""}>Send</button>${session.state === "running" ? '<button type="button" class="cowork-action cowork-action--quiet" data-cowork-action="cancel">Cancel</button>' : ""}</form>
        ${error ? `<p class="cowork-error" role="alert">${escapeHtml(error)}</p>` : ""}</footer></section>`;
  };

  const updateOptions = async () => {
    optionsDto = await fetchCoworkOptions(options.theaterId, settings.cli, settings.model || undefined);
    settings = { cli: optionsDto.clis.includes(settings.cli) ? settings.cli : optionsDto.clis[0] ?? "", model: optionsDto.models.includes(settings.model) ? settings.model : optionsDto.models[0] ?? "", effort: optionsDto.efforts.includes(settings.effort) ? settings.effort : optionsDto.efforts[0] ?? "" };
    saveSettings(settings);
  };
  try {
    await updateOptions();
    session = await createCoworkSession(options.theaterId, options.entryId, settings);
    if (session.cli || session.model || session.effort) { settings = { cli: session.cli ?? settings.cli, model: session.model ?? settings.model, effort: session.effort ?? settings.effort }; saveSettings(settings); }
    try { transcripts = (await fetchCoworkTranscript(options.theaterId, session.id)).turns.map(turn => ({ role: turn.role, text: turn.text })); } catch { /* fresh session — no transcript yet */ }
    if (disposed) return { destroy() {} };
    subscribe(); redraw();
  } catch (cause) { container.innerHTML = `<div class="codex-reader-error" role="alert">${escapeHtml(message(cause))}</div>`; }

  function subscribe(): void {
    if (!session) return;
    unsubscribe?.();
    unsubscribe = subscribeCoworkEvents(options.theaterId, session.id, lastEventId, (event, id) => {
      lastEventId = Math.max(lastEventId, id);
      if (event.session) session = event.session;
      if (event.type === "transcript" && event.text) {
        const last = transcripts[transcripts.length - 1];
        if (streamingReply && last?.role === "assistant") last.text += event.text;
        else { transcripts.push({ role: "assistant", text: event.text }); streamingReply = true; }
      }
      if (event.type === "done" || event.type === "error") streamingReply = false;
      if (event.type === "error" && event.text) error = event.text;
      redraw();
    });
  }
  const onMouseUp = () => {
    const selected = window.getSelection()?.toString().trim() ?? "";
    if (selected && container.querySelector("[data-cowork-current]")?.contains(window.getSelection()?.anchorNode ?? null)) { quote = selected; redraw(); }
  };
  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-cowork-action]") : null;
    if (!target || !session) return;
    const action = target.dataset.coworkAction;
    if (action === "clear-quote") { quote = ""; redraw(); return; }
    if (action === "comment" && quote) { annotations = [...annotations, { id: crypto.randomUUID(), text: quote }]; redraw(); return; }
    if (action === "cancel") void mutate(() => cancelCowork(options.theaterId, session!.id));
    if (action === "discard") void mutate(() => closeCowork(options.theaterId, session!.id), options.onExit);
    if (action === "apply" && window.confirm("Apply this draft to the entry?")) void mutate(() => applyCowork(options.theaterId, session!.id), options.onApplied);
  };
  const onChange = (event: Event) => {
    const input = event.target instanceof HTMLSelectElement ? event.target : null;
    if (!input || !["cli", "model", "effort"].includes(input.name)) return;
    settings = { ...settings, [input.name]: input.value }; saveSettings(settings);
    const push = () => { if (session) void mutate(() => updateCoworkSettings(options.theaterId, session!.id, settings)); };
    if (input.name !== "effort") void updateOptions().then(() => { push(); redraw(); }).catch(cause => { error = message(cause); redraw(); });
    else push();
  };
  const onSubmit = (event: SubmitEvent) => {
    if (!session) return; const form = event.target instanceof HTMLFormElement ? event.target : null; if (!form) return;
    event.preventDefault(); const prompt = new FormData(form).get("prompt"); if (typeof prompt !== "string" || !prompt.trim()) return;
    transcripts.push({ role: "user", text: prompt.trim() });
    void (async () => { await mutate(() => updateCoworkSelection(options.theaterId, session!.id, quote || null)); await mutate(() => updateCoworkAnnotations(options.theaterId, session!.id, annotations)); annotations = []; quote = ""; await mutate(() => promptCowork(options.theaterId, session!.id, prompt.trim())); })();
  };
  async function mutate(run: () => Promise<CoworkSessionDto>, success?: () => void): Promise<void> {
    try { error = ""; session = await run(); redraw(); success?.(); } catch (cause) { error = cause instanceof CoworkRequestError && cause.code === "cowork_apply_stale" ? "This entry changed elsewhere. Your draft is still available; refresh the entry before applying." : message(cause); redraw(); }
  }
  container.addEventListener("mouseup", onMouseUp);
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  return { destroy() { disposed = true; unsubscribe?.(); container.removeEventListener("mouseup", onMouseUp); container.removeEventListener("click", onClick); container.removeEventListener("change", onChange); container.removeEventListener("submit", onSubmit); } };
}

function select(label: string, name: string, values: readonly string[], current: string): string { return `<label class="cowork-selector"><span>${label}</span><select name="${name}" ${values.length ? "" : "disabled"}>${values.map(value => `<option value="${escapeHtml(value)}" ${value === current ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select></label>`; }
function renderDiff(base: string, draft: string): string { return diffDraftLines(base, draft).map((line, index) => `<div class="cowork-diff-line${line.changed ? " is-changed" : ""}"><span>${index + 1}</span><code>${escapeHtml(line.text)}</code></div>`).join(""); }
function readSettings(): Settings { try { const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}"); return { cli: typeof saved.cli === "string" ? saved.cli : "codex", model: typeof saved.model === "string" ? saved.model : "", effort: typeof saved.effort === "string" ? saved.effort : "" }; } catch { return { cli: "codex", model: "", effort: "" }; } }
function saveSettings(settings: Settings): void { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage is optional */ } }
function message(error: unknown): string { return error instanceof Error ? error.message : "Cowork request failed."; }
