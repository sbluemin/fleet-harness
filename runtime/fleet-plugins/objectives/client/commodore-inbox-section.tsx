import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { CaptionTipHost } from "@fleet-console/sdk/components/caption-actions";
import {
  AttachImageIcon,
  ComposerAttachmentTray,
  ComposerMenu,
  ComposerMenuItem,
  ComposerNotice,
  ComposerPlusButton,
  ComposerSendButton,
  composerAttachmentNoticeText,
  composerT,
  createComposerAttachments,
  isComposerAttachmentCandidate,
  useComposerAttachmentSnapshot,
} from "@fleet-console/sdk/composer";
import { referencePlainText } from "@fleet-console/sdk/conversation";
import type { Translate } from "@fleet-console/sdk/i18n";
import { SettingsRow, SettingsToggle } from "@fleet-console/sdk/settings/browser";
import type { TheaterInboxBodyContext, TheaterInboxSectionDescriptor, TheaterInboxSectionState } from "@fleet-console/sdk/theater-inbox";

import type { CommodoreLiveEvent, CommodorePatrolMinutes, CommodoreRunStatus, CommodoreTranscriptEntry } from "../server/commodore/types.js";
import { commodoreLogBlocks, commodoreTurnCovering, errorWord, formatContextTokens, type CommodoreLogTurn } from "./commodore-chat.js";
import { commanderCoordinates, commanderValue, CommodoreCoordinateField, commodoreCoordinates, commodoreValue, DEFAULT_PATROL, PATROL_STEPS, patrolWord } from "./commodore-controls.js";
import { CommodoreAskCards, ENDED_ASK_CODES } from "./commodore-ask.js";
import { CommodoreMentionGlyph } from "./commodore-mention-glyph.js";
import { CommodoreReferenceInput, useCommodoreReferenceHost, type CommodoreReference, type CommodoreReferenceInputHandle } from "./commodore-reference-input.js";
import { CommodoreTrail } from "./commodore-trail.js";
import { clampTrailWidth, CommodoreTrailSeam, readTrailWidth, TRAIL_WIDTH_DEFAULT, writeTrailWidth } from "./commodore-trail-seam.js";
import { clockTime } from "./commodore-header.js";
import { openCommodoreConversation } from "./commodore-conversation.js";
import { DatePicker, localDateTime } from "./date-picker.js";
import {
  addCommodoreIntel,
  clearCommodore,
  commodoreLanguage,
  COMMODORE_INBOX_SECTION_ID,
  OBJECTIVES_ENTRY_ID,
  commodoreTranscriptRenderer,
  loadCommodore,
  loadTranscript,
  messageCommodore,
  uploadCommodoreAttachment,
  discardCommodoreAttachment,
  noteCommodoreLanguage,
  openCommodoreMobile,
  readCommodore,
  readCommodoreExperiment,
  removeCommodoreIntel,
  INTEL_EDIT_ATTRIBUTE,
  useCommodoreIntelEdits,
  retryCommodore,
  saveCommodoreDirective,
  setCommodoreAutonomy,
  setCommodoreCommander,
  setCommodoreCoordinates,
  setCommodorePatrol,
  setCommodoreStopAt,
  subscribeCommodore,
  useCommodore,
  type CommodoreTab,
} from "./commodore-state.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { DEFAULT_LAUNCH } from "./launch-control.js";

type T = Translate<ObjectiveMessageKey>;

const PATROL_MENU_WIDTH = 248;
const PATROL_MENU_MARGIN = 12;
/** 본문이 이보다 좁으면 기록 곁 칸(목표)을 기록 아래로 내린다 — 옛 시트의 좁은 모양과 같은 자리. */
const COMPACT_BODY_WIDTH = 500;
const COMMODORE_PAGES: readonly CommodoreTab[] = ["log", "directive", "intel", "settings"];

/* ── Theater Inbox 섹션 ──────────────────────────────────────────────── */

const sectionStates = new Map<string, TheaterInboxSectionState>();
function cachedSectionState(state: TheaterInboxSectionState): TheaterInboxSectionState {
  const key = `${state.availability}|${state.scope}|${state.disabledNote ?? ""}`;
  const cached = sectionStates.get(key);
  if (cached) return cached;
  sectionStates.set(key, state);
  return state;
}

/** 사령관의 지금 한 줄 — 옛 「사령관 기록」 시트 왼쪽 머리에 있던 그 말(자율 운영 · 다음 순찰 …). */
function commodoreStatusLine(t: T, theaterId: string, language: "en" | "ko"): string {
  const view = readCommodore(theaterId).view;
  if (!view) return t("objectives.commodore.inbox.scope");
  const on = view.state.autonomy === true;
  const run = view.run;
  return [
    on ? t("objectives.commodore.meta.autonomous") : t("objectives.commodore.meta.manual"),
    on && view.state.stopAt ? t("objectives.commodore.stop.at", { time: stopTime(view.state.stopAt, language) }) : null,
    on && run.phase === "idle" && run.nextWakeAt ? t("objectives.commodore.drawer.nextPatrol", { time: clockTime(run.nextWakeAt) }) : null,
    on && run.phase === "turn" ? t("objectives.commodore.meta.turn") : null,
    on && run.phase === "retrying" && run.nextWakeAt ? t("objectives.commodore.drawer.retryAt", { time: clockTime(run.nextWakeAt) }) : null,
    on && run.phase === "error" ? `${t("objectives.commodore.meta.error")}${run.reason ? ` · ${errorWord(t, run.reason)}` : ""}` : null,
  ].filter(Boolean).join(" · ");
}

/**
 * Theater Inbox 의 「사령관」 섹션 — 기록·지시·정보·설정. 시트 틀과 칸 목록은 호스트가, 본문은 여기가 그린다.
 * 실험 기능 「자율 운영」이 꺼져 있으면 섹션은 제목과 안내 한 줄만 남고 본문을 마운트하지 않는다(읽기·쓰기 없음).
 */
export const commodoreInboxSection: TheaterInboxSectionDescriptor = {
  id: COMMODORE_INBOX_SECTION_ID,
  title: (language) => getT(language)("objectives.commodore.name"),
  icon: () => <CommodoreMentionGlyph className="objectives-commodore-inbox-glyph" />,
  pages: [
    // 기록은 툴바·질문을 고정하고 기록 칸이 스스로 스크롤한다(바닥 붙기) — 칸 전체를 받는다. 나머지 칸은 호스트 읽기 열에 선다.
    { id: "log", title: (language) => getT(language)("objectives.commodore.tabs.log"), layout: "fill" },
    { id: "directive", title: (language) => getT(language)("objectives.commodore.tabs.directive"), applies: (language) => getT(language)("objectives.commodore.inbox.applies.directive") },
    { id: "intel", title: (language) => getT(language)("objectives.commodore.tabs.intel"), applies: (language) => getT(language)("objectives.commodore.inbox.applies.intel") },
    { id: "settings", title: (language) => getT(language)("objectives.commodore.tabs.settings"), applies: (language) => getT(language)("objectives.commodore.inbox.applies.settings") },
  ],
  operatorDirectivePageId: "directive",
  read: (theater, language) => {
    const t = getT(language);
    const experiment = readCommodoreExperiment();
    if (!experiment.known) return cachedSectionState({ availability: "loading", scope: "" });
    if (!experiment.enabled) return cachedSectionState({ availability: "disabled", scope: "", disabledNote: t("objectives.commodore.inbox.disabled") });
    return cachedSectionState({ availability: "available", scope: commodoreStatusLine(t, theater.id, language) });
  },
  subscribe: subscribeCommodore,
  render: (context) => <CommodoreInboxSection context={context} />,
  // 폰 배치로 바뀌면 같은 구역의 폰 사령관 화면으로 넘긴다.
  onLeaveDesktop: ({ theater, pageId }) => openCommodoreMobile(COMMODORE_PAGES.includes(pageId as CommodoreTab) ? pageId as CommodoreTab : "log", theater.id),
  // 대화 중심 화면에서 기록을 여는 요청은 가운데 칸의 사령관 대화가 받는다 — 나머지 칸은 그 대화의 오른쪽 탭이 대신한다.
  openConversation: ({ theater, pageId }) => pageId === "log" && openCommodoreConversation(theater.id),
  // 사령관에게는 목표가 없다 — 이 섹션을 열 때 열려 있던 목표 패널을 남기지 않는다. 도구 줄은 가운데 대화 머리의 공통 도구모음이
  // 맡고, 그 도구모음은 목표를 싣지 않는다. 필드는 SDK 에서 @deprecated 다(남은 소비처가 없어지면 함께 걷는다).
  omitsRailEntries: [OBJECTIVES_ENTRY_ID],
};

