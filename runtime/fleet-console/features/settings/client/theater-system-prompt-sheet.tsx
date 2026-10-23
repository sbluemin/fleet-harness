import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useT } from "../../../core/client/src/i18n/index.js";
import { getViewModeSnapshot, useViewMode } from "../../../core/client/src/integration/view-mode-store.js";
import type { ClaudeCodeSystemPromptMode } from "./execution-settings.js";
import "./theater-system-prompt-sheet.css";
import { MobileGroupLabel, MobileRadioRow } from "./settings-mobile.js";
import { MobileSheet } from "../../../core/client/src/chrome/mobile/mobile-sheet.js";
import { getMobileSheetStack, popMobileSheet, pushMobileSheet, type MobileSheetKind } from "../../../core/client/src/chrome/mobile/mobile-store.js";
import { SyncedTextarea } from "../../execution/client/composer-primitives/input.js";
import {
  isNearPromptLimit,
  isOverPromptLimit,
  openTheaterSystemPrompt,
  subscribeTheaterSystemPromptOpen,
  TheaterSubagentsSection,
  useFocusAfterReset,
  useTheaterPromptController,
  useTheaterPromptEmptyNotice,
  useTheaterPromptModeDescriptions,
  useTheaterPromptModeNames,
  type TheaterPromptOpenRequest,
} from "./theater-prompt-editor.js";

// 사이드바와 폰 Theater 시트가 여기서 가져가는 입구 — 구현은 프롬프트 controller 모듈 하나에 있다.
export { openTheaterSystemPrompt, subscribeTheaterSystemPromptChange, subscribeTheaterSystemPromptForgotten } from "./theater-prompt-editor.js";

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

/**
 * 폰의 Theater 시스템 프롬프트 시트. 데스크톱은 같은 입구가 Theater Inbox 의 「Theater 설정」을 연다 — 이 시트는 폰 배치에서만
 * 입구를 받고, 데스크톱으로 바뀌면 같은 Theater 를 Theater Inbox 로 넘긴다.
 */
