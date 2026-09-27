import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Select } from "@fleet-console/sdk/react/browser";

import { useT } from "../../../core/client/src/i18n/index.js";
import { useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import type { TheaterInfo } from "../../../core/client/src/integration/types.js";
import { useTheaterLabel } from "../../../core/client/src/hooks/use-store.js";
import { CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS, fetchTheaterSystemPrompt, saveTheaterSystemPrompt, type ClaudeCodeSystemPromptMode, type TheaterSystemPrompt } from "./execution-settings.js";
import "./theater-system-prompt-sheet.css";

interface OpenRequest { readonly theater: TheaterInfo; readonly anchor: DOMRect | null; readonly returnFocus: HTMLElement | null }
const OPEN_EVENT = "fleet:theater-system-prompt-open";
const CHANGED_EVENT = "fleet:theater-system-prompt-changed";

export function openTheaterSystemPrompt(theater: TheaterInfo, returnFocus: HTMLElement | null, anchor?: DOMRect | null): void {
  window.dispatchEvent(new CustomEvent<OpenRequest>(OPEN_EVENT, { detail: { theater, returnFocus, anchor: anchor ?? null } }));
}

export function subscribeTheaterSystemPromptChange(listener: (theaterId: string, prompt: TheaterSystemPrompt | null) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ theaterId: string; prompt: TheaterSystemPrompt | null }>).detail;
    listener(detail.theaterId, detail.prompt);
  };
  window.addEventListener(CHANGED_EVENT, handler);
  return () => window.removeEventListener(CHANGED_EVENT, handler);
}

function announce(theaterId: string, prompt: TheaterSystemPrompt | null) {
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { theaterId, prompt } }));
}