function CommodoreInboxSection({ context }: { readonly context: TheaterInboxBodyContext }) {
  const { theater, language, pageId, visible, focusRequest, links, navigation } = context;
  const theaterId = theater.id;
  const t = getT(language);
  noteCommodoreLanguage(language);
  const tab: CommodoreTab = COMMODORE_PAGES.includes(pageId as CommodoreTab) ? pageId as CommodoreTab : "log";
  const { view, entries, live, hasMore, transcriptLoaded } = useCommodore(theaterId);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // 곁 칸에서 고른 시각 — 기록 칸이 그 시각의 턴을 드러낸다. 같은 줄을 다시 눌러도 다시 드러나게 nonce 가 오른다.
  const [reveal, setReveal] = useState<{ readonly at: number; readonly nonce: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [trailPreferred, setTrailPreferred] = useState(readTrailWidth);
  const [logBodyWidth, setLogBodyWidth] = useState(0);
  // 섹션을 처음 들를 때 상태와 기록 한 쪽을 읽는다 — 이미 읽었으면 다시 읽지 않는다.
  useEffect(() => {
    void loadCommodore(theaterId);
    if (!readCommodore(theaterId).transcriptLoaded) void loadTranscript(theaterId);
  }, [theaterId]);
  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node || !visible) return;
    const measure = () => setLogBodyWidth(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  const measured = logBodyWidth > 0;
  const compact = measured && logBodyWidth < COMPACT_BODY_WIDTH;
  const trailWidth = measured ? clampTrailWidth(trailPreferred, logBodyWidth) : trailPreferred;
  const setTrailWidth = (next: number) => {
    const clamped = clampTrailWidth(next, logBodyWidth);
    setTrailPreferred(clamped);
    writeTrailWidth(clamped);
  };
  // 더블클릭·Enter는 기본 260을 기억한다. 지금 본문이 좁으면 화면에는 절반까지만 그리고, 본문이 넓어지면 기본으로 돌아온다.
  const resetTrailWidth = () => {
    setTrailPreferred(TRAIL_WIDTH_DEFAULT);
    writeTrailWidth(TRAIL_WIDTH_DEFAULT);
  };
  const on = view?.state.autonomy === true;
  const run = view?.run;

  // 입구가 맡긴 포커스 — 기록은 입력란(바로 말할 수 있게), 지시는 지시 입력란. 링크로 온 「입력 끝」은 커서를 글 끝에 둔다.
  // 입력란이 없는 칸은 호스트가 준 칸 제목 포커스를 그대로 둔다. 지시 입력란은 상태를 읽은 뒤에야 서므로 그때 한 번.
  const handledFocus = useRef(0);
  useEffect(() => {
    if (!visible || !focusRequest || handledFocus.current === focusRequest.nonce) return;
    const selector = tab === "directive" ? "#objectives-commodore-directive" : tab === "log" ? ".objectives-commodore-composer-input" : tab === "intel" && focusRequest.kind === "editor-end" ? "#objectives-commodore-intel" : null;
    if (!selector) { handledFocus.current = focusRequest.nonce; return; }
    const field = rootRef.current?.querySelector<HTMLTextAreaElement>(selector);
    if (!field) return;
    handledFocus.current = focusRequest.nonce;
    if (field.hasAttribute("disabled")) return;
    field.focus({ preventScroll: true });
    if (focusRequest.kind === "editor-end") {
      const end = field.value.length;
      field.setSelectionRange(end, end);
      field.scrollTop = field.scrollHeight;
    }
  }, [visible, focusRequest, tab, view !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (error: unknown) => {
    const code = error instanceof Error ? error.message : "failed";
    if (ENDED_ASK_CODES.has(code)) { setFailure(errorWord(t, code)); return; }
    setFailure(code === "commodore_disabled" ? t("objectives.commodore.failed.disabled") : code === "commodore_inactive" ? t("objectives.commodore.failed.inactive") : t("objectives.commodore.failed", { code }));
  };
  const openSystemPrompt = () => navigation.open({ ...links.systemPrompt, theaterId, focus: "editor-end" });
  const totals = !view ? "" : [
    run && run.totals.session > 0 ? t("objectives.commodore.drawer.session", { n: run.totals.session }) : null,
    t("objectives.commodore.drawer.cost", { cost: (run?.totals.costUsd ?? 0).toFixed(2) }),
  ].filter(Boolean).join(" · ");

  return (
    <div ref={rootRef} className={`objectives-commodore-inbox${compact ? " is-compact" : ""}`}>
      {on && (run?.phase === "retrying" || run?.phase === "error") ? (
        <div className="objectives-commodore-retry">
          <span>{run.reason ? errorWord(t, run.reason) : t("objectives.commodore.meta.error")}</span>
          <button type="button" className="objectives-commodore-text-button" onClick={() => { setFailure(null); void retryCommodore(theaterId).catch(fail); }}>{t("objectives.commodore.drawer.retryNow")}</button>
        </div>
      ) : null}
      {tab === "log" ? (
        <div className="objectives-commodore-toolbar">
          <span className="objectives-commodore-totals">{totals}</span>
          <CommodoreClearButton t={t} theaterId={theaterId} onFail={fail} onClear={() => setFailure(null)} />
        </div>
      ) : null}
      {/* 사령관의 질문 — 기록 위에 고정된다. 답하면 내려가고 기록에 남는다. */}
      {tab === "log" ? <CommodoreAskCards theaterId={theaterId} t={t} language={language} onEnded={fail} /> : null}
      <div ref={bodyRef} className={`objectives-commodore-body is-${tab}`}>
        {tab === "log" ? (
          <>
            <CommodoreLog t={t} language={language} theaterId={theaterId} entries={entries} live={live} hasMore={hasMore} loaded={transcriptLoaded} reveal={reveal} />
            {compact ? null : (
              <CommodoreTrailSeam
                label={t("objectives.commodore.trail.resize")}
                value={trailWidth}
                bodyWidth={logBodyWidth}
                onChange={setTrailWidth}
                onReset={resetTrailWidth}
              />
            )}
            <CommodoreTrail t={t} language={language} theaterId={theaterId} width={compact || !measured ? undefined : trailWidth} onReveal={(at) => setReveal((current) => ({ at, nonce: (current?.nonce ?? 0) + 1 }))} />
          </>
        ) : null}
        {tab === "directive" && view ? <CommodoreDirective t={t} theaterId={theaterId} directive={view.state.directive} active={view.active} onOpenSystemPrompt={openSystemPrompt} onFail={fail} onClear={() => setFailure(null)} /> : null}
        {tab === "intel" && view ? <CommodoreIntel t={t} theaterId={theaterId} intel={view.state.intel} sources={view.state.sources} onFail={fail} onClear={() => setFailure(null)} /> : null}
        {/* 설정 칸의 메뉴(순찰·종료 시각·모델 좌표)는 body 포털이라 숨김이 닿지 않는다 — 섹션이 가려지면 칸째 내려 메뉴를 닫는다.
            설정은 누르는 즉시 저장이라 내려도 잃는 입력이 없다. */}
        {tab === "settings" && view && visible ? <CommodoreSettings t={t} language={language} theaterId={theaterId} view={view} onFail={(error) => { fail(error); }} onClear={() => setFailure(null)} /> : null}
      </div>
      {failure ? <p className="objectives-commodore-failure" role="alert">{failure}</p> : null}
      {tab === "log" ? <footer className="objectives-commodore-foot"><CommodoreComposer t={t} theaterId={theaterId} active={view ? view.active : true} context={run?.context} onFail={fail} onClear={() => setFailure(null)} /></footer> : null}
    </div>
  );
}

/* ── 설정 ─────────────────────────────────────────────────────────────── */

type CommodoreView = NonNullable<ReturnType<typeof useCommodore>["view"]>;

/** 「기본값 사용」 — 설정 줄 설명 끝의 글자 단추. 기본값을 쓰는 중이면 서지 않는다. */
function UseDefault({ t, onClick }: { readonly t: T; readonly onClick: () => void }) {
  return <> <button type="button" className="objectives-commodore-default" onClick={onClick}>{t("objectives.commodore.settings.useDefault")}</button></>;
}


/**
 * 설정 — Console 설정과 같은 줄(제목·설명·오른쪽 컨트롤). 모델·강도는 Console 공유 선택기 하나로 고른다(사령관은 Agent SDK
 * 로스터, 지휘관은 Agent CLI 로스터).
 */
export function CommodoreSettings({ t, language, theaterId, view, onFail, onClear }: { readonly t: T; readonly language: "en" | "ko"; readonly theaterId: string; readonly view: CommodoreView; readonly onFail: (error: unknown) => void; readonly onClear: () => void }) {
  const { state, defaults, run } = view;
  const on = state.autonomy === true;
  const modelOverridden = state.model !== undefined;
  const patrol = state.patrolMinutes ?? DEFAULT_PATROL;
  const commanderOverridden = state.commanderModel !== undefined;
  const act = (work: () => Promise<void>) => { onClear(); void work().catch(onFail); };
  return (
    <div className="objectives-commodore-settings">
      <SettingsRow label={t("objectives.commodore.settings.autonomy")} hint={t("objectives.commodore.settings.autonomyHint")}>
        <SettingsToggle checked={on} ariaLabel={t("objectives.commodore.switchAria")} onChange={(next) => act(() => setCommodoreAutonomy(theaterId, next))} />
      </SettingsRow>
      <SettingsRow
        label={t("objectives.commodore.settings.model")}
        hint={<>{t("objectives.commodore.settings.modelHint")}{modelOverridden ? <UseDefault t={t} onClick={() => act(() => setCommodoreCoordinates(theaterId, null))} /> : null}</>}
      >
        <CommodoreCoordinateField
          t={t}
          target="agent"
          label={t("objectives.commodore.drawer.modelAria")}
          value={commodoreValue(state)}
          fallback={defaults}
          onChange={(next) => act(() => setCommodoreCoordinates(theaterId, commodoreCoordinates(state, defaults, next)))}
        />
      </SettingsRow>
      <SettingsRow
        label={t("objectives.commodore.settings.patrol")}
        hint={<>{t("objectives.commodore.settings.patrolHint")}{state.patrolMinutes !== undefined ? <UseDefault t={t} onClick={() => act(() => setCommodorePatrol(theaterId, null))} /> : null}</>}
      >
        <PatrolControl
          t={t}
          minutes={patrol}
          nextPatrolAt={on && run.phase === "idle" ? run.nextWakeAt : undefined}
          onPick={(minutes) => act(() => setCommodorePatrol(theaterId, minutes === DEFAULT_PATROL ? null : minutes))}
        />
      </SettingsRow>
      <SettingsRow label={t("objectives.commodore.stop.title")} hint={t("objectives.commodore.stop.hint")}>
        <StopAtControl t={t} language={language} stopAt={state.stopAt} disabled={!on || run.reason === "scheduled_stop"} onPick={(stopAt) => act(() => setCommodoreStopAt(theaterId, stopAt))} />
      </SettingsRow>
      <div className="objectives-commodore-settings-divider" role="separator" />
      <SettingsRow
        label={t("objectives.commodore.settings.commander")}
        hint={<>{t("objectives.commodore.settings.commanderHint")}{commanderOverridden ? <UseDefault t={t} onClick={() => act(() => setCommodoreCommander(theaterId, null))} /> : null}</>}
      >
        <CommodoreCoordinateField
          t={t}
          target="launch"
          label={t("objectives.commodore.settings.commanderAria")}
          value={commanderValue(state)}
          fallback={DEFAULT_LAUNCH}
          onChange={(next) => act(() => setCommodoreCommander(theaterId, commanderCoordinates(state, next)))}
        />
      </SettingsRow>
    </div>
  );
}

function stopTime(at: number, language: "en" | "ko"): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", { ...(sameDay ? {} : { month: "short", day: "numeric" }), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

function StopAtControl({ t, language, stopAt, disabled, onPick }: { readonly t: T; readonly language: "en" | "ko"; readonly stopAt?: number; readonly disabled: boolean; readonly onPick: (at: number | null) => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = () => { setAnchor(null); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (disabled) setAnchor(null); }, [disabled]);
  return <>
    <button ref={trigger} type="button" className="fc-row-value objectives-commodore-patrol" disabled={disabled} aria-haspopup="dialog" aria-expanded={!!anchor} aria-label={t("objectives.commodore.stop.title")} onClick={() => setAnchor(trigger.current?.getBoundingClientRect() ?? null)}>
      <span className="objectives-commodore-patrol-glyph"><PatrolGlyph /></span>
      <span className="fc-row-value-text">{stopAt ? stopTime(stopAt, language) : t("objectives.commodore.stop.none")}</span>
    </button>
    {anchor && !disabled ? <DatePicker withTime anchor={anchor} value={stopAt ? localDateTime(new Date(stopAt)) : null} language={language} t={t} onClose={close} onPick={(value) => onPick(value === null ? null : new Date(value).getTime())} /> : null}
  </>;
}



const PatrolGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="8.5" r="5.25" />
    <path d="M8 5.75V8.5l1.9 1.2M6.5 1.75h3" />
  </svg>
);

const CheckGlyph = () => <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.75 6.25 5 8.5l4.25-5" /></svg>;

/**
 * 순찰 간격 — 모델 칩 옆의 같은 문법(글리프 + 낱말)이고, 누르면 같은 유리 메뉴에 사다리가 선다. 고르면 곧바로 저장하고 닫힌다.
 * 메뉴는 body 포털이라 서랍의 Esc(서랍 닫기)에 닿지 않게 키 입력을 메뉴 안에서 끝낸다.
 */
function PatrolControl({ t, minutes, nextPatrolAt, onPick }: { readonly t: T; readonly minutes: number; readonly nextPatrolAt: number | undefined; readonly onPick: (minutes: CommodorePatrolMinutes) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const focusOnOpen = useRef(false);
  const word = patrolWord(t, minutes);
  const title = [t("objectives.commodore.patrol.title", { interval: word }), nextPatrolAt ? t("objectives.commodore.drawer.nextPatrol", { time: clockTime(nextPatrolAt) }) : null].filter(Boolean).join(" · ");

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.max(PATROL_MENU_MARGIN, Math.min(rect.right - PATROL_MENU_WIDTH, window.innerWidth - PATROL_MENU_WIDTH - PATROL_MENU_MARGIN));
    const height = menuRef.current?.offsetHeight ?? 300;
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - PATROL_MENU_MARGIN ? Math.max(PATROL_MENU_MARGIN, rect.top - height - 6) : below;
    setPos({ left, top, width: PATROL_MENU_WIDTH });
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const close = (refocus: boolean) => { setOpen(false); if (refocus) triggerRef.current?.focus({ preventScroll: true }); };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => { event.preventDefault(); items[(next + items.length) % items.length]?.focus(); };
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Tab") close(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        // 설정 행의 값 자리 — 모델 좌표 선택기의 field 변형과 같은 호스트 계약(fc-row-value)으로 그린다.
        className="fc-row-value objectives-commodore-patrol"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t("objectives.commodore.patrol.aria")} · ${word}`}
        title={title}
        onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusOnOpen.current = true; setOpen(true); } }}
        onClick={(event) => { focusOnOpen.current = event.detail === 0; setOpen((value) => !value); }}
      >
        <span className="objectives-commodore-patrol-glyph"><PatrolGlyph /></span>
        <span className="fc-row-value-text">{word}</span>
      </button>
      {open ? createPortal(
        <div ref={menuRef} className="objectives-menu objectives-commodore-patrol-menu" role="menu" aria-label={t("objectives.commodore.patrol.aria")} style={pos} onKeyDown={onMenuKey}>
          <div className="objectives-menu-head">
            <b>{t("objectives.commodore.patrol.head")}</b>
            <span>{t("objectives.commodore.patrol.hint")}</span>
          </div>
          {PATROL_STEPS.map((step) => {
            const active = step === minutes;
            return (
              <button key={step} type="button" role="menuitemradio" aria-checked={active} className={`objectives-menu-item${active ? " is-active" : ""}`} onClick={() => { if (!active) onPick(step); close(true); }}>
                <span className="objectives-menu-label">{patrolWord(t, step)}</span>
                {step === DEFAULT_PATROL ? <span className="objectives-menu-hint">{t("objectives.commodore.patrol.default")}</span> : null}
                <span className="objectives-menu-chev objectives-commodore-patrol-check" aria-hidden="true">{active ? <CheckGlyph /> : null}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/* ── 기록 ─────────────────────────────────────────────────────────────── */

/** 바닥에서 이만큼 안이면 새 줄을 따라 내려간다 — 위를 읽는 중이면 자리를 지킨다. */
const FOLLOW_SLACK_PX = 48;

/**
 * 사령관 기록 — Operation 채팅과 같은 턴 렌더러로 그린다. 진행 중인 턴과 마지막으로 끝난 턴만 펼치고,
 * 그 전 턴은 「출처 · 답 첫 줄 · 걸린 시간 · 시각」 한 줄로 접는다. 줄 자체가 버튼이고, 곁 칸에서 시각을 누르면 그 턴이 펼쳐진다.
 */
export function CommodoreLog({ t, language, theaterId, entries, live, hasMore, loaded, reveal }: { readonly t: T; readonly language: "en" | "ko"; readonly theaterId: string; readonly entries: readonly CommodoreTranscriptEntry[]; readonly live: readonly CommodoreLiveEvent[]; readonly hasMore: boolean; readonly loaded: boolean; readonly reveal: { readonly at: number; readonly nonce: number } | null }) {
  const Transcript = commodoreTranscriptRenderer();
  // 질문 줄의 지금(답을 기다림·답함·거둠)은 상태의 질문에서 읽는다.
  const asks = useCommodore(theaterId).view?.state.asks;
  const blocks = useMemo(() => commodoreLogBlocks(t, entries, live, asks), [t, entries, live, asks]);
  const references = useCommodoreReferenceHost(t, theaterId);
  const lastFinishedId = useMemo(() => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (block?.kind === "turn" && !block.turn.working) return block.turn.id;
    }
    return null;
  }, [blocks]);
  const [pinnedOpen, setPinnedOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [pinnedClosed, setPinnedClosed] = useState<ReadonlySet<string>>(() => new Set());
  const revealedId = reveal ? commodoreTurnCovering(blocks, reveal.at)?.id ?? null : null;
  useEffect(() => {
    if (!revealedId) return;
    setPinnedOpen((current) => (current.has(revealedId) ? current : new Set(current).add(revealedId)));
    setPinnedClosed((current) => {
      if (!current.has(revealedId)) return current;
      const next = new Set(current);
      next.delete(revealedId);
      return next;
    });
  }, [reveal?.nonce, revealedId]);
  const openTurn = (turn: CommodoreLogTurn) => turn.working || pinnedOpen.has(turn.id) || (!pinnedClosed.has(turn.id) && turn.id === lastFinishedId);
  const toggleTurn = (turn: CommodoreLogTurn) => {
    if (turn.working) return;
    const open = openTurn(turn);
    setPinnedOpen((current) => {
      const next = new Set(current);
      if (open) next.delete(turn.id);
      else next.add(turn.id);
      return next;
    });
    setPinnedClosed((current) => {
      const next = new Set(current);
      if (open) next.add(turn.id);
      else next.delete(turn.id);
      return next;
    });
  };
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);
  const anchor = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (anchor.current !== null) { node.scrollTop += node.scrollHeight - anchor.current; anchor.current = null; return; }
    if (follow.current) node.scrollTop = node.scrollHeight;
  }, [blocks]);
  const older = () => {
    if (loadingOlder) return;
    anchor.current = scrollRef.current?.scrollHeight ?? null;
    setLoadingOlder(true);
    void loadTranscript(theaterId, { older: true }).finally(() => setLoadingOlder(false));
  };
  const empty = loaded && blocks.length === 0;
  return (
    <div ref={scrollRef} className="objectives-commodore-log" onScroll={(event) => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_SLACK_PX; }}>
      {empty ? <p className="objectives-commodore-empty">{t("objectives.commodore.log.empty")}</p> : null}
      {hasMore ? (
        <button type="button" className="objectives-commodore-text-button objectives-commodore-older" disabled={loadingOlder} onClick={older}>
          {t("objectives.commodore.log.older")}
        </button>
      ) : null}
      {Transcript ? blocks.map((block) => {
        if (block.kind === "note") {
          const note = { kind: "note" as const, text: block.text, ...(block.at !== undefined ? { at: block.at } : {}), ...(block.tone ? { tone: block.tone } : {}) };
          return <Transcript key={`note-${block.at ?? block.text}`} entries={[{ event: note, ...(block.at !== undefined ? { at: block.at } : {}) }]} language={language} />;
        }
        const turn = block.turn;
        const open = openTurn(turn);
        const line = turn.working ? null : (
          <CommodoreTurnLine t={t} turn={turn} open={open} onToggle={() => toggleTurn(turn)} />
        );
        if (!open) return <div key={turn.id}>{line}</div>;
        const shown = turn.message || turn.working ? turn.entries : turn.entries.filter((entry) => entry.event.kind !== "dispatch");
        return (
          <div key={turn.id} className="objectives-commodore-turn-open" data-commodore-turn={turn.id}>
            {line}
            <Transcript entries={shown} language={language} reveal={reveal && revealedId === turn.id ? reveal : null} references={references} />
          </div>
        );
      }) : null}
    </div>
  );
}

/** 접힌 턴 한 줄. 채팅 작업 접힘과 같이 줄 끝의 ⌄가 열림을 말하고, 줄 자체가 버튼이다. */
function CommodoreTurnLine({ t, turn, open, onToggle }: { readonly t: T; readonly turn: CommodoreLogTurn; readonly open: boolean; readonly onToggle: () => void }) {
  const duration = turnDuration(t, turn.durationMs);
  const meta = [duration, clockTime(turn.at)].filter(Boolean).join(" · ");
  const tone = turn.failed ? " is-error" : turn.stopped ? " is-stopped" : turn.message ? " is-message" : "";
  return (
    <button
      type="button"
      className={`objectives-commodore-turn${tone}${open ? " is-open" : ""}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="objectives-commodore-turn-dot" aria-hidden="true" />
      <span className="objectives-commodore-turn-label">{turn.label}</span>
      <span className="objectives-commodore-turn-summary">{turn.summary}</span>
      <span className="objectives-commodore-turn-meta">{meta}</span>
      <span className="objectives-commodore-turn-chev" aria-hidden="true">⌄</span>
    </button>
  );
}

function turnDuration(t: T, durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return t("objectives.commodore.log.seconds", { n: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0
    ? t("objectives.commodore.log.minutes", { n: minutes })
    : t("objectives.commodore.log.minutesSeconds", { m: minutes, s: rest });
}


/** 시트를 닫아도 남기는 입력. Theater마다 하나고, 전송·저장으로 비운 값은 지운다. */
interface SheetDraft {
  readonly directive: string | null;
  readonly intel: string;
}
const sheetDrafts = new Map<string, SheetDraft>();
function sheetDraft(theaterId: string): SheetDraft {
  return sheetDrafts.get(theaterId) ?? { directive: null, intel: "" };
}
function rememberSheetDraft(theaterId: string, patch: Partial<SheetDraft>): void {
  sheetDrafts.set(theaterId, { ...sheetDraft(theaterId), ...patch });
}


/**
 * 전송 왼쪽의 문맥 원호. 채팅과 같은 16px 글리프이고, 내역은 총량과 압축 기준선만 말한다. 기준선은 서버가 보낸 압축 지점이고,
 * 서버도 그 지점을 모르면(호스트가 모르는 Gateway 모델) 기준선과 「압축 기준까지」 없이 사용량만 말한다.
 */
function CommodoreContextMeter({ t, context }: { readonly t: T; readonly context: NonNullable<CommodoreRunStatus["context"]> }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);
  const occupied = context.inputTokens;
  const compactAt = context.compactAt;
  const limit = compactAt !== undefined && context.window > 0 ? Math.min(1, compactAt / context.window) : 1;
  const ratio = context.window > 0 ? occupied / context.window : 0;
  const tone = ratio >= limit * 0.97 ? " is-critical" : ratio >= limit * 0.75 ? " is-warn" : "";
  const percent = Math.round(ratio * 100);
  const summary = `${formatContextTokens(occupied)} / ${formatContextTokens(context.window)}`;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(1, ratio)) * circumference;
  const untilCompact = compactAt !== undefined ? Math.max(0, compactAt - occupied) : null;
  const free = Math.max(0, context.window - occupied);
  return (
    <span className={`objectives-commodore-ctx${tone}`} ref={wrapRef}>
      <button
        type="button"
        className="objectives-commodore-ctx-chip"
        aria-expanded={open}
        aria-label={t("objectives.commodore.context.aria", { percent, summary })}
        title={t("objectives.commodore.context.title", { summary })}
        onClick={() => setOpen((was) => !was)}
      >
        <svg className="objectives-commodore-ctx-arc" viewBox="0 0 16 16" aria-hidden="true">
          <circle className="objectives-commodore-ctx-track" cx="8" cy="8" r={radius} />
          <circle className="objectives-commodore-ctx-fill" cx="8" cy="8" r={radius} strokeDasharray={`${filled.toFixed(2)} ${circumference.toFixed(2)}`} />
        </svg>
      </button>
      {open ? (
        <div className="objectives-commodore-ctx-pop" role="dialog" aria-label={t("objectives.commodore.context.label")}>
          <div className="objectives-commodore-ctx-head">
            <span>{t("objectives.commodore.context.label")}</span>
            <span>{summary} · {percent}%</span>
          </div>
          <div className="objectives-commodore-ctx-bar">
            <i style={{ width: `${Math.min(100, ratio * 100)}%` }} />
            {untilCompact !== null ? <span className="objectives-commodore-ctx-line" style={{ left: `${limit * 100}%` }} /> : null}
          </div>
          <ul className="objectives-commodore-ctx-rows">
            <li><span className="objectives-commodore-ctx-swatch" /><span>{t("objectives.commodore.context.used")}</span><span>{formatContextTokens(occupied)}</span><span>{(ratio * 100).toFixed(1)}%</span></li>
            {untilCompact !== null ? <li><span className="objectives-commodore-ctx-swatch is-line" /><span>{t("objectives.commodore.context.untilCompact")}</span><span>{formatContextTokens(untilCompact)}</span><span>{Math.round(limit * 100)}%</span></li> : null}
            <li><span className="objectives-commodore-ctx-swatch is-free" /><span>{t("objectives.commodore.context.free")}</span><span>{formatContextTokens(free)}</span><span>{((free / context.window) * 100).toFixed(1)}%</span></li>
          </ul>
          {untilCompact !== null ? <p className="objectives-commodore-ctx-foot">{t("objectives.commodore.context.foot", { percent: Math.round(limit * 100) })}</p> : null}
        </div>
      ) : null}
    </span>
  );
}

/**
 * 사령관에게 말하기 — 채팅 화면의 입력과 같은 문법: 한 상자 안에 자라는 입력과 원형 전송, 초점이면 상자가 brass 로 선다.
 * 자율 운영이 꺼져 있으면 메시지 전송은 막지만 /clear는 받는다. 쓰던 초안은 그대로 두어 다시 켜면 보낼 수 있다.
 * 다른 창에서 막 끈 경합은 서버가 거절하고(`commodore_inactive`) 초안은 지우지 않는다.
 */
function useClearConfirmation(theaterId: string, onFail: (error: unknown) => void, onClear: () => void) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5_000);
    return () => clearTimeout(timer);
  }, [armed]);
  const request = async () => {
    if (working.current) return false;
    if (!armed) { setArmed(true); return false; }
    working.current = true; setBusy(true); setArmed(false); onClear();
    try { await clearCommodore(theaterId); return true; }
    catch (error) { onFail(error); return false; }
    finally { working.current = false; setBusy(false); }
  };
  return { armed, busy, request, disarm: () => setArmed(false) };
}

