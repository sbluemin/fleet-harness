import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Select } from "@fleet-console/sdk/react/browser";
import { SyncedTextarea } from "@fleet-console/sdk/composer";
import type { TheaterInboxBodyContext, TheaterInboxSectionDescriptor, TheaterInboxSectionState } from "@fleet-console/sdk/theater-inbox";

import { getT, useT } from "../../../core/client/src/i18n/index.js";
import { theaterInitials } from "../../workspace/client/sidebar/theater-initials.js";
import { TheaterMonogram } from "../../workspace/client/sidebar/theater-monogram.js";
import type { ClaudeCodeSystemPromptMode } from "./execution-settings.js";
import {
  isOverPromptLimit,
  TheaterSubagentsSection,
  useFocusAfterReset,
  useTheaterPromptCaption,
  useTheaterPromptController,
  useTheaterPromptModeNames,
} from "./theater-prompt-editor.js";
import "./theater-system-prompt-sheet.css";

/** 호스트 정준 id 는 `console:settings` 다 — 코어 어댑터가 이 id 앞에 `console:` 을 붙인다. */
export const THEATER_SETTINGS_SECTION_ID = "settings";
export const THEATER_SYSTEM_PROMPT_PAGE_ID = "system-prompt";
export const THEATER_SUBAGENTS_PAGE_ID = "subagents";

const sectionStates = new Map<string, TheaterInboxSectionState>();

/**
 * Theater Inbox 의 「Theater 설정」 — 이 Theater 에서 여는 Claude Code 세션의 시스템 프롬프트와 서브에이전트.
 * 플러그인이 아니라 호스트의 기본 섹션이라, 사령관(실험 기능)이 꺼져 있거나 플러그인이 빠져도 남는다.
 */
export function createTheaterSettingsInboxSection(): TheaterInboxSectionDescriptor {
  return {
    id: THEATER_SETTINGS_SECTION_ID,
    title: (language) => getT(language)("theaterInbox.settings.title"),
    icon: ({ theater }) => <TheaterMonogram compact>{theaterInitials(theater.label)}</TheaterMonogram>,
    pages: [
      { id: THEATER_SYSTEM_PROMPT_PAGE_ID, title: (language) => getT(language)("sidebar.theater.prompt.title"), applies: (language) => getT(language)("theaterInbox.applies.prompt") },
      { id: THEATER_SUBAGENTS_PAGE_ID, title: (language) => getT(language)("sidebar.theater.subagents.title"), applies: (language) => getT(language)("theaterInbox.applies.subagents") },
    ],
    read: (_theater, language) => {
      const cached = sectionStates.get(language);
      if (cached) return cached;
      const state: TheaterInboxSectionState = { availability: "available", scope: getT(language)("theaterInbox.settings.scope") };
      sectionStates.set(language, state);
      return state;
    },
    subscribe: () => () => undefined,
    render: (context) => <TheaterSettingsInboxBody context={context} />,
  };
}

/**
 * 섹션 본문은 시트가 열려 있는 동안 마운트된 채로 있다 — 다른 섹션을 보는 동안에도 프롬프트 controller 가 살아 있어
 * 쓰던 글과 대기 저장을 잃지 않는다. 시트를 닫으면 언마운트되며 그때 대기 저장을 확정한다.
 */
function TheaterSettingsInboxBody({ context }: { readonly context: TheaterInboxBodyContext }) {
  const { theater, pageId, visible, focusRequest, links, navigation } = context;
  const controller = useTheaterPromptController(theater, 0, {
    onMissing: () => navigation.close(),
    onDiscarded: () => navigation.close(),
  });
  const promptVisible = visible && pageId === THEATER_SYSTEM_PROMPT_PAGE_ID;
  return (
    <>
      <div className="theater-prompt-page" hidden={!promptVisible}>
        <TheaterPromptPage context={context} controller={controller} visible={promptVisible} focusRequest={focusRequest} operatorDirective={links.operatorDirective} />
      </div>
      <div className="theater-prompt-page" hidden={!(visible && pageId === THEATER_SUBAGENTS_PAGE_ID)}>
        {controller.forgotten ? null : <TheaterSubagentsSection key={theater.id} theaterId={theater.id} titled={false} />}
      </div>
    </>
  );
}

