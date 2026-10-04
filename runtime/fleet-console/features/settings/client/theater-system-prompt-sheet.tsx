import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Select } from "@fleet-console/sdk/react/browser";
import { SettingsCard, SettingsRow, SettingsToggle } from "@fleet-console/sdk/settings/browser";

import { useT } from "../../../core/client/src/i18n/index.js";
import { useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import type { TheaterInfo } from "../../../core/client/src/integration/types.js";
import { useTheaterLabel } from "../../../core/client/src/hooks/use-store.js";
import { theaterInitials } from "../../workspace/client/sidebar/theater-initials.js";
import { TheaterMonogram } from "../../workspace/client/sidebar/theater-monogram.js";
import { CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS, fetchTheaterSubagents, fetchTheaterSystemPrompt, saveTheaterSubagents, saveTheaterSystemPrompt, type ClaudeCodeSystemPromptMode, type TheaterSystemPrompt } from "./execution-settings.js";
import "./theater-system-prompt-sheet.css";
import { MobileGroupLabel, MobileRadioRow } from "./settings-mobile.js";
import { MobileSheet } from "../../../core/client/src/chrome/mobile/mobile-sheet.js";
import { getMobileSheetStack, popMobileSheet, pushMobileSheet, type MobileSheetKind } from "../../../core/client/src/chrome/mobile/mobile-store.js";
import { SyncedTextarea } from "@fleet-console/sdk/composer";

interface OpenRequest { readonly theater: TheaterInfo; readonly anchor: DOMRect | null; readonly returnFocus: HTMLElement | null }
const OPEN_EVENT = "fleet:theater-system-prompt-open";
const CHANGED_EVENT = "fleet:theater-system-prompt-changed";
const FORGOTTEN_EVENT = "fleet:theater-system-prompt-forgotten";
// 서버에 저장할 수 없는 초안만 Theater별로 이 탭에 남긴다. 시트 닫기·다른 Theater 열기는 초안을 버리지 않는다.
const overLimitDrafts = new Map<string, TheaterSystemPrompt>();

export function subscribeTheaterSystemPromptForgotten(listener: (theater: string) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<string>).detail);
  window.addEventListener(FORGOTTEN_EVENT, handler);
  return () => window.removeEventListener(FORGOTTEN_EVENT, handler);
}

function announceForgotten(theater: string) {
  window.dispatchEvent(new CustomEvent(FORGOTTEN_EVENT, { detail: theater }));
}

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

/**
 * On a phone the sheet is drawn by the mobile sheet host (S-16), while this component keeps every
 * piece of state and every save. Each render publishes what the sheet shows; the hosted sheet
 * only reads it, so nothing about loading, saving or forgetting is written twice.
 */
interface MobilePromptView { readonly title: string; readonly body: ReactNode; readonly close: () => void }
let mobilePromptView: MobilePromptView | null = null;
const mobilePromptListeners = new Set<() => void>();
function publishMobilePromptView(view: MobilePromptView | null) {
  if (view === mobilePromptView) return;
  mobilePromptView = view;
  for (const listener of mobilePromptListeners) listener();
}
function subscribeMobilePromptView(listener: () => void) {
  mobilePromptListeners.add(listener);
  return () => { mobilePromptListeners.delete(listener); };
}