/** 글리프와 /clear 모두 키를 뗀 뒤의 두 번째 입력만 확정으로 받는다. */
function useReleasedKey() {
  const held = useRef<string | null>(null);
  return {
    down: (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return true;
      if (event.repeat || held.current === event.key) { event.preventDefault(); return false; }
      held.current = event.key;
      return true;
    },
    up: () => { held.current = null; },
  };
}

/**
 * `caption` — 대화 중심 화면 머리 pill 옆 대화 동작 묶음의 캡션 단추(호스트가 세우는 지구본과 같은 24px 평면 단추·말풍선 문법).
 * 기본은 시트 머리의 사각 단추다.
 */
export function CommodoreClearButton({ t, theaterId, variant = "sheet", onFail, onClear }: { readonly t: T; readonly theaterId: string; readonly variant?: "sheet" | "caption"; readonly onFail: (error: unknown) => void; readonly onClear: () => void }) {
  const clear = useClearConfirmation(theaterId, onFail, onClear);
  const key = useReleasedKey();
  if (variant === "caption") {
    return <div className="objectives-commodore-clear-wrap is-caption">
      {clear.armed ? <span className="objectives-commodore-clear-confirm" role="status">{t("objectives.commodore.clear.confirm")}</span> : null}
      <CaptionTipHost label={t("objectives.commodore.clear.title")}>
        <button type="button" className={`fleet-caption-action${clear.armed ? " is-armed" : ""}`} disabled={clear.busy} aria-label={t(clear.armed ? "objectives.commodore.clear.confirm" : "objectives.commodore.clear.title")} onPointerDown={(event) => { event.stopPropagation(); }} onClick={() => void clear.request()} onKeyDown={key.down} onKeyUp={key.up} onBlur={() => { key.up(); clear.disarm(); }}>
          <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 10 6-7 6 5-6 7H6zM9 15h6M6 7l6 5" /></svg>
        </button>
      </CaptionTipHost>
    </div>;
  }
  return <div className="objectives-commodore-clear-wrap">
    {clear.armed ? <span className="objectives-commodore-clear-confirm" role="status">{t("objectives.commodore.clear.confirm")}</span> : null}
    <button type="button" className={`objectives-commodore-clear${clear.armed ? " is-armed" : ""}`} disabled={clear.busy} aria-label={t(clear.armed ? "objectives.commodore.clear.confirm" : "objectives.commodore.clear.title")} title={t("objectives.commodore.clear.hint")} onClick={() => void clear.request()} onKeyDown={key.down} onKeyUp={key.up} onBlur={() => { key.up(); clear.disarm(); }}>
      <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 10 6-7 6 5-6 7H6zM9 15h6M6 7l6 5" /></svg>
    </button>
  </div>;
}