function TheaterPromptPage({ context, controller, visible, focusRequest, operatorDirective }: {
  readonly context: TheaterInboxBodyContext;
  readonly controller: ReturnType<typeof useTheaterPromptController>;
  readonly visible: boolean;
  readonly focusRequest: TheaterInboxBodyContext["focusRequest"];
  readonly operatorDirective: TheaterInboxBodyContext["links"]["operatorDirective"];
}) {
  const t = useT();
  const { draft, stored, undo, status, loading, loadFailed, forgotten, unsaved, copied } = controller;
  const [tipVisible, setTipVisible] = useState(false);
  const [tipPosition, setTipPosition] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const forgottenTextRef = useRef<HTMLTextAreaElement>(null);
  const draftTextRef = useRef<HTMLTextAreaElement>(null);
  const handledFocus = useRef(0);
  const modeNames = useTheaterPromptModeNames();
  const caption = useTheaterPromptCaption(draft);
  const over = isOverPromptLimit(draft);
  const combobox = () => selectRef.current?.querySelector<HTMLButtonElement>('button[role="combobox"]') ?? null;

  useFocusAfterReset(controller, { undo: () => undoRef.current, select: combobox });

  // 입구가 맡긴 포커스 — 불러온 뒤에 한 번. 「입력 끝」은 본문이 있는 모드에서만 입력란 끝이고, 기본 모드는 모드 선택기다
  // (링크가 실행 정책인 모드를 바꾸지 않는다).
  useEffect(() => {
    if (!visible || !focusRequest || handledFocus.current === focusRequest.nonce || loading || loadFailed || forgotten) return;
    handledFocus.current = focusRequest.nonce;
    const field = draftTextRef.current;
    if (focusRequest.kind === "editor-end" && field) {
      field.focus();
      const end = field.value.length;
      field.setSelectionRange(end, end);
      field.scrollTop = field.scrollHeight;
      return;
    }
    combobox()?.focus();
  }, [visible, focusRequest, loading, loadFailed, forgotten]);

  // 편집 칸이 사라지면서 포커스가 문서로 떨어지지 않게, 남은 글을 복사하는 버튼으로 옮긴다.
  useLayoutEffect(() => {
    if (!forgotten) return;
    setTipVisible(false);
    if (rootRef.current?.contains(document.activeElement) || document.activeElement === document.body) copyRef.current?.focus();
  }, [forgotten]);

  useEffect(() => { if (!visible) setTipVisible(false); }, [visible]);

  useLayoutEffect(() => {
    if (!tipVisible) return;
    const place = () => {
      const box = tipRef.current?.getBoundingClientRect();
      if (!box) return;
      setTipPosition({ top: Math.max(8, Math.min(window.innerHeight - (tooltipRef.current?.offsetHeight ?? 90) - 8, box.bottom + 6)), left: Math.max(8, Math.min(window.innerWidth - 298, box.right - 290)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [tipVisible]);

  const copyDraft = () => controller.copyDraft(() => {
    const field = forgottenTextRef.current ?? draftTextRef.current;
    if (field) { field.focus(); field.select(); return; }
    const kept = rootRef.current?.querySelector(".theater-prompt-kept pre");
    if (kept) { const range = document.createRange(); range.selectNodeContents(kept); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); }
  });
  // 도움말이 떠 있으면 Esc 는 도움말만 닫는다 — 시트는 이미 처리된 Esc 를 받지 않는다.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && tipVisible) { event.preventDefault(); setTipVisible(false); }
  };
  const openDirective = () => {
    if (!operatorDirective) return;
    context.navigation.open({ ...operatorDirective, theaterId: context.theater.id, focus: "editor-end" });
  };

  return (
    <div ref={rootRef} className="theater-prompt-body" onKeyDown={onKeyDown}>
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
        {stored ? <button type="button" onClick={controller.reset}>{t("sidebar.theater.prompt.reset")}</button> : null}
        {undo ? <p role="status">{t("sidebar.theater.prompt.resetDone")} <button ref={undoRef} type="button" onClick={controller.restore}>{t("sidebar.theater.prompt.undo")}</button></p> : null}
      </div> : null}
      {forgotten ? null : loading ? <p role="status">{t("sidebar.theater.prompt.loading")}</p> : loadFailed ? <p className="theater-prompt-save is-error" role="alert">{t("sidebar.theater.prompt.loadFailed")}</p> : <>
        <div className="theater-prompt-field" ref={selectRef}><span id="theater-prompt-mode-label">{t("sidebar.theater.prompt.modeLabel")}</span>
          <Select className="theater-prompt-select" aria-labelledby="theater-prompt-mode-label" value={draft.mode} options={(Object.keys(modeNames) as ClaudeCodeSystemPromptMode[]).map((mode) => ({ value: mode, label: modeNames[mode] }))} onChange={(mode) => controller.changeMode(mode as ClaudeCodeSystemPromptMode)} />
        </div>
        {draft.mode === "on" && draft.body ? <div className="theater-prompt-kept"><details><summary>{t("sidebar.theater.prompt.kept", { count: draft.body.length })}</summary><pre>{draft.body}</pre></details><p>{t(over ? "sidebar.theater.prompt.draftNotApplied" : "sidebar.theater.prompt.keptHelp")}</p></div> : null}
        {draft.mode !== "on" ? <label className="theater-prompt-field">{t("sidebar.theater.prompt.bodyLabel")}
          <SyncedTextarea ref={draftTextRef} value={draft.body} onChange={(event) => controller.changeBody(event.target.value)} onBlur={controller.flush} rows={7} aria-invalid={over} aria-describedby={over ? "theater-prompt-length-error" : undefined} />
          <small className={over ? "is-over" : ""}>{draft.body.length.toLocaleString()} / 16,000</small>
        </label> : null}
        <p className={draft.mode === "off" ? "theater-prompt-warning" : "theater-prompt-caption"}>{caption}</p>
        {status !== "untouched" ? <p id={status === "over" ? "theater-prompt-length-error" : undefined} className={`theater-prompt-save is-${status}`} role={status === "over" ? "alert" : "status"} aria-live="polite"><i />{t(`sidebar.theater.prompt.save.${status}`)}</p> : null}
      </>}
      {!forgotten && !loading && !loadFailed && over ? <div className="theater-prompt-draft">
        <p>{t("sidebar.theater.prompt.draftHelp")}</p>
        <div className="theater-prompt-forgotten-actions">
          <button ref={copyRef} type="button" onClick={copyDraft}>{t("sidebar.theater.prompt.copy")}</button>
          <button type="button" onClick={controller.discardDraft}>{t("sidebar.theater.prompt.discardDraft")}</button>
          {copied ? <span role="status">{t("sidebar.theater.prompt.copied")}</span> : null}
        </div>
      </div> : null}
      {operatorDirective && !forgotten ? <p className="theater-prompt-crosslink">{t("theaterInbox.settings.directiveNote")} <button type="button" onClick={openDirective}>{t("theaterInbox.settings.directiveLink")}</button></p> : null}
      {visible ? createPortal(<span ref={tooltipRef} id="theater-prompt-tip-description" role="tooltip" className="theater-prompt-tooltip" hidden={!tipVisible} style={tipPosition}>{t("sidebar.theater.prompt.tip")}</span>, document.body) : null}
    </div>
  );
}