function MobilePromptSheetView({ sheet, onDismiss }: { readonly sheet: MobileSheetKind; readonly onDismiss: () => void }) {
  const view = useSyncExternalStore(subscribeMobilePromptView, () => mobilePromptView, () => null);
  // The host can drop this sheet on its own (hardware back, Esc); the open prompt then closes with it.
  useEffect(() => () => { mobilePromptView?.close(); }, []);
  if (!view) return null;
  // A late dismissal must never pop whichever sheet came after this one.
  const dismiss = () => { if (getMobileSheetStack().at(-1) === sheet) onDismiss(); };
  return <MobileSheet title={view.title} onClose={dismiss}>{view.body}</MobileSheet>;
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
  const [status, setStatus] = useState<"untouched" | "idle" | "saving" | "saved" | "over" | "error">("untouched");
  const [undo, setUndo] = useState<TheaterSystemPrompt | null>(null);
  const [sheetTop, setSheetTop] = useState(8);
  const [tipVisible, setTipVisible] = useState(false);
  const [tipPosition, setTipPosition] = useState({ top: 0, left: 0 });
  // 시트를 연 채로 Theater가 잊히면(다른 창·API·Console Use) 닫지 않고 이 상태로 머문다 — 입력한 글이 조용히
  // 사라지지 않게 보여 주고, 그사이 Theater가 되돌아오면 이어서 저장한다.
  const [forgotten, setForgotten] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const selectRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const forgottenTextRef = useRef<HTMLTextAreaElement>(null);
  const draftTextRef = useRef<HTMLTextAreaElement>(null);
  const forgottenRef = useRef(false);
  const loadedRef = useRef(false);
  const focusAfterResetRef = useRef<"undo" | "select" | null>(null);
  const requestRef = useRef(request);
  const draftRef = useRef(draft);
  const storedRef = useRef(stored);
  const queueRef = useRef(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  // 열기/닫기 순서는 렌더보다 앞설 수 있다. 비동기 GET은 렌더 중 동기화되는 state가 아닌 토큰으로 소유권을 판정한다.
  const openIdRef = useRef(0);
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const mobileViewRef = useRef<MobilePromptView | null>(null);
  mobileViewRef.current = null;
  useLayoutEffect(() => { publishMobilePromptView(mobileViewRef.current); });
  const mobileSheetOpen = mobile && request !== null;
  useEffect(() => {
    if (!mobileSheetOpen) return;
    const sheet: MobileSheetKind = { kind: "custom", render: (close) => <MobilePromptSheetView sheet={sheet} onDismiss={close} /> };
    pushMobileSheet(sheet);
    return () => { if (getMobileSheetStack().at(-1) === sheet) popMobileSheet(); };
  }, [mobileSheetOpen]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  // 잊힌 Theater에는 더 저장하지 않는다. 대기 중인 저장·불러오기를 멈추고, 입력은 draft에 그대로 둔다.
  const markForgotten = useCallback(() => {
    if (!requestRef.current || forgottenRef.current) return;
    forgottenRef.current = true;
    clearTimer();
    ++openIdRef.current;
    fetchControllerRef.current?.abort();
    setLoading(false);
    setTipVisible(false);
    setUndo(null);
    setCopied(false);
    setForgotten(true);
  }, [clearTimer]);

  const persist = useCallback((theaterId: string, next: TheaterSystemPrompt, keepDraft = false) => {
    if (next.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS) {
      overLimitDrafts.set(theaterId, next);
      setStatus("over");
      return;
    }
    if (forgottenRef.current) return;
    const keptDraft = overLimitDrafts.get(theaterId);
    const value = next.mode === "on" && !next.body.trim() ? null : next;
    dirtyRef.current = false;
    setStatus("saving");
    const revision = ++revisionRef.current;
    queueRef.current = queueRef.current.catch(() => undefined).then(async () => {
      try {
        const saved = (await saveTheaterSystemPrompt(theaterId, value)).prompt;
        announce(theaterId, saved);
        // 앞선 정상 저장이 끝나는 사이 새 긴 초안이 생겼다면 그것까지 지우지 않는다.
        if (!keepDraft && overLimitDrafts.get(theaterId) === keptDraft) overLimitDrafts.delete(theaterId);
        if (requestRef.current?.theater.id === theaterId && revision === revisionRef.current) {
          storedRef.current = saved;
          setStored(saved);
          setStatus(draftRef.current.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS ? "over" : "saved");
        }
      } catch (error) {
        if (requestRef.current?.theater.id === theaterId && revision === revisionRef.current) {
          // 방송을 놓친 경우(끊긴 스트림)에도 저장이 404로 알려 준다 — 같은 잊힘 상태로 보인다.
          if ((error as { status?: number }).status === 404) { dirtyRef.current = true; markForgotten(); }
          else { dirtyRef.current = true; setStatus("error"); }
        }
      }
    });
  }, [markForgotten]);

  const flush = useCallback(() => {
    clearTimer();
    const current = requestRef.current;
    if (current && dirtyRef.current) persist(current.theater.id, draftRef.current);
  }, [clearTimer, persist]);

  const close = useCallback(() => {
    ++openIdRef.current;
    fetchControllerRef.current?.abort();
    flush();
    const opener = requestRef.current?.returnFocus;
    requestRef.current = null;
    forgottenRef.current = false;
    focusAfterResetRef.current = null;
    setRequest(null);
    setForgotten(false);
    setTipVisible(false);
    setUndo(null);
    if (opener?.isConnected) window.requestAnimationFrame(() => opener.focus());
  }, [flush]);

  useEffect(() => {
    const open = (event: Event) => {
      const next = (event as CustomEvent<OpenRequest>).detail;
      fetchControllerRef.current?.abort();
      if (requestRef.current) flush();
      clearTimer();
      const openId = ++openIdRef.current;
      revisionRef.current++;
      dirtyRef.current = false;
      forgottenRef.current = false;
      loadedRef.current = false;
      requestRef.current = next;
      focusAfterResetRef.current = null;
      storedRef.current = null;
      draftRef.current = { mode: "on", body: "" };
      setRequest(next);
      setTipVisible(false);
      setStored(null);
      setDraft(draftRef.current);
      setUndo(null);
      setForgotten(false);
      setCopied(false);
      setStatus("untouched");
      setLoadFailed(false);
      setLoading(true);
      const controller = new AbortController();
      fetchControllerRef.current = controller;
      void queueRef.current.catch(() => undefined).then(() => {
        if (controller.signal.aborted) return null;
        return fetchTheaterSystemPrompt(next.theater.id, controller.signal);
      }).then((result) => {
        if (openIdRef.current !== openId) return;
        if (!result || controller.signal.aborted) { setLoading(false); setLoadFailed(true); return; }
        const { prompt } = result;
        loadedRef.current = true;
        storedRef.current = prompt;
        // 대기 저장이 끝난 뒤의 초안을 읽는다. 느린 GET과 앞선 저장값은 탭에 남긴 글을 덮지 않는다.
        const keptDraft = overLimitDrafts.get(next.theater.id);
        draftRef.current = keptDraft ?? prompt ?? { mode: "on", body: "" };
        dirtyRef.current = !!keptDraft;
        setStored(prompt);
        setDraft(draftRef.current);
        if (keptDraft) setStatus("over");
        setLoading(false);
      }).catch((error) => {
        if (openIdRef.current !== openId) return;
        if ((error as { status?: number }).status === 404) {
          ++openIdRef.current;
          requestRef.current = null;
          setRequest(null);
          if (next.returnFocus?.isConnected) next.returnFocus.focus();
          announceForgotten(next.theater.label);
        } else { setLoading(false); setLoadFailed(true); }
      });
    };
    window.addEventListener(OPEN_EVENT, open);
    return () => { window.removeEventListener(OPEN_EVENT, open); ++openIdRef.current; fetchControllerRef.current?.abort(); clearTimer(); };
  }, [clearTimer, flush]);

  useLayoutEffect(() => {
    if (request && requestRef.current === request && !loading && !loadFailed) selectRef.current?.querySelector<HTMLButtonElement>('button[role="combobox"]')?.focus();
  }, [request, loading, loadFailed]);

  useLayoutEffect(() => {
    if (!request || !focusAfterResetRef.current) return;
    if (focusAfterResetRef.current === "undo") undoRef.current?.focus();
    else selectRef.current?.querySelector<HTMLButtonElement>('button[role="combobox"]')?.focus();
    focusAfterResetRef.current = null;
  }, [request, undo]);

  useLayoutEffect(() => {
    if (!request || mobile || !dialogRef.current) return;
    const sheet = dialogRef.current;
    const measure = () => {
      const viewportHeight = window.innerHeight;
      const height = Math.min(sheet.scrollHeight + sheet.offsetHeight - sheet.clientHeight, viewportHeight - 16);
      const top = Math.max(8, Math.min(request.anchor?.top ?? 80, viewportHeight - height - 8));
      setSheetTop((current) => current === top ? current : top);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sheet);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [request, mobile, loading]);

  useEffect(() => {
    if (!request || requestRef.current !== request) return;
    if (registeredLabel === null) { markForgotten(); return; }
    if (!forgottenRef.current) return;
    // Theater가 되돌아왔다. 저장하지 못한 입력이 있으면 그것을 이어서 저장하고, 없으면 서버 값을 다시 읽는다 —
    // 유예 안의 되돌리기는 값도 함께 되살리지만, 만료 뒤 다시 등록된 Theater에는 옛 값이 없다.
    forgottenRef.current = false;
    setForgotten(false);
    const saved = storedRef.current ?? { mode: "on", body: "" };
    const draftNow = draftRef.current;
    if (loadedRef.current && (dirtyRef.current || draftNow.mode !== saved.mode || draftNow.body !== saved.body)) persist(request.theater.id, draftNow);
    else window.dispatchEvent(new CustomEvent<OpenRequest>(OPEN_EVENT, { detail: request }));
  }, [request, registeredLabel, markForgotten, persist]);

  // 편집 칸이 사라지면서 포커스가 문서로 떨어지지 않게, 남은 글을 복사하는 버튼(없으면 닫기)으로 옮긴다.
  useLayoutEffect(() => {
    if (!forgotten) return;
    const target = copyRef.current ?? closeRef.current;
    if (dialogRef.current?.contains(document.activeElement) || document.activeElement === document.body) target?.focus();
  }, [forgotten]);

  useLayoutEffect(() => {
    if (!request || !tipVisible) return;
    const place = () => {
      const box = tipRef.current?.getBoundingClientRect();
      if (!box) return;
      setTipPosition({ top: Math.max(8, Math.min(window.innerHeight - (tooltipRef.current?.offsetHeight ?? 90) - 8, box.bottom + 6)), left: Math.max(8, Math.min(window.innerWidth - 298, box.right - 290)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [request, tipVisible]);

  useEffect(() => {
    if (!request) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (selectRef.current?.querySelector('[aria-expanded="true"]')) return;
        event.preventDefault(); event.stopPropagation();
        if (tipVisible) setTipVisible(false);
        else close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request, close, tipVisible]);

  if (!request) return null;
  const theater = request.theater;
  const sidebarRight = document.querySelector(".operations-side-bar")?.getBoundingClientRect().right ?? request.anchor?.right ?? 8;
  const position = !mobile ? {
    left: Math.max(8, Math.min(window.innerWidth - 428, sidebarRight + 8)),
    top: sheetTop,
    maxHeight: `calc(100dvh - ${sheetTop + 8}px)`,
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
    setCopied(false);
    if (next.mode === "on" && next.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS) {
      // 기본 모드로 돌아가도 긴 글은 버리지 않는다. 서버에는 마지막 정상 본문과 모드만 저장한다.
      overLimitDrafts.set(theater.id, next);
      persist(theater.id, { mode: "on", body: storedRef.current?.body ?? "" }, true);
    } else persist(theater.id, next);
  };
  const changeBody = (body: string) => {
    const next = { ...draftRef.current, body };
    draftRef.current = next;
    dirtyRef.current = true;
    setDraft(next);
    setUndo(null);
    setCopied(false);
    clearTimer();
    if (body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS) {
      overLimitDrafts.set(theater.id, next);
      setStatus("over");
      return;
    }
    setStatus("idle");
    timerRef.current = setTimeout(() => persist(theater.id, draftRef.current), 1000);
  };
  const reset = () => {
    clearTimer();
    overLimitDrafts.delete(theater.id);
    setUndo(storedRef.current);
    const empty = { mode: "on" as const, body: "" };
    draftRef.current = empty;
    setDraft(empty);
    focusAfterResetRef.current = "undo";
    persist(theater.id, empty);
  };
  const restore = () => {
    if (!undo) return;
    draftRef.current = undo;
    setDraft(undo);
    persist(theater.id, undo);
    focusAfterResetRef.current = "select";
    setUndo(null);
  };
  const saved = stored ?? { mode: "on" as const, body: "" };
  const unsaved = forgotten && (draft.mode !== saved.mode || draft.body !== saved.body);
  const copyDraft = () => {
    const text = draftRef.current.body;
    const selectText = () => {
      // 클립보드 권한이 없으면 글을 선택해 두어 직접 복사할 수 있게 한다.
      const field = forgottenTextRef.current ?? draftTextRef.current;
      if (field) { field.focus(); field.select(); return; }
      const kept = dialogRef.current?.querySelector(".theater-prompt-kept pre");
      if (kept) { const range = document.createRange(); range.selectNodeContents(kept); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); }
    };
    if (!navigator.clipboard?.writeText) { selectText(); return; }
    void navigator.clipboard.writeText(text).then(() => setCopied(true), selectText);
  };
  const discardDraft = () => {
    overLimitDrafts.delete(theater.id);
    clearTimer();
    dirtyRef.current = false;
    draftRef.current = storedRef.current ?? { mode: "on", body: "" };
    setDraft(draftRef.current);
    close();
  };
  const trapTab = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href]') ?? []);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  if (mobile) {
    const modes = Object.keys(modeNames) as ClaudeCodeSystemPromptMode[];
    const over = draft.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS;
    mobileViewRef.current = {
      title: t("sidebar.theater.prompt.title"),
      close,
      body: <>
        <p className="settings-mobile-lead"><strong>{theater.label}</strong> · {t("sidebar.theater.prompt.scope")}</p>
        {forgotten ? <>
          <p className="settings-mobile-note is-error" role="alert"><strong>{t("sidebar.theater.prompt.forgottenTitle")}</strong> {unsaved ? t(draft.body ? "sidebar.theater.prompt.forgottenUnsavedCopy" : "sidebar.theater.prompt.forgottenUnsaved") : null}</p>
          {unsaved && draft.body ? <>
            <textarea ref={forgottenTextRef} className="mobile-field" readOnly value={draft.body} rows={5} aria-label={t("sidebar.theater.prompt.bodyLabel")} />
            <div className="settings-mobile-actions">
              <button type="button" className="mobile-pill-secondary" onClick={copyDraft}>{t("sidebar.theater.prompt.copy")}</button>
              {copied ? <span className="settings-mobile-note" role="status">{t("sidebar.theater.prompt.copied")}</span> : null}
            </div>
          </> : null}
          <p className="settings-mobile-note">{t(unsaved ? "sidebar.theater.prompt.forgottenRestoreUnsaved" : "sidebar.theater.prompt.forgottenRestore")}</p>
        </> : loading ? <p className="settings-mobile-note" role="status">{t("sidebar.theater.prompt.loading")}</p>
          : loadFailed ? <p className="settings-mobile-note is-error" role="alert">{t("sidebar.theater.prompt.loadFailed")}</p> : <>
            <div className="mobile-group settings-mobile-card" role="radiogroup" aria-label={t("sidebar.theater.prompt.modeLabel")}>
              {modes.map((mode) => <MobileRadioRow key={mode} checked={draft.mode === mode} label={modeNames[mode]} onSelect={() => changeMode(mode)} />)}
            </div>
            {draft.mode === "on" && draft.body ? <p className="settings-mobile-kept">{t("sidebar.theater.prompt.kept", { count: draft.body.length })} · {t(over ? "sidebar.theater.prompt.draftNotApplied" : "sidebar.theater.prompt.keptHelp")}</p> : null}
            {draft.mode !== "on" ? <label className="settings-mobile-body">
              <MobileGroupLabel>{t("sidebar.theater.prompt.bodyLabel")}</MobileGroupLabel>
              <SyncedTextarea ref={draftTextRef} className="mobile-field" value={draft.body} onChange={(event) => changeBody(event.target.value)} onBlur={flush} rows={5} aria-invalid={over} />
              <small className={`settings-mobile-count${over ? " is-over" : ""}`}>{draft.body.length.toLocaleString()} / 16,000</small>
            </label> : null}
            {/* The default needs no explanation; the other modes change what reaches the model, so they say so. */}
            {draft.mode !== "on" ? <p className={`settings-mobile-note${draft.mode === "off" ? " is-warning" : ""}`}>{caption}</p> : null}
            {stored || undo ? <p className="settings-mobile-note">
              {stored ? <>{t("sidebar.theater.prompt.own")} · <button type="button" className="settings-mobile-textlink" onClick={reset}>{t("sidebar.theater.prompt.reset")}</button></> : null}
              {undo ? <><span role="status">{t("sidebar.theater.prompt.resetDone")}</span> <button ref={undoRef} type="button" className="settings-mobile-textlink" onClick={restore}>{t("sidebar.theater.prompt.undo")}</button></> : null}
            </p> : null}
            {status !== "untouched" ? <p className={`settings-mobile-note${status === "error" || status === "over" ? " is-error" : ""}`} role={status === "over" ? "alert" : "status"} aria-live="polite">{t(`sidebar.theater.prompt.save.${status}`)}</p> : null}
            {over ? <>
              <p className="settings-mobile-note">{t("sidebar.theater.prompt.draftHelp")}</p>
              <div className="settings-mobile-actions">
                <button type="button" className="mobile-pill-secondary" onClick={copyDraft}>{t("sidebar.theater.prompt.copy")}</button>
                <button type="button" className="mobile-pill-secondary" onClick={discardDraft}>{t("sidebar.theater.prompt.discardDraft")}</button>
                {copied ? <span className="settings-mobile-note" role="status">{t("sidebar.theater.prompt.copied")}</span> : null}
              </div>
            </> : null}
          </>}
        {forgotten ? null : <TheaterSubagentsSection key={theater.id} theaterId={theater.id} mobile />}
      </>,
    };
    return null;
  }
  return createPortal(<>
    <div className="theater-prompt-backdrop" onPointerDown={close} aria-hidden="true" />
    <section ref={dialogRef} className="theater-prompt-sheet" style={position} role="dialog" aria-modal="true" aria-label={t("sidebar.theater.prompt.dialogAria", { theater: theater.label })} onKeyDown={trapTab}>
      <header className="theater-prompt-header">
        <span className="theater-prompt-mark" aria-hidden="true"><TheaterMonogram>{theaterInitials(theater.label)}</TheaterMonogram></span>
        <span className="theater-prompt-heading"><strong>{theater.label}</strong><small>{t("sidebar.theater.prompt.title")}</small></span>
        <button ref={closeRef} type="button" className="theater-prompt-close" onClick={close} aria-label={t("sidebar.theater.prompt.close")}>×</button>
      </header>
      <p className="theater-prompt-scope">{t("sidebar.theater.prompt.scope")}
        <span className="theater-prompt-tip-wrap"><button ref={tipRef} type="button" className="theater-prompt-tip" aria-label={t("sidebar.theater.prompt.tipAria")} aria-describedby="theater-prompt-tip-description" onMouseEnter={() => setTipVisible(true)} onMouseLeave={() => setTipVisible(false)} onFocus={() => setTipVisible(true)} onBlur={() => setTipVisible(false)}>?</button></span>
      </p>
      {forgotten ? <div className="theater-prompt-forgotten" role="alert">
        <p><strong>{t("sidebar.theater.prompt.forgottenTitle")}</strong> {unsaved ? t(draft.body ? "sidebar.theater.prompt.forgottenUnsavedCopy" : "sidebar.theater.prompt.forgottenUnsaved") : null}</p>
        {unsaved && draft.body ? <>
          <textarea ref={forgottenTextRef} readOnly value={draft.body} rows={5} aria-label={t("sidebar.theater.prompt.bodyLabel")} />
          <div className="theater-prompt-forgotten-actions">
            <button ref={copyRef} type="button" onClick={copyDraft}>{t("sidebar.theater.prompt.copy")}</button>
            {copied ? <span role="status">{t("sidebar.theater.prompt.copied")}</span> : null}
          </div>
        </> : null}
        <small>{t(unsaved ? "sidebar.theater.prompt.forgottenRestoreUnsaved" : "sidebar.theater.prompt.forgottenRestore")}</small>
      </div> : null}
      {forgotten ? null : !loading && !loadFailed ? <div className="theater-prompt-state"><span><i className={stored ? "is-own" : ""} />{stored ? t("sidebar.theater.prompt.own") : t("sidebar.theater.prompt.unset")}</span><small>{stored ? t("sidebar.theater.prompt.ownDetail") : t("sidebar.theater.prompt.unsetDetail")}</small>
        {stored ? <button type="button" onClick={reset}>{t("sidebar.theater.prompt.reset")}</button> : null}
        {undo ? <p role="status">{t("sidebar.theater.prompt.resetDone")} <button ref={undoRef} type="button" onClick={restore}>{t("sidebar.theater.prompt.undo")}</button></p> : null}
      </div> : null}
      {forgotten ? null : loading ? <p role="status">{t("sidebar.theater.prompt.loading")}</p> : loadFailed ? <p className="theater-prompt-save is-error" role="alert">{t("sidebar.theater.prompt.loadFailed")}</p> : <>
        <div className="theater-prompt-field" ref={selectRef}><span id="theater-prompt-mode-label">{t("sidebar.theater.prompt.modeLabel")}</span>
          <Select className="theater-prompt-select" aria-labelledby="theater-prompt-mode-label" value={draft.mode} options={(Object.keys(modeNames) as ClaudeCodeSystemPromptMode[]).map((mode) => ({ value: mode, label: modeNames[mode] }))} onChange={(mode) => changeMode(mode as ClaudeCodeSystemPromptMode)} />
        </div>
        {draft.mode === "on" && draft.body ? <div className="theater-prompt-kept"><details><summary>{t("sidebar.theater.prompt.kept", { count: draft.body.length })}</summary><pre>{draft.body}</pre></details><p>{t(draft.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS ? "sidebar.theater.prompt.draftNotApplied" : "sidebar.theater.prompt.keptHelp")}</p></div> : null}
        {draft.mode !== "on" ? <label className="theater-prompt-field">{t("sidebar.theater.prompt.bodyLabel")}
          <SyncedTextarea ref={draftTextRef} value={draft.body} onChange={(event) => changeBody(event.target.value)} onBlur={flush} rows={5} aria-invalid={draft.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS} aria-describedby={draft.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS ? "theater-prompt-length-error" : undefined} />
          <small className={draft.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS ? "is-over" : ""}>{draft.body.length.toLocaleString()} / 16,000</small>
        </label> : null}
        <p className={draft.mode === "off" ? "theater-prompt-warning" : "theater-prompt-caption"}>{caption}</p>
        {status !== "untouched" ? <p id={status === "over" ? "theater-prompt-length-error" : undefined} className={`theater-prompt-save is-${status}`} role={status === "over" ? "alert" : "status"} aria-live="polite"><i />{t(`sidebar.theater.prompt.save.${status}`)}</p> : null}
      </>}
      {!forgotten && !loading && !loadFailed && draft.body.length > CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_MAX_CHARS ? <div className="theater-prompt-draft">
        <p>{t("sidebar.theater.prompt.draftHelp")}</p>
        <div className="theater-prompt-forgotten-actions">
          <button ref={copyRef} type="button" onClick={copyDraft}>{t("sidebar.theater.prompt.copy")}</button>
          <button type="button" onClick={discardDraft}>{t("sidebar.theater.prompt.discardDraft")}</button>
          {copied ? <span role="status">{t("sidebar.theater.prompt.copied")}</span> : null}
        </div>
      </div> : null}
      {forgotten ? null : <TheaterSubagentsSection key={theater.id} theaterId={theater.id} />}
    </section>
    <span ref={tooltipRef} id="theater-prompt-tip-description" role="tooltip" className="theater-prompt-tooltip" hidden={!tipVisible} style={tipPosition}>{t("sidebar.theater.prompt.tip")}</span>
  </>, document.body);
}

/**
 * Theater의 서브에이전트 — 켜져 있으면(기본) 서브에이전트 호출 자리에 Objectives 구성원이 선다. 프롬프트와 달리
 * Console이 호출마다 읽으므로 실행 중인 세션도 다음 호출부터 따른다. 저장은 누르는 즉시이며, 실패하면 되돌린다.
 */
function TheaterSubagentsSection({ theaterId, mobile = false }: { readonly theaterId: string; readonly mobile?: boolean }) {
  const t = useT();
  const [replaced, setReplaced] = useState<boolean | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "loadFailed" | "saveFailed">("loading");
  const revisionRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetchTheaterSubagents(theaterId, controller.signal).then((result) => {
      setReplaced(!result.subagentsKept);
      setState("ready");
    }, () => { if (!controller.signal.aborted) setState("loadFailed"); });
    return () => controller.abort();
  }, [theaterId]);

  const change = (next: boolean) => {
    const previous = replaced;
    const revision = ++revisionRef.current;
    setReplaced(next);
    setState("saving");
    void saveTheaterSubagents(theaterId, !next).then((result) => {
      if (revision !== revisionRef.current) return;
      setReplaced(!result.subagentsKept);
      setState("ready");
    }, () => {
      if (revision !== revisionRef.current) return;
      setReplaced(previous);
      setState("saveFailed");
    });
  };

  if (mobile) {
    return state === "loading" ? <p className="settings-mobile-note" role="status">{t("sidebar.theater.prompt.loading")}</p>
      : state === "loadFailed" ? <p className="settings-mobile-note is-error" role="alert">{t("sidebar.theater.subagents.loadFailed")}</p>
        : <>
          <SettingsCard>
            <SettingsRow label={t("sidebar.theater.subagents.toggle")} hint={t(replaced ? "sidebar.theater.subagents.on" : "sidebar.theater.subagents.off")}>
              <SettingsToggle checked={replaced === true} busy={state === "saving"} ariaLabel={t("sidebar.theater.subagents.toggle")} onChange={change} />
            </SettingsRow>
          </SettingsCard>
          {state === "saveFailed" ? <p className="settings-mobile-note is-error" role="alert">{t("sidebar.theater.subagents.saveFailed")}</p> : null}
        </>;
  }
  return (
    <div className="theater-subagents" role="group" aria-labelledby="theater-subagents-title">
      <strong id="theater-subagents-title">{t("sidebar.theater.subagents.title")}</strong>
      {state === "loading" ? <p role="status">{t("sidebar.theater.prompt.loading")}</p>
        : state === "loadFailed" ? <p className="theater-prompt-save is-error" role="alert">{t("sidebar.theater.subagents.loadFailed")}</p>
          : <>
            <SettingsToggle checked={replaced === true} busy={state === "saving"} label={t("sidebar.theater.subagents.toggle")} onChange={change} />
            <p className="theater-prompt-caption">{t(replaced ? "sidebar.theater.subagents.on" : "sidebar.theater.subagents.off")}</p>
            {state === "saveFailed" ? <p className="theater-prompt-save is-error" role="alert">{t("sidebar.theater.subagents.saveFailed")}</p> : null}
          </>}
    </div>
  );
}