interface CommodoreComposerDraft {
  /** 본문 — 지휘관 참조 토큰 자리마다 표식 글자 하나(`commodore-reference-input.tsx`). */
  readonly text: string;
  /** 본문 속 지휘관 참조 — 표식 글자가 나온 순서. */
  readonly references: readonly CommodoreReference[];
  readonly textRevision: number;
  readonly sending: boolean;
  /** 사령관만의 거절(합계 8 MiB). 그 밖 첨부 안내는 공유 스토어가 가진다. */
  readonly budgetNotice: string | null;
}

/** 플러그인 내부 페이지 메모리 — Inbox 시트와 대화 화면은 Theater별 사령관 초안 하나를 읽는다. */
const commodoreDrafts = new Map<string, ReturnType<typeof createCommodoreDraft>>();
function createCommodoreDraft() {
  const attachments = createComposerAttachments({
    upload: (file) => uploadCommodoreAttachment(file),
    discard: (id) => discardCommodoreAttachment(id),
  });
  let current: CommodoreComposerDraft = { text: "", references: [], textRevision: 0, sending: false, budgetNotice: null };
  const listeners = new Set<() => void>();
  return {
    attachments,
    read: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (patch: Partial<CommodoreComposerDraft>) => {
      current = { ...current, ...patch };
      for (const listener of listeners) listener();
    },
  };
}
function commodoreDraft(theaterId: string) {
  let draft = commodoreDrafts.get(theaterId);
  if (!draft) { draft = createCommodoreDraft(); commodoreDrafts.set(theaterId, draft); }
  return draft;
}