export function TheaterSystemPromptSheet() {
  const t = useT();
  const mobile = useViewMode().effective === "mobile";
  const [request, setRequest] = useState<OpenRequest | null>(null);
  const registeredLabel = useTheaterLabel(request?.theater.id);
  const [stored, setStored] = useState<TheaterSystemPrompt | null>(null);
  const [draft, setDraft] = useState<TheaterSystemPrompt>({ mode: "on", body: "" });
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "over" | "error">("saved");
  const [undo, setUndo] = useState<TheaterSystemPrompt | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const selectRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(request);
  const draftRef = useRef(draft);
  const storedRef = useRef(stored);
  const queueRef = useRef(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  requestRef.current = request;
  draftRef.current = draft;
  storedRef.current = stored;

  const persist = useCallback((theaterId: string, next: TheaterSystemPrompt) => {
    if (next.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS) { setStatus("over"); return; }
    const value = next.mode === "on" && !next.body.trim() ? null : next;
    dirtyRef.current = false;
    setStatus("saving");
    const revision = ++revisionRef.current;
    queueRef.current = queueRef.current.catch(() => undefined).then(async () => {
      try {
        const saved = (await saveTheaterSystemPrompt(theaterId, value)).prompt;
        announce(theaterId, saved);
        if (requestRef.current?.theater.id === theaterId && revision === revisionRef.current) {
          storedRef.current = saved;
          setStored(saved);
          setStatus("saved");
        }
      } catch (error) {
        if (requestRef.current?.theater.id === theaterId && revision === revisionRef.current) {
          if ((error as { status?: number }).status === 404) { clearTimeout(timerRef.current ?? undefined); requestRef.current?.returnFocus?.focus(); setRequest(null); }
          else { dirtyRef.current = true; setStatus("error"); }
        }
      }
    });
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const flush = useCallback(() => {
    clearTimer();
    const current = requestRef.current;
    if (current && dirtyRef.current) persist(current.theater.id, draftRef.current);
  }, [clearTimer, persist]);

  const close = useCallback(() => {
    fetchControllerRef.current?.abort();
    flush();
    const opener = requestRef.current?.returnFocus;
    setRequest(null);
    setUndo(null);
    if (opener?.isConnected) window.requestAnimationFrame(() => opener.focus());
  }, [flush]);

  useEffect(() => {
    const open = (event: Event) => {
      const next = (event as CustomEvent<OpenRequest>).detail;
      fetchControllerRef.current?.abort();
      if (requestRef.current) flush();
      clearTimer();
      revisionRef.current++;
      dirtyRef.current = false;
      setRequest(next);
      setStored(null);
      setDraft({ mode: "on", body: "" });
      setUndo(null);
      setStatus("saved");
      setLoadFailed(false);
      setLoading(true);
      const controller = new AbortController();
      fetchControllerRef.current = controller;
      void queueRef.current.catch(() => undefined).then(() => {
        if (controller.signal.aborted) return null;
        return fetchTheaterSystemPrompt(next.theater.id, controller.signal);
      }).then((result) => {
        if (!result) return;
        const { prompt } = result;
        if (requestRef.current?.theater.id !== next.theater.id) return;
        storedRef.current = prompt;
        draftRef.current = prompt ?? { mode: "on", body: "" };
        setStored(prompt);
        setDraft(draftRef.current);
        setLoading(false);
        window.requestAnimationFrame(() => selectRef.current?.querySelector<HTMLButtonElement>('button[role="combobox"]')?.focus());
      }).catch((error) => {
        if (!controller.signal.aborted && requestRef.current?.theater.id === next.theater.id) {
          if ((error as { status?: number }).status === 404) { next.returnFocus?.focus(); setRequest(null); }
          else { setLoading(false); setLoadFailed(true); }
        }
      });
    };
    window.addEventListener(OPEN_EVENT, open);
    return () => { window.removeEventListener(OPEN_EVENT, open); fetchControllerRef.current?.abort(); clearTimer(); };
  }, [clearTimer, flush]);

  useLayoutEffect(() => {
    if (request && !loading) selectRef.current?.querySelector<HTMLButtonElement>('button[role="combobox"]')?.focus();
  }, [request, loading]);

  useEffect(() => {
    if (!request || registeredLabel !== null) return;
    fetchControllerRef.current?.abort();
    clearTimer();
    setRequest(null);
    if (request.returnFocus?.isConnected) request.returnFocus.focus();
  }, [request, registeredLabel, clearTimer]);

  useEffect(() => {
    if (!request) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (selectRef.current?.querySelector('[aria-expanded="true"]')) return;
        event.preventDefault(); event.stopPropagation(); close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request, close]);

  if (!request) return null;
  const theater = request.theater;
  const sidebarRight = document.querySelector(".operations-side-bar")?.getBoundingClientRect().right ?? request.anchor?.right ?? 8;
  const position = !mobile ? {
    left: Math.max(8, Math.min(window.innerWidth - 428, sidebarRight + 8)),
    top: Math.max(8, Math.min(request.anchor?.top ?? 80, window.innerHeight - (dialogRef.current?.offsetHeight ?? 480) - 8)),
  } : undefined;
  const modeNames: Record<ClaudeCodeSystemPromptMode, string> = {
    on: t("sidebar.theater.prompt.modeOn"), append: t("sidebar.theater.prompt.modeAppend"), off: t("sidebar.theater.prompt.modeOff"),
  };
  const caption = draft.mode === "on" ? t("sidebar.theater.prompt.captionOn")
    : draft.mode === "append" ? t(draft.body.trim() ? "sidebar.theater.prompt.captionAppend" : "sidebar.theater.prompt.captionEmpty")
      : t(draft.body.trim() ? "sidebar.theater.prompt.captionOff" : "sidebar.theater.prompt.captionOffEmpty");
  const changeMode = (mode: ClaudeCodeSystemPromptMode) => {
    clearTimer();
    const next = { ...draftRef.current, mode };
    draftRef.current = next;
    setDraft(next);
    setUndo(null);
    persist(theater.id, next);
  };
  const changeBody = (body: string) => {
    const next = { ...draftRef.current, body };
    draftRef.current = next;
    dirtyRef.current = true;
    setDraft(next);
    setUndo(null);
    clearTimer();
    if (body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS) { setStatus("over"); return; }
    setStatus("idle");
    timerRef.current = setTimeout(() => persist(theater.id, draftRef.current), 1000);
  };
  const reset = () => {
    clearTimer();
    setUndo(storedRef.current);
    const empty = { mode: "on" as const, body: "" };
    draftRef.current = empty;
    setDraft(empty);
    persist(theater.id, empty);
  };
  const restore = () => {
    if (!undo) return;
    draftRef.current = undo;
    setDraft(undo);
    persist(theater.id, undo);
    setUndo(null);
  };
  const trapTab = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') ?? []);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return createPortal(<>
    <div className={`theater-prompt-backdrop${mobile ? " is-mobile" : ""}`} onPointerDown={close} aria-hidden="true" />
    <section ref={dialogRef} className={`theater-prompt-sheet${mobile ? " is-mobile" : ""}`} style={position} role="dialog" aria-modal="true" aria-label={t("sidebar.theater.prompt.dialogAria", { theater: theater.label })} onKeyDown={trapTab}>
      <header className="theater-prompt-header">
        <span className="theater-prompt-mark" aria-hidden="true">{theater.label.trim().split(/[\s\-_.]+/).map((part) => Array.from(part)[0]).slice(0, 2).join("").toUpperCase() || "--"}</span>
        <span className="theater-prompt-heading"><strong>{theater.label}</strong><small>{t("sidebar.theater.prompt.title")}</small></span>
        <button type="button" className="theater-prompt-close" onClick={close} aria-label={t("sidebar.theater.prompt.close")}>×</button>
      </header>
      <p className="theater-prompt-scope">{t("sidebar.theater.prompt.scope")}
        <span className="theater-prompt-tip-wrap"><button type="button" className="theater-prompt-tip" aria-label={t("sidebar.theater.prompt.tipAria")}>?</button><span role="tooltip">{t("sidebar.theater.prompt.tip")}</span></span>
      </p>
      {!loading && !loadFailed ? <div className="theater-prompt-state"><span><i className={stored ? "is-own" : ""} />{stored ? t("sidebar.theater.prompt.own") : t("sidebar.theater.prompt.unset")}</span><small>{stored ? t("sidebar.theater.prompt.ownDetail") : t("sidebar.theater.prompt.unsetDetail")}</small>
        {stored ? <button type="button" onClick={reset}>{t("sidebar.theater.prompt.reset")}</button> : null}
        {undo ? <p role="status">{t("sidebar.theater.prompt.resetDone")} <button type="button" onClick={restore}>{t("sidebar.theater.prompt.undo")}</button></p> : null}
      </div> : null}
      {loading ? <p role="status">{t("sidebar.theater.prompt.loading")}</p> : loadFailed ? <p className="theater-prompt-save is-error" role="alert">{t("sidebar.theater.prompt.loadFailed")}</p> : <>
        <div className="theater-prompt-field" ref={selectRef}><span id="theater-prompt-mode-label">{t("sidebar.theater.prompt.modeLabel")}</span>
          <Select className="theater-prompt-select" aria-labelledby="theater-prompt-mode-label" value={draft.mode} options={(Object.keys(modeNames) as ClaudeCodeSystemPromptMode[]).map((mode) => ({ value: mode, label: modeNames[mode] }))} onChange={(mode) => changeMode(mode as ClaudeCodeSystemPromptMode)} />
        </div>
        {draft.mode === "on" && draft.body.trim() ? <div className="theater-prompt-kept"><details><summary>{t("sidebar.theater.prompt.kept", { count: draft.body.length })}</summary><pre>{draft.body}</pre></details><p>{t("sidebar.theater.prompt.keptHelp")}</p></div> : null}
        <label className="theater-prompt-field">{t("sidebar.theater.prompt.bodyLabel")}
          <textarea value={draft.body} onChange={(event) => changeBody(event.target.value)} onBlur={flush} rows={5} />
          <small className={draft.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS ? "is-over" : ""}>{draft.body.length.toLocaleString()} / 16,000</small>
        </label>
        <p className={draft.mode === "off" ? "theater-prompt-warning" : "theater-prompt-caption"}>{caption}</p>
        <p className={`theater-prompt-save is-${status}`} role="status" aria-live="polite"><i />{t(`sidebar.theater.prompt.save.${status}`)}</p>
      </>}
    </section>
  </>, document.body);
}