export function TheaterSystemPromptSheet() {
  const t = useT(true);
  const mobile = useViewMode().effective === "mobile";
  const [request, setRequest] = useState<TheaterPromptOpenRequest | null>(null);
  const [openKey, setOpenKey] = useState(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  const forgottenTextRef = useRef<HTMLTextAreaElement>(null);
  const draftTextRef = useRef<HTMLTextAreaElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const mobileViewRef = useRef<MobilePromptView | null>(null);
  mobileViewRef.current = null;
  useLayoutEffect(() => { publishMobilePromptView(mobileViewRef.current); });

  const close = useCallback(() => {
    const opener = requestRef.current?.returnFocus;
    setRequest(null);
    if (opener?.isConnected) window.requestAnimationFrame(() => opener.focus());
  }, []);
  const controller = useTheaterPromptController(request?.theater ?? null, openKey, {
    onMissing: () => {
      const opener = requestRef.current?.returnFocus;
      setRequest(null);
      if (opener?.isConnected) opener.focus();
    },
    onDiscarded: close,
  });

  useEffect(() => subscribeTheaterSystemPromptOpen((next) => {
    // 데스크톱의 입구는 Theater Inbox 가 받는다.
    if (getViewModeSnapshot().effective !== "mobile") return;
    setRequest(next);
    setOpenKey((value) => value + 1);
  }), []);

  // 폰 시트를 연 채 데스크톱으로 바뀌면 — 닫으며 입력을 확정하고 같은 Theater 를 Theater Inbox 로 넘긴다.
  useEffect(() => {
    if (mobile || !request) return;
    const theater = request.theater;
    setRequest(null);
    openTheaterSystemPrompt(theater, null);
  }, [mobile, request]);

  const mobileSheetOpen = mobile && request !== null;
  useEffect(() => {
    if (!mobileSheetOpen) return;
    const sheet: MobileSheetKind = { kind: "custom", render: (dismiss) => <MobilePromptSheetView sheet={sheet} onDismiss={dismiss} /> };
    pushMobileSheet(sheet);
    return () => { if (getMobileSheetStack().at(-1) === sheet) popMobileSheet(); };
  }, [mobileSheetOpen]);

  useFocusAfterReset(controller, { undo: () => undoRef.current, select: () => null });
  const modeNames = useTheaterPromptModeNames(true);
  const modeDescriptions = useTheaterPromptModeDescriptions(true);
  const emptyNotice = useTheaterPromptEmptyNotice(controller.draft);

  if (!request || !mobile) return null;
  const theater = request.theater;
  const { draft, stored, undo, status, loading, loadFailed, forgotten, unsaved, copied } = controller;
  const modes = Object.keys(modeNames) as ClaudeCodeSystemPromptMode[];
  const over = isOverPromptLimit(draft);
  const near = isNearPromptLimit(draft);
  const copyDraft = () => controller.copyDraft(() => {
    const field = forgottenTextRef.current ?? draftTextRef.current;
    if (field) { field.focus(); field.select(); }
  });
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
          <div className="mobile-group settings-mobile-card settings-mobile-prompt-modes" role="radiogroup" aria-label={t("sidebar.theater.prompt.modeLabel")}>
            {/* 데스크톱 칸과 같은 안 B — 줄마다 그 모드의 결과 문장을 달아 고르기 전에 읽히게 한다. */}
            {modes.map((mode) => <MobileRadioRow key={mode} checked={draft.mode === mode} label={modeNames[mode]} sub={modeDescriptions[mode]} onSelect={() => controller.changeMode(mode)} />)}
          </div>
          {draft.mode === "on" && draft.body ? <p className="settings-mobile-kept">{t("sidebar.theater.prompt.kept", { count: draft.body.length })} · {t(over ? "sidebar.theater.prompt.draftNotApplied" : "sidebar.theater.prompt.keptHelp")}</p> : null}
          {draft.mode !== "on" ? <label className="settings-mobile-body">
            <MobileGroupLabel>{t("sidebar.theater.prompt.bodyLabel")}</MobileGroupLabel>
            <SyncedTextarea ref={draftTextRef} className="mobile-field" value={draft.body} onChange={(event) => controller.changeBody(event.target.value)} onBlur={controller.flush} rows={5} aria-invalid={over} />
            <small className={`settings-mobile-count${over ? " is-over" : near ? " is-near" : ""}`}>{draft.body.length.toLocaleString()} / 16,000</small>
          </label> : null}
          {/* 결과 문장은 모드 줄이 이미 말한다. 지침이 비었을 때만 그 결과를 따로 세우고, 「내 지침만」이면 경고다. */}
          {emptyNotice ? <p className={`settings-mobile-note${draft.mode === "off" ? " is-warning" : ""}`}>{emptyNotice}</p> : null}
          {stored || undo ? <p className="settings-mobile-note">
            {stored ? <>{t("sidebar.theater.prompt.own")} · <button type="button" className="settings-mobile-textlink" onClick={controller.reset}>{t("sidebar.theater.prompt.reset")}</button></> : null}
            {undo ? <><span role="status">{t("sidebar.theater.prompt.resetDone")}</span> <button ref={undoRef} type="button" className="settings-mobile-textlink" onClick={controller.restore}>{t("sidebar.theater.prompt.undo")}</button></> : null}
          </p> : null}
          {status !== "untouched" ? <p className={`settings-mobile-note${status === "error" || status === "over" ? " is-error" : ""}`} role={status === "over" ? "alert" : "status"} aria-live="polite">{t(`sidebar.theater.prompt.save.${status}`)}</p> : null}
          {over ? <>
            <p className="settings-mobile-note">{t("sidebar.theater.prompt.draftHelp")}</p>
            <div className="settings-mobile-actions">
              <button type="button" className="mobile-pill-secondary" onClick={copyDraft}>{t("sidebar.theater.prompt.copy")}</button>
              <button type="button" className="mobile-pill-secondary" onClick={controller.discardDraft}>{t("sidebar.theater.prompt.discardDraft")}</button>
              {copied ? <span className="settings-mobile-note" role="status">{t("sidebar.theater.prompt.copied")}</span> : null}
            </div>
          </> : null}
        </>}
      {forgotten ? null : <TheaterSubagentsSection key={theater.id} theaterId={theater.id} mobile />}
    </>,
  };
  return null;
}