/**
 * 사령관 입력창 수신함 — 대화 옆 칸의 플릿 브라우저가 맡긴 주석·스크린샷. 입력창이 서 있고 받을 수 있으면 곧장 붙여넣기와 같은 길
 * (업로드 → 칩)로 세우고, 아니면 받을 수 있게 될 때 꺼낸다. 보내지는 않는다 — 발사는 언제나 사람의 Enter 다.
 */
const commodoreInbox = new Map<string, File[]>();
const commodoreInboxListeners = new Map<string, Set<() => void>>();
export function attachToCommodoreComposer(theaterId: string, files: readonly File[]): void {
  if (files.length === 0) return;
  commodoreInbox.set(theaterId, [...(commodoreInbox.get(theaterId) ?? []), ...files]);
  for (const listener of commodoreInboxListeners.get(theaterId) ?? []) listener();
}
function drainCommodoreInbox(theaterId: string): File[] {
  const files = commodoreInbox.get(theaterId) ?? [];
  commodoreInbox.delete(theaterId);
  return files;
}
function subscribeCommodoreInbox(theaterId: string, listener: () => void): () => void {
  const set = commodoreInboxListeners.get(theaterId) ?? new Set<() => void>();
  set.add(listener);
  commodoreInboxListeners.set(theaterId, set);
  return () => { set.delete(listener); if (set.size === 0) commodoreInboxListeners.delete(theaterId); };
}

/** 폰 사령관 화면의 「보내는 중…」 말풍선 — 확정 줄이 오기 전까지 기록 맨 아래에 선다. 이미지는 보낸 썸네일 그대로다. */
export interface CommodorePendingMessage {
  readonly key: number;
  readonly text: string;
  readonly at: number;
  readonly images: readonly { readonly key: string; readonly name: string; readonly url: string }[];
}

/**
 * 폰 사령관 화면(바로가기 목적지)에서 쓸 때만 싣는다. 데스크톱과 같은 캡슐·초안·첨부 길이고, 폰에서 달라지는 것만 여기서 받는다:
 * 연결이 끊기면 잠그고, 보내기 실패는 입력창 위 안내 줄이 말하고, 보내는 동안의 말풍선은 화면이 그린다.
 */
export interface CommodoreComposerPhone {
  readonly online: boolean;
  readonly failure: string | null;
  readonly onPending: (pending: CommodorePendingMessage | null) => void;
}

interface CommodoreComposerProps {
  readonly t: T;
  readonly theaterId: string;
  readonly active: boolean;
  readonly context?: CommodoreRunStatus["context"];
  readonly phone?: CommodoreComposerPhone;
  readonly onFail: (error: unknown) => void;
  readonly onClear: () => void;
}

/** 터치 기기의 화면 키보드에서는 Enter 가 줄바꿈이다 — 보내기는 원으로 한다. 하드웨어 키보드(정밀 포인터)는 Enter 로 보낸다. */
const touchFirst = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

export function CommodoreComposer(props: CommodoreComposerProps) {
  // Theater가 바뀌면 /clear 확인·메뉴·조합 상태도 새 대화의 것이 된다. 초안만 외부 메모리에서 복원한다.
  return <CommodoreComposerBody key={props.theaterId} {...props} />;
}

/**
 * 캡슐은 지휘관 대화 입력창(그룹 입력창)과 같은 부품이다 — 왼쪽 「+」 원, 가운데 입력, 오른쪽 보내기 원, 캡슐 맨 위 첨부 줄,
 * 입력창 위 한 줄 안내. 외형·첨부 문구는 SDK(`@fleet-console/sdk/composer`)가 한 벌로 가진다. 「+」 메뉴의 둘째 행만 사령관의 것
 * (「지휘관 참조」)이다.
 */
function CommodoreComposerBody({ t, theaterId, active, context, phone, onFail, onClear }: CommodoreComposerProps) {
  const ct = composerT(commodoreLanguage());
  const draft = commodoreDraft(theaterId);
  const { text, references, sending, budgetNotice } = useSyncExternalStore(draft.subscribe, draft.read, draft.read);
  const attachmentSnap = useComposerAttachmentSnapshot(draft.attachments);
  const attachments = attachmentSnap.items;
  const value = useMemo(() => ({ text, references }), [text, references]);
  const setValue = (next: { readonly text: string; readonly references: readonly CommodoreReference[] }) => draft.update({ text: next.text, references: next.references, textRevision: draft.read().textRevision + 1 });
  const setSending = (value: boolean) => draft.update({ sending: value });
  const setBudgetNotice = (value: string | null) => draft.update({ budgetNotice: value });
  const composing = useRef(false);
  const inputRef = useRef<CommodoreReferenceInputHandle | null>(null);
  const clear = useClearConfirmation(theaterId, onFail, onClear);
  const clearKey = useReleasedKey();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const plusRootRef = useRef<HTMLDivElement | null>(null);
  const plusRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const menuId = `commodore-composer-menu-${theaterId}`;
  // 폰은 연결이 끊겨도 잠근다. 데스크톱은 자율 운영이 꺼져도 /clear 를 받으므로 입력은 열어 둔다.
  const usable = active && (phone ? phone.online : true);
  const finishSentDraft = (sentKeys: readonly string[], sentRevision: number, discardSent: boolean) => {
    const current = draft.read();
    draft.attachments.releaseSent(sentKeys, discardSent);
    draft.update({
      ...(current.textRevision === sentRevision ? { text: "", references: [] } : {}),
    });
  };
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const pointer = (event: PointerEvent) => { if (!plusRootRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMenuOpen(false); plusRef.current?.focus(); }
      else if (event.key === "Tab") setMenuOpen(false);
      else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : at < 0 ? 0 : (at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener("pointerdown", pointer); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); };
  }, [menuOpen]);
  useEffect(() => { if (!usable) setMenuOpen(false); }, [usable]);
  const addFiles = (files: readonly File[]) => {
    if (!usable || draft.read().sending || clear.busy) return;
    setBudgetNotice(null);
    draft.attachments.add(files, (file) => file.name.trim().length > 0 ? file.name : ct("composer.attach.pasted"));
  };
  // 수신함 — 받을 수 있을 때만 꺼낸다(잠긴 동안 맡겨진 것은 풀리면 선다). 최신 판정을 읽도록 ref 로 잇는다.
  const takeInbox = useRef<() => void>(() => undefined);
  takeInbox.current = () => {
    if (!usable || draft.read().sending || clear.busy) return;
    const files = drainCommodoreInbox(theaterId);
    if (files.length === 0) return;
    addFiles(files);
    if (!phone) inputRef.current?.focus();
  };
  useEffect(() => subscribeCommodoreInbox(theaterId, () => takeInbox.current()), [theaterId]);
  useEffect(() => { takeInbox.current(); }, [usable, sending, clear.busy]);
  const uploading = attachments.some((item) => item.uploading);
  // /clear 는 데스크톱 입력창의 길이다 — 폰에서는 두 번 눌러 확정하는 안내를 둘 자리가 없어 보통 말로 보낸다(지금과 같다).
  const isClear = !phone && text.trim() === "/clear";
  const armed = (usable || isClear) && !!text.trim() && !sending && !clear.busy && !uploading;
  const send = () => {
    const message = text.trim();
    // 폰에서 빈 입력으로 원을 누르면 입력칸에 초점만 간다(FD-19).
    if (phone && !message) { inputRef.current?.focus(); return; }
    if (draft.read().sending || uploading || clear.busy) return;
    const sent = draft.read();
    const sentItems = draft.attachments.read().items;
    const sentKeys = sentItems.map((item) => item.key);
    if (isClear) {
      if (clear.armed) setSending(true);
      void clear.request().then((cleared) => { if (cleared) finishSentDraft(sentKeys, sent.textRevision, true); }).finally(() => setSending(false));
      return;
    }
    if (!usable || !message) return;
    onClear(); setBudgetNotice(null); setMenuOpen(false);
    setSending(true);
    // 보내는 동안의 말풍선은 토큰 대신 「@제목」 평문이다 — 확정 줄이 오면 기록이 같은 자리에 토큰을 세운다.
    phone?.onPending({
      key: Date.now(),
      text: referencePlainText(message, sent.references.map(({ id, title }) => ({ id, label: title }))),
      at: Date.now(),
      images: sentItems.map((item) => ({ key: item.key, name: item.name, url: item.previewUrl })),
    });
    const ids = draft.attachments.ids();
    // 실패하면 쓴 말과 이미지는 남는다 — 입력창 위 안내 줄이 이유를 말한다. 만료만 칩을 걷는다.
    void messageCommodore(theaterId, message, ids, sent.references.map((reference) => reference.id)).then(() => finishSentDraft(sentKeys, sent.textRevision, false)).catch((error) => {
      if (draft.attachments.noteSendFailure(error, ids) === "expired") return;
      if (error instanceof Error && error.message === "attachment_budget_exceeded") setBudgetNotice(ct("composer.attach.commodoreBudget"));
      else if (mounted.current) onFail(error);
    }).finally(() => {
      setSending(false);
      phone?.onPending(null);
      // 폰은 화면 키보드를 다시 올리지 않는다 — 보낸 뒤 기록을 읽는 자리다.
      if (mounted.current && !phone) inputRef.current?.focus({ preventScroll: true });
    });
  };
  const failure = phone?.failure ?? null;
  return (
    <>
    {failure ? <ComposerNotice tone="danger" text={failure} dismissLabel={ct("composer.notice.dismiss")} onDismiss={onClear} />
      : (budgetNotice ?? composerAttachmentNoticeText(attachmentSnap.notice, ct)) ? <ComposerNotice tone="warn" text={budgetNotice ?? composerAttachmentNoticeText(attachmentSnap.notice, ct) ?? ""} dismissLabel={ct("composer.notice.dismiss")} onDismiss={() => { setBudgetNotice(null); draft.attachments.clearNotice(); inputRef.current?.focus(); }} /> : null}
    <div className={`fc-composer-capsule objectives-commodore-composer${active ? "" : " is-inactive"}${phone && !usable ? " is-disabled" : ""}${attachments.length ? " has-attachments" : ""}`} onClick={(event) => { if (event.target === event.currentTarget) inputRef.current?.focus(); }}>
      <ComposerAttachmentTray store={draft.attachments} t={ct} disabled={sending || clear.busy} />
      <div ref={plusRootRef} className="objectives-commodore-composer-plus-root">
        {menuOpen ? <ComposerMenu ref={menuRef} id={menuId} className="objectives-commodore-composer-menu" aria-label={ct("composer.more")}>
          <ComposerMenuItem glyph={<AttachImageIcon />} onClick={() => { setMenuOpen(false); fileRef.current?.click(); }}>{ct("composer.attach.image")}</ComposerMenuItem>
          <ComposerMenuItem glyph="@" keyHint="@" onClick={() => { setMenuOpen(false); inputRef.current?.openReferences(); }}>{t("objectives.commodore.reference.menu")}</ComposerMenuItem>
        </ComposerMenu> : null}
        <ComposerPlusButton ref={plusRef} aria-label={ct("composer.more")} title={ct("composer.more")} aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined} disabled={!usable || sending || clear.busy} onClick={() => setMenuOpen((open) => !open)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMenuOpen(true); } }} />
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; if (!phone) inputRef.current?.focus(); }} />
      </div>
      {/* 본문 속 지휘관 참조('@')를 품는 입력 — 높이는 CSS 가 내용만큼 자라게 하고(max-height 에서 멈춤), 맞춤법 밑줄은 채팅·새 세션
          입력처럼 끈다. 한글 조합 중 Enter 는 보내지 않는다(조합 상태는 이 컴포저도 따로 센다). */}
      <CommodoreReferenceInput
        ref={inputRef}
        t={t}
        theaterId={theaterId}
        {...(phone ? { phone: true } : {})}
        className="fc-composer-input objectives-commodore-composer-input"
        value={value}
        disabled={clear.busy || sending || (phone ? !usable : false)}
        onFiles={addFiles}
        isFile={isComposerAttachmentCandidate}
        ariaDescribedBy={active ? undefined : `objectives-commodore-composer-idle-${theaterId}`}
        placeholder={t("objectives.commodore.composer.placeholder")}
        ariaLabel={t("objectives.commodore.composer.aria")}
        onChange={(next) => { setValue(next); clear.disarm(); if (draft.read().budgetNotice) setBudgetNotice(null); if (draft.attachments.read().notice) draft.attachments.clearNotice(); }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => { if (isClear && !clearKey.down(event)) return; if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && !(phone && touchFirst())) { event.preventDefault(); send(); } }}
        onKeyUp={clearKey.up}
        onBlur={() => { clearKey.up(); clear.disarm(); }}
      />
      {context ? <CommodoreContextMeter t={t} context={context} /> : null}
      {/* 폰의 빈 원은 흐리지만 눌린다 — 누르면 입력칸으로 초점만 간다(FD-19). 올리는 중·보내는 중에는 잠긴다. */}
      <ComposerSendButton
        className={armed ? undefined : "is-idle"}
        aria-label={t("objectives.commodore.composer.send")}
        title={t("objectives.commodore.composer.send")}
        disabled={phone ? !usable || sending || uploading || clear.busy : !armed}
        onKeyDown={(event) => { if (isClear) clearKey.down(event); }}
        onKeyUp={clearKey.up}
        onClick={send}
      />
    </div>
    {clear.armed ? <p className="objectives-commodore-clear-confirm" role="status">{t("objectives.commodore.clear.enterConfirm")}</p> : null}
    {active ? null : <p id={`objectives-commodore-composer-idle-${theaterId}`} className="objectives-commodore-hint objectives-commodore-composer-idle">{t("objectives.commodore.composer.idle")}</p>}
    </>
  );
}

/* ── 지시 ─────────────────────────────────────────────────────────────── */

export function CommodoreDirective({ t, theaterId, directive, active, onOpenSystemPrompt, onFail, onClear }: { readonly t: T; readonly theaterId: string; readonly directive: { readonly text: string; readonly rev: number; readonly updatedAt: number }; readonly active: boolean; readonly onOpenSystemPrompt: () => void; readonly onFail: (error: unknown) => void; readonly onClear: () => void }) {
  const [draft, setDraft] = useState(() => sheetDraft(theaterId).directive ?? directive.text);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // 다른 곳(다른 창)에서 고친 지시는 입력이 깨끗할 때만 따라간다 — 쓰던 글을 덮지 않는다. 시트를 닫아도 더러운 초안은 남는다.
  const base = useRef(directive.text);
  useEffect(() => {
    if (draft === base.current) setDraft(directive.text);
    base.current = directive.text;
  }, [directive.text]); // eslint-disable-line react-hooks/exhaustive-deps -- 서버 값이 바뀔 때만.
  useEffect(() => { rememberSheetDraft(theaterId, { directive: draft === directive.text ? null : draft }); }, [theaterId, draft, directive.text]);
  const dirty = draft !== directive.text;
  const save = () => {
    if (saving || !dirty) return;
    onClear();
    setSaving(true);
    setSaved(false);
    void saveCommodoreDirective(theaterId, draft).then(() => setSaved(true)).catch(onFail).finally(() => setSaving(false));
  };
  return (
    <div className="objectives-commodore-section">
      <label className="objectives-commodore-section-title" htmlFor="objectives-commodore-directive">{t("objectives.commodore.directive.label")}</label>
      <textarea
        id="objectives-commodore-directive"
        className="objectives-commodore-input is-tall"
        value={draft}
        maxLength={8_000}
        placeholder={t("objectives.commodore.directive.placeholder")}
        onChange={(event) => { setDraft(event.target.value); setSaved(false); }}
      />
      {/* 안내 끝의 「시스템 프롬프트」는 같은 Theater Inbox 의 그 칸으로 간다 — 받는 쪽과 적용 시점이 다른 두 지침을 오가는 길. */}
      <p className="objectives-commodore-hint">{t("objectives.commodore.directive.hintBefore")}<button type="button" className="objectives-commodore-hint-link" onClick={onOpenSystemPrompt}>{t("objectives.commodore.directive.hintLink")}</button>{t("objectives.commodore.directive.hintAfter")}</p>
      <div className="objectives-commodore-section-foot">
        {directive.rev > 0 ? <span className="objectives-commodore-hint">{t("objectives.commodore.directive.rev", { rev: directive.rev, time: clockTime(directive.updatedAt) })}</span> : <span />}
        <button type="button" className="objectives-btn" disabled={saving || !dirty} onClick={save}>{t("objectives.commodore.directive.save")}</button>
      </div>
      {saved && !dirty ? <p className="objectives-commodore-hint is-done" role="status">{t(active ? "objectives.commodore.directive.saved" : "objectives.commodore.directive.savedIdle")}</p> : null}
    </div>
  );
}

/* ── 정보 ─────────────────────────────────────────────────────────────── */

/** 자리 편집 입력이 열리면 커서를 글 끝에 둔다 — 고치기는 대개 덧붙이기다. 모듈 함수라 ref 는 붙을 때 한 번만 불린다. */
export function focusAtEnd(element: HTMLTextAreaElement | null): void {
  if (!element) return;
  element.focus();
  element.setSelectionRange(element.value.length, element.value.length);
}

export function CommodoreIntel({ t, theaterId, intel, sources, onFail, onClear }: {
  readonly t: T;
  readonly theaterId: string;
  readonly intel: readonly { readonly id: string; readonly at: number; readonly source: string; readonly text: string; readonly editedAt?: number | undefined }[];
  readonly sources: readonly { readonly id: string; readonly kind: string; readonly label: string; readonly locator: string }[];
  readonly onFail: (error: unknown) => void;
  readonly onClear: () => void;
}) {
  const editing = useCommodoreIntelEdits(theaterId, intel, { onClear });
  const [draft, setDraft] = useState(() => sheetDraft(theaterId).intel);
  useEffect(() => { rememberSheetDraft(theaterId, { intel: draft }); }, [theaterId, draft]);
  const [adding, setAdding] = useState(false);
  const sourceLabel = (source: string) => source === "person" ? t("objectives.commodore.intel.fromYou") : sources.find((candidate) => candidate.id === source)?.label ?? source;
  const add = () => {
    const value = draft.trim();
    if (!value || adding) return;
    onClear();
    setAdding(true);
    void addCommodoreIntel(theaterId, value).then(() => setDraft("")).catch(onFail).finally(() => setAdding(false));
  };
  const day = (at: number) => { const date = new Date(at); return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  return (
    <>
      <div className="objectives-commodore-section">
        <label className="objectives-commodore-section-title" htmlFor="objectives-commodore-intel">{t("objectives.commodore.intel.label")}</label>
        <textarea
          id="objectives-commodore-intel"
          className="objectives-commodore-input is-medium"
          value={draft}
          maxLength={4_000}
          placeholder={t("objectives.commodore.intel.placeholder")}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="objectives-commodore-section-foot">
          <span />
          <button type="button" className="objectives-btn" disabled={adding || !draft.trim()} onClick={add}>{t("objectives.commodore.intel.add")}</button>
        </div>
        {intel.length === 0 ? <p className="objectives-commodore-hint">{t("objectives.commodore.intel.empty")}</p> : (
          <ul ref={editing.listRef} className="objectives-commodore-intel-list">
            {intel.map((item) => {
              const edit = editing.edits[item.id];
              // 출처와 「수정됨」은 한 덩어리로 줄을 넘긴다 — 사이 공백은 끊기지 않는 공백이다.
              const meta = <span className="objectives-commodore-intel-source">{sourceLabel(item.source)}{item.editedAt !== undefined ? <span title={t("objectives.commodore.intel.editedAt", { time: `${day(item.editedAt)} ${clockTime(item.editedAt)}` })}>{"\u00a0·\u00a0"}{t("objectives.commodore.intel.edited")}</span> : null}</span>;
              if (edit) {
                const unchanged = edit.draft.trim() === item.text;
                return (
                  <li key={item.id} className="is-editing">
                    <span className="objectives-commodore-intel-when">{day(item.at)}</span>
                    <div className="objectives-commodore-intel-edit">
                      <textarea
                        ref={focusAtEnd}
                        className="objectives-commodore-input objectives-commodore-intel-field"
                        value={edit.draft}
                        maxLength={4_000}
                        readOnly={edit.saving}
                        aria-label={t("objectives.commodore.intel.editField")}
                        onChange={(event) => editing.change(item.id, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!edit.saving) editing.cancel(item.id); return; }
                          // Enter 는 저장, Shift+Enter 는 줄바꿈 — 사령관 메시지 입력과 같은 손버릇이다.
                          if (event.key === "Enter" && !event.shiftKey && !event.altKey) { event.preventDefault(); editing.save(item.id); }
                        }}
                      />
                      {edit.error ? <p className="objectives-commodore-intel-error" role="alert">{t("objectives.commodore.failed", { code: errorWord(t, edit.error) })}</p> : null}
                      <div className="objectives-commodore-intel-edit-foot">
                        {meta}
                        <span className="objectives-commodore-hint">{t("objectives.commodore.intel.editHint")}</span>
                        <button type="button" className="objectives-commodore-text-button" disabled={edit.saving} onClick={() => editing.cancel(item.id)}>{t("objectives.commodore.intel.cancel")}</button>
                        <button type="button" className="objectives-btn" disabled={edit.saving || !edit.draft.trim() || unchanged} onClick={() => editing.save(item.id)}>{t(edit.saving ? "objectives.commodore.intel.saving" : "objectives.commodore.intel.save")}</button>
                      </div>
                    </div>
                  </li>
                );
              }
              return (
                <li key={item.id}>
                  <span className="objectives-commodore-intel-when">{day(item.at)}</span>
                  {/* 본문을 누르면 그 자리에서 고친다 — 글을 끌어 고른 뒤의 클릭은 복사하려는 것이라 열지 않는다. */}
                  <span className="objectives-commodore-intel-text is-editable" onClick={() => { if (!window.getSelection()?.toString()) editing.open(item.id); }}>{item.text}{meta}</span>
                  <span className="objectives-commodore-intel-actions">
                    <button type="button" className="objectives-commodore-text-button" {...{ [INTEL_EDIT_ATTRIBUTE]: item.id }} aria-label={t("objectives.commodore.intel.editAria")} onClick={() => editing.open(item.id)}>{t("objectives.commodore.intel.edit")}</button>
                    <button type="button" className="objectives-commodore-text-button" aria-label={t("objectives.commodore.intel.removeAria")} onClick={() => { onClear(); void removeCommodoreIntel(theaterId, item.id).catch(onFail); }}>{t("objectives.commodore.intel.remove")}</button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="objectives-commodore-section">
        <p className="objectives-commodore-section-title">{t("objectives.commodore.intel.sources")} <span className="objectives-commodore-later">· {t("objectives.commodore.intel.sourcesLater")}</span></p>
        {sources.length === 0 ? <p className="objectives-commodore-hint">{t("objectives.commodore.intel.sourcesEmpty")}</p> : (
          <ul className="objectives-commodore-sources">
            {sources.map((source) => <li key={source.id}><span>{source.label}</span><span className="objectives-commodore-source-locator">{source.locator}</span></li>)}
          </ul>
        )}
        <p className="objectives-commodore-hint">{t("objectives.commodore.intel.sourcesHint")}</p>
      </div>
    </>
  );
}
