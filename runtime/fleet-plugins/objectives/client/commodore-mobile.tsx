import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ComposerInput } from "@fleet-console/sdk/composer";
import type { Translate } from "@fleet-console/sdk/i18n";
import type { PaneContext } from "@fleet-console/sdk/pane";
import type { RailEntryDestinationTrailing, RailEntryDestinationTrailingValue } from "@fleet-console/sdk/rail";
import { useMobileSettingsHost } from "@fleet-console/sdk/react/browser";
import { SettingsCard, SettingsRow } from "@fleet-console/sdk/settings/browser";

import type { CommodoreLiveEvent, CommodorePatrolMinutes, CommodoreTranscriptEntry } from "../server/commodore/types.js";
import { commodoreChatEntries, errorWord } from "./commodore-chat.js";
import { CommodoreTrail } from "./commodore-trail.js";
import { commanderCoordinates, commanderValue, CommodoreCoordinateField, commodoreCoordinates, commodoreValue, DEFAULT_PATROL, PATROL_STEPS, patrolWord } from "./commodore-drawer.js";
import { clockTime, commodoreSummary } from "./commodore-row.js";
import {
  addCommodoreIntel,
  commodoreLanguage,
  commodoreTranscriptRenderer,
  loadCommodore,
  loadTranscript,
  messageCommodore,
  noteCommodoreLanguage,
  readCommodore,
  removeCommodoreIntel,
  retryCommodore,
  saveCommodoreDirective,
  setCommodoreAutonomy,
  setCommodoreCommander,
  setCommodoreCoordinates,
  setCommodoreMobileTab,
  setCommodorePatrol,
  subscribeCommodore,
  useCommodore,
  useCommodoreEnabled,
  useCommodoreExperimentKnown,
  useCommodoreMobileTab,
  useCommodoreOnline,
  useCommodoreTheaterLabel,
  type CommodoreMobileTab,
} from "./commodore-state.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { DEFAULT_LAUNCH } from "./launch-control.js";
import { useObjectiveTheater } from "./objectives-state.js";
import "./commodore-mobile.css";

/**
 * 모바일 드로어 목적지 「사령관」(impl-spec S-53·S-54) — 데스크톱의 사이드바 줄 + 「사령관 기록」 시트를 폰 화면 한 장으로.
 * 호스트가 페인 컨텍스트에 `mobileBar`를 실을 때만 선다. 데스크톱 시트와 같은 스토어·같은 API다 — 자율 운영·메시지·지시·정보·
 * 모델·순찰·지휘관 모델·재시도 모두 같은 경로를 탄다. 대상은 지금 Theater 의 사령관이다.
 */

type T = Translate<ObjectiveMessageKey>;
type CommodoreView = NonNullable<ReturnType<typeof useCommodore>["view"]>;

export const COMMODORE_MOBILE_PANE = "commodore-mobile";

/** 시안 아이콘 문법 — 24 viewBox, 선 1.7, 둥근 끝. 경로는 impl-spec §A. */
const Icon = ({ children, size = 22, strokeWidth = 1.7 }: { readonly children: ReactNode; readonly size?: number; readonly strokeWidth?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
/** [pennant] 사령관 깃발(제비꼬리 장기). */
export const PennantIcon = ({ size }: { readonly size?: number }) => <Icon size={size ?? 22}><path d="M5.5 21V3.5" /><path d="M5.5 4.5h13l-3.6 4.25 3.6 4.25h-13" /></Icon>;
const SparkIcon = () => <Icon><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" /></Icon>;
const ClockIcon = () => <Icon><circle cx="12" cy="13" r="7.5" /><path d="M12 9.5V13l2.6 1.7M9.5 2.8h5" /></Icon>;
const TargetIcon = () => <Icon><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r=".8" fill="currentColor" /></Icon>;
const ChartIcon = () => <Icon><path d="M4 4v16h16" /><path d="M8 15l3-4 3 2 5-6" /></Icon>;
const SendIcon = () => <Icon size={20} strokeWidth={2.2}><path d="M12 19V5M6 11l6-6 6 6" /></Icon>;

type Glyph = "idle" | "running" | "background";
const StatusMark = ({ state }: { readonly state: Glyph }) => <span className={`objectives-m-sg is-${state}`} aria-hidden="true" />;

function failWord(t: T, error: unknown): string {
  const code = error instanceof Error ? error.message : "failed";
  return code === "commodore_disabled" ? t("objectives.commodore.failed.disabled") : code === "commodore_inactive" ? t("objectives.commodore.failed.inactive") : t("objectives.commodore.failed", { code });
}

/* ── 드로어 줄 오른쪽 상태(S-53 CM-1c) ─────────────────────────────── */

/**
 * 드로어 「사령관」 줄 오른쪽 칸 — 자율 운영 루프의 상태만 보인다(건수 없음). 상태를 읽기 전이면 칸을 비운다.
 * 호스트는 값(glyph·text·tone)으로 비교하므로 같은 상태면 같은 결과면 된다.
 */
export const commodoreDestinationTrailing: RailEntryDestinationTrailing = {
  subscribe: (listener) => subscribeCommodore(listener),
  get: (theaterId): RailEntryDestinationTrailingValue | null => {
    if (!theaterId) return null;
    const view = readCommodore(theaterId).view;
    if (!view) return null;
    const t = getT(commodoreLanguage());
    if (view.state.autonomy !== true) return { text: t("objectives.commodore.mobile.off"), tone: "faint" };
    const run = view.run;
    if (run.phase === "turn") return { glyph: "running", text: t("objectives.commodore.meta.turn") };
    if (run.phase === "retrying" && run.nextWakeAt) return { glyph: "background", text: t("objectives.commodore.meta.retrying", { time: clockTime(run.nextWakeAt) }) };
    if (run.phase === "error") return { text: t("objectives.commodore.meta.error"), tone: "danger" };
    return { glyph: "idle", text: t("objectives.commodore.mobile.on") };
  },
};

/* ── 화면 ─────────────────────────────────────────────────────────────── */

export function MobileCommodore({ ctx }: { readonly ctx: PaneContext }) {
  const t = getT(ctx.language);
  const enabled = useCommodoreEnabled();
  const known = useCommodoreExperimentKnown();
  const theaterId = ctx.theaterId ?? "";
  const { mobileBar, visible } = ctx;
  if (ctx.language) noteCommodoreLanguage(ctx.language);
  const title = t("objectives.commodore.name");
  const theaterLabel = useCommodoreTheaterLabel(theaterId);

  // 목적지 화면이라 막대 왼쪽은 ☰, 보조 줄은 지금 Theater 이름. ⋮ 은 없다 — 시트의 모든 기능이 탭과 띠에 있다.
  useEffect(() => {
    if (visible) mobileBar?.set({ title, ...(theaterLabel ? { subtitle: theaterLabel } : {}), depth: 0 });
  }, [mobileBar, visible, title, theaterLabel]);

  if (known && !enabled) return <CommodoreDisabled t={t} />;
  if (!theaterId) return <div className="objectives-cm" />;
  return <CommodoreScreen key={theaterId} t={t} theaterId={theaterId} enabled={enabled} />;
}

/** 실험 기능이 꺼진 채 들어온 화면 — 보던 중 꺼지면 호스트가 홈으로 돌려보내므로, 옛 주소로 들어온 순간에만 잠깐 선다. */
function CommodoreDisabled({ t }: { readonly t: T }) {
  return (
    <div className="objectives-cm">
      <div className="objectives-cm-center">
        <p className="objectives-cm-center-text">{t("objectives.commodore.failed.disabled")}</p>
        <a data-press="r3" className="objectives-cm-pill" href="settings?section=experiments">{t("objectives.commodore.mobile.openExperiments")}</a>
      </div>
    </div>
  );
}

function CommodoreScreen({ t, theaterId, enabled }: { readonly t: T; readonly theaterId: string; readonly enabled: boolean }) {
  const { view, entries, live, hasMore, transcriptLoaded } = useCommodore(theaterId);
  const tab = useCommodoreMobileTab();
  const online = useCommodoreOnline();
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    void loadCommodore(theaterId);
    if (!readCommodore(theaterId).transcriptLoaded) void loadTranscript(theaterId);
  }, [theaterId, enabled]);
  useEffect(() => { setFailure(null); }, [tab]);

  const fail = useCallback((error: unknown) => setFailure(failWord(t, error)), [t]);
  const clear = useCallback(() => setFailure(null), []);
  const on = view?.state.autonomy === true;
  const run = view?.run;
  const tabs: readonly { readonly id: CommodoreMobileTab; readonly label: string }[] = [
    { id: "log", label: t("objectives.commodore.tabs.log") },
    { id: "goals", label: t("objectives.commodore.trail.title") },
    { id: "directive", label: t("objectives.commodore.tabs.directive") },
    { id: "intel", label: t("objectives.commodore.tabs.intel") },
    { id: "settings", label: t("objectives.commodore.tabs.settings") },
  ];

  return (
    <div className="objectives-cm">
      {on && (run?.phase === "retrying" || run?.phase === "error") ? (
        <div className="objectives-cm-band">
          {run.phase === "retrying" ? (
            <span className="objectives-cm-band-text"><StatusMark state="background" />{[run.reason ? errorWord(t, run.reason) : null, run.nextWakeAt ? t("objectives.commodore.drawer.retryAt", { time: clockTime(run.nextWakeAt) }) : null].filter(Boolean).join(" · ")}</span>
          ) : (
            <span className="objectives-cm-band-text is-danger">{[t("objectives.commodore.meta.error"), run.reason ? errorWord(t, run.reason) : null].filter(Boolean).join(" · ")}</span>
          )}
          <button type="button" data-press="r1" className="objectives-cm-band-act" disabled={!online} onClick={() => { clear(); void retryCommodore(theaterId).catch(fail); }}>{t("objectives.commodore.drawer.retryNow")}</button>
        </div>
      ) : null}
      <AutonomyRow t={t} theaterId={theaterId} view={view} online={online} onFail={fail} onClear={clear} />
      <div className="objectives-cm-tabs" role="tablist" aria-label={t("objectives.commodore.tabs.aria")}>
        {tabs.map((item) => (
          <button key={item.id} type="button" role="tab" data-press="r1" aria-selected={tab === item.id} className={tab === item.id ? "is-on" : undefined} onClick={() => setCommodoreMobileTab(item.id)}>{item.label}</button>
        ))}
      </div>
      {tab === "log" ? <CommodoreMobileLog t={t} language={commodoreLanguage() ?? "en"} theaterId={theaterId} view={view} entries={entries} live={live} hasMore={hasMore} loaded={transcriptLoaded} online={online} failure={failure} onFail={fail} onClear={clear} /> : null}
      {tab === "goals" ? <div className="objectives-cm-fill objectives-cm-goals"><CommodoreTrail t={t} theaterId={theaterId} /></div> : null}
      {tab === "directive" && view ? <CommodoreMobileDirective t={t} theaterId={theaterId} view={view} online={online} failure={failure} onFail={fail} onClear={clear} /> : null}
      {tab === "intel" && view ? <CommodoreMobileIntel t={t} theaterId={theaterId} view={view} online={online} failure={failure} onFail={fail} onClear={clear} /> : null}
      {tab === "settings" && view ? <CommodoreMobileSettings t={t} theaterId={theaterId} view={view} online={online} failure={failure} onFail={fail} onClear={clear} /> : null}
    </div>
  );
}

/* ── 자율 운영 행(CM-2a-3) ─────────────────────────────────────────────── */

function AutonomyRow({ t, theaterId, view, online, onFail, onClear }: { readonly t: T; readonly theaterId: string; readonly view: CommodoreView | null; readonly online: boolean; readonly onFail: (error: unknown) => void; readonly onClear: () => void }) {
  const board = useObjectiveTheater(theaterId);
  const [busy, setBusy] = useState(false);
  const on = view?.state.autonomy === true;
  const run = view?.run;
  const { meta } = commodoreSummary(t, view, board.objectives);
  const parts = meta.filter((part) => part.key === "running" || part.key === "handled").map((part) => part.text).join(" · ");
  let status: ReactNode = null;
  if (busy) status = t("objectives.commodore.mobile.switching");
  else if (view && !on) status = meta.map((part) => part.text).join(" · ");
  else if (view && run?.phase === "turn") status = <><StatusMark state="running" />{t("objectives.commodore.meta.turn")} · {parts}</>;
  else if (view && run?.phase === "retrying" && run.nextWakeAt) status = <><StatusMark state="background" />{t("objectives.commodore.meta.retrying", { time: clockTime(run.nextWakeAt) })} · {parts}</>;
  else if (view && run?.phase === "error") status = <><span className="is-danger">{t("objectives.commodore.meta.error")}</span> · {parts}</>;
  else if (view) status = <><StatusMark state="idle" />{[run?.nextWakeAt ? t("objectives.commodore.drawer.nextPatrol", { time: clockTime(run.nextWakeAt) }) : null, parts].filter(Boolean).join(" · ")}</>;
  const toggle = () => {
    // 바꾸는 동안의 두 번째 누름은 버린다 — 서버 결과가 진실이다.
    if (busy || !view || !online) return;
    onClear();
    setBusy(true);
    void setCommodoreAutonomy(theaterId, !on).catch(onFail).finally(() => setBusy(false));
  };
  return (
    <div className="objectives-cm-top">
      <button
        type="button"
        role="switch"
        data-press="r2"
        className="objectives-cm-trow"
        aria-checked={on}
        aria-busy={busy || undefined}
        aria-label={t("objectives.commodore.settings.autonomy")}
        disabled={!view || !online}
        onClick={toggle}
      >
        <span className="objectives-cm-trow-ic"><PennantIcon /></span>
        <span className="objectives-cm-trow-tx">
          <b>{t("objectives.commodore.settings.autonomy")}</b>
          {status !== null ? <span className="objectives-cm-trow-ds">{status}</span> : null}
        </span>
        <span className={`objectives-cm-tog${on ? " is-on" : ""}${busy ? " is-busy" : ""}`} aria-hidden="true" />
      </button>
    </div>
  );
}

/* ── 기록 탭(CM-2b) ───────────────────────────────────────────────────── */

interface Pending { readonly key: number; readonly text: string; readonly at: number }

function CommodoreMobileLog({ t, language, theaterId, view, entries, live, hasMore, loaded, online, failure, onFail, onClear }: {
  readonly t: T;
  readonly language: "en" | "ko";
  readonly theaterId: string;
  readonly view: CommodoreView | null;
  readonly entries: readonly CommodoreTranscriptEntry[];
  readonly live: readonly CommodoreLiveEvent[];
  readonly hasMore: boolean;
  readonly loaded: boolean;
  readonly online: boolean;
  readonly failure: string | null;
  readonly onFail: (error: unknown) => void;
  readonly onClear: () => void;
}) {
  // 데스크톱 시트와 같은 채팅 턴 렌더러 — 오래된 것 위, 새 것 아래(입력창 바로 위가 최신).
  const Transcript = commodoreTranscriptRenderer();
  const chat = useMemo(() => commodoreChatEntries(t, entries, live), [t, entries, live]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const olderAnchor = useRef<number | null>(null);
  const on = view?.state.autonomy === true;
  const run = view?.run;
  const turn = on && run?.phase === "turn";

  // 열면 맨 아래. 그 뒤로는 바닥에 붙어 있을 때만 새 줄을 따라간다. 이전 기록을 붙이면 보던 자리를 지킨다.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (olderAnchor.current !== null) { node.scrollTop = node.scrollHeight - olderAnchor.current; olderAnchor.current = null; return; }
    if (pinned.current) node.scrollTop = node.scrollHeight;
  }, [chat, pending, turn, loaded]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (node) pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };
  const older = () => {
    const node = scrollRef.current;
    olderAnchor.current = node ? node.scrollHeight - node.scrollTop : null;
    setLoadingOlder(true);
    void loadTranscript(theaterId, { older: true }).finally(() => setLoadingOlder(false));
  };

  let body: ReactNode;
  if (!loaded) {
    body = <div className="objectives-cm-center"><p className="objectives-cm-center-text is-row"><StatusMark state="running" />{t("objectives.commodore.mobile.loading")}</p></div>;
  } else if (chat.length === 0 && !turn && !pending) {
    body = (
      <div className="objectives-cm-center">
        <span className="objectives-cm-bigmono"><PennantIcon /></span>
        <p className="objectives-cm-center-text">{t("objectives.commodore.log.empty")}</p>
      </div>
    );
  } else {
    body = (
      <>
        {hasMore ? <button type="button" data-press="r1" className="objectives-cm-tbtn is-center" disabled={loadingOlder} onClick={older}>{t("objectives.commodore.log.older")}</button> : null}
        {Transcript ? <Transcript entries={chat} language={language} mobile /> : null}
        {pending ? (
          <div className="objectives-cm-msg">
            <p className="objectives-cm-head"><b>{t("objectives.commodore.log.you")}</b><span className="objectives-cm-time">{clockTime(pending.at)}</span><span>{t("objectives.commodore.mobile.sending")}</span></p>
            <p className="objectives-cm-bubble">{pending.text}</p>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="objectives-cm-fill">
      <div ref={scrollRef} className={`objectives-cm-chat${loaded && (chat.length > 0 || turn || pending) ? "" : " is-center"}`} onScroll={onScroll}>{body}</div>
      <CommodoreMobileComposer t={t} theaterId={theaterId} active={view ? view.active : false} online={online} failure={failure} onFail={onFail} onClear={onClear} onPending={setPending} />
    </div>
  );
}

/** 터치 기기의 화면 키보드에서는 Enter 가 줄바꿈이다 — 보내기는 원으로 한다. 하드웨어 키보드(정밀 포인터)는 채팅 입력창처럼 Enter 로 보낸다. */
const touchFirst = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

function CommodoreMobileComposer({ t, theaterId, active, online, failure, onFail, onClear, onPending }: {
  readonly t: T;
  readonly theaterId: string;
  readonly active: boolean;
  readonly online: boolean;
  readonly failure: string | null;
  readonly onFail: (error: unknown) => void;
  readonly onClear: () => void;
  readonly onPending: (pending: Pending | null) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const usable = active && online;
  const send = () => {
    const value = text.trim();
    // 빈 입력에서 원을 누르면 입력칸에 포커스만 간다(FD-19).
    if (!value) { inputRef.current?.focus(); return; }
    if (!usable || sending) return;
    onClear();
    setSending(true);
    onPending({ key: Date.now(), text: value, at: Date.now() });
    // 실패하면 초안은 남는다 — 입력창 위 알림 줄이 이유를 말한다.
    void messageCommodore(theaterId, value).then(() => setText("")).catch(onFail).finally(() => { setSending(false); onPending(null); });
  };
  return (
    <div className="objectives-cm-dock">
      {failure ? <p className="objectives-cm-note objectives-cm-dock-note" role="alert">{failure}</p> : null}
      <div className={`objectives-cm-comp${usable ? "" : " is-off"}`} onClick={(event) => { if (event.target === event.currentTarget) inputRef.current?.focus(); }}>
        <ComposerInput
          ref={inputRef}
          className="objectives-cm-comp-input"
          value={text}
          disabled={!usable}
          rows={1}
          placeholder={t("objectives.commodore.composer.placeholder")}
          aria-label={t("objectives.commodore.composer.aria")}
          aria-describedby={active ? undefined : `objectives-cm-idle-${theaterId}`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !touchFirst()) { event.preventDefault(); send(); } }}
        />
        <div className="objectives-cm-comp-bar">
          <button type="button" data-press="r3" className="objectives-cm-circ" aria-label={t("objectives.commodore.composer.send")} disabled={!usable || sending} onClick={send}><SendIcon /></button>
        </div>
      </div>
      {active ? null : <p id={`objectives-cm-idle-${theaterId}`} className="objectives-cm-secnote is-dock">{t("objectives.commodore.composer.idle")}</p>}
    </div>
  );
}

/* ── 지시 탭(CM-2c) ───────────────────────────────────────────────────── */

interface TabProps {
  readonly t: T;
  readonly theaterId: string;
  readonly view: CommodoreView;
  readonly online: boolean;
  readonly failure: string | null;
  readonly onFail: (error: unknown) => void;
  readonly onClear: () => void;
}

function CommodoreMobileDirective({ t, theaterId, view, online, failure, onFail, onClear }: TabProps) {
  const directive = view.state.directive;
  const [draft, setDraft] = useState(directive.text);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // 다른 곳에서 고친 지시는 입력이 깨끗할 때만 따라간다 — 쓰던 글을 덮지 않는다(데스크톱과 같다).
  const base = useRef(directive.text);
  useEffect(() => {
    if (draft === base.current) setDraft(directive.text);
    base.current = directive.text;
  }, [directive.text]); // eslint-disable-line react-hooks/exhaustive-deps -- 서버 값이 바뀔 때만.
  const dirty = draft !== directive.text;
  const save = () => {
    if (saving || !dirty || !online) return;
    onClear();
    setSaving(true);
    setSaved(false);
    void saveCommodoreDirective(theaterId, draft).then(() => setSaved(true)).catch(onFail).finally(() => setSaving(false));
  };
  return (
    <div className="objectives-cm-content">
      <div className="objectives-cm-pad">
        <label className="objectives-cm-glab" htmlFor="objectives-cm-directive">{t("objectives.commodore.directive.label")}</label>
        <textarea id="objectives-cm-directive" className="objectives-cm-field is-tall" value={draft} maxLength={8_000} placeholder={t("objectives.commodore.directive.placeholder")} onChange={(event) => { setDraft(event.target.value); setSaved(false); }} />
        <p className="objectives-cm-secnote">{t("objectives.commodore.directive.hint")}</p>
        {failure ? <p className="objectives-cm-note" role="alert">{failure}</p> : null}
        <div className="objectives-cm-crow">
          <span className="objectives-cm-secnote is-grow">{directive.rev > 0 ? t("objectives.commodore.directive.rev", { rev: directive.rev, time: clockTime(directive.updatedAt) }) : ""}</span>
          <button type="button" data-press="r3" className="objectives-cm-pill is-inverse" disabled={saving || !dirty || !online} onClick={save}>{t("objectives.commodore.directive.save")}</button>
        </div>
        {saved && !dirty ? <p className="objectives-cm-secnote is-done" role="status">{t(view.active ? "objectives.commodore.directive.saved" : "objectives.commodore.directive.savedIdle")}</p> : null}
      </div>
    </div>
  );
}

/* ── 정보 탭(CM-2d) ───────────────────────────────────────────────────── */

function CommodoreMobileIntel({ t, theaterId, view, online, failure, onFail, onClear }: TabProps) {
  const { intel, sources } = view.state;
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const sourceLabel = (source: string) => source === "person" ? t("objectives.commodore.intel.fromYou") : sources.find((candidate) => candidate.id === source)?.label ?? source;
  const day = (at: number) => { const date = new Date(at); return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  const add = () => {
    const value = draft.trim();
    if (!value || adding || !online) return;
    onClear();
    setAdding(true);
    void addCommodoreIntel(theaterId, value).then(() => setDraft("")).catch(onFail).finally(() => setAdding(false));
  };
  return (
    <div className="objectives-cm-content">
      <div className="objectives-cm-pad">
        <label className="objectives-cm-glab" htmlFor="objectives-cm-intel">{t("objectives.commodore.intel.label")}</label>
        <textarea id="objectives-cm-intel" className="objectives-cm-field is-medium" value={draft} maxLength={4_000} placeholder={t("objectives.commodore.intel.placeholder")} onChange={(event) => setDraft(event.target.value)} />
        {failure ? <p className="objectives-cm-note" role="alert">{failure}</p> : null}
        <div className="objectives-cm-crow">
          <span className="is-grow" />
          <button type="button" data-press="r3" className="objectives-cm-pill is-inverse" disabled={adding || !draft.trim() || !online} onClick={add}>{t("objectives.commodore.intel.add")}</button>
        </div>
        {intel.length === 0 ? <p className="objectives-cm-secnote">{t("objectives.commodore.intel.empty")}</p> : (
          <div className="objectives-cm-grp">
            {intel.map((item) => (
              <div key={item.id} className="objectives-cm-gr">
                <span className="objectives-cm-gr-tx">{item.text}<small>{day(item.at)} · {sourceLabel(item.source)}</small></span>
                <button type="button" data-press="r1" className="objectives-cm-tbtn" aria-label={t("objectives.commodore.intel.removeAria")} disabled={!online} onClick={() => { onClear(); void removeCommodoreIntel(theaterId, item.id).catch(onFail); }}>{t("objectives.commodore.intel.remove")}</button>
              </div>
            ))}
          </div>
        )}
        <p className="objectives-cm-glab">{t("objectives.commodore.intel.sources")} <span className="is-light">· {t("objectives.commodore.intel.sourcesLater")}</span></p>
        {sources.length > 0 ? (
          <div className="objectives-cm-grp">
            {sources.map((source) => <div key={source.id} className="objectives-cm-gr"><span className="objectives-cm-gr-tx">{source.label}<small className="is-mono">{source.locator}</small></span></div>)}
          </div>
        ) : null}
        <p className="objectives-cm-secnote">{sources.length === 0 ? `${t("objectives.commodore.intel.sourcesEmpty")} ` : ""}{t("objectives.commodore.intel.sourcesHint")}</p>
      </div>
    </div>
  );
}

/* ── 설정 탭(CM-2e) ───────────────────────────────────────────────────── */

function CommodoreMobileSettings({ t, theaterId, view, online, failure, onFail, onClear }: TabProps) {
  const { state, defaults, run } = view;
  const act = (work: () => Promise<void>) => { onClear(); void work().catch(onFail); };
  const host = useMobileSettingsHost();
  const defaultWord = t("objectives.commodore.patrol.default");
  // 좌표 두 칸은 데스크톱 서랍과 같은 공유 선택기 — 폰 설정 화면 안이라 호스트의 좌표 시트로 열린다. 비우면 기본값이다.
  const modelOverridden = state.model !== undefined;
  const commanderOverridden = state.commanderModel !== undefined;

  const patrol = state.patrolMinutes ?? DEFAULT_PATROL;
  const usage = [t("objectives.commodore.drawer.session", { n: run.totals.session }), t("objectives.commodore.drawer.cost", { cost: run.totals.costUsd.toFixed(2) })].join(" · ");

  return (
    <div className="objectives-cm-content">
      <div className="objectives-cm-pad objectives-cm-settings">
        {failure ? <p className="objectives-cm-note" role="alert">{failure}</p> : null}
        <SettingsCard description={t("objectives.commodore.settings.modelHint")}>
          <SettingsRow label={t("objectives.commodore.settings.model")} icon={<SparkIcon />} disabled={!online}>
            <CommodoreCoordinateField
              t={t}
              target="agent"
              label={t("objectives.commodore.drawer.modelAria")}
              value={commodoreValue(state)}
              fallback={defaults}
              disabled={!online}
              {...(modelOverridden ? { reset: { label: t("objectives.commodore.settings.useDefault"), onSelect: () => act(() => setCommodoreCoordinates(theaterId, null)) } } : {})}
              onChange={(next) => act(() => setCommodoreCoordinates(theaterId, commodoreCoordinates(state, defaults, next)))}
            />
          </SettingsRow>
        </SettingsCard>
        <SettingsCard description={t("objectives.commodore.settings.patrolHint")}>
          <SettingsRow label={t("objectives.commodore.settings.patrol")} icon={<ClockIcon />} disabled={!online}>
            <button
              type="button"
              className="fc-select__trigger fc-select--mobile"
              aria-haspopup="dialog"
              disabled={!online || !host}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                host?.openChoice({
                  title: t("objectives.commodore.settings.patrol"),
                  value: String(patrol),
                  options: PATROL_STEPS.map((step) => ({ value: String(step), label: patrolWord(t, step), ...(step === DEFAULT_PATROL ? { description: defaultWord } : {}) })),
                  anchor: { top: rect.top, bottom: rect.bottom },
                  // 1시간을 고르면 기본값으로 저장한다(현행 null).
                  onSelect: (value) => { const minutes = Number(value) as CommodorePatrolMinutes; if (minutes !== patrol) act(() => setCommodorePatrol(theaterId, minutes === DEFAULT_PATROL ? null : minutes)); },
                });
              }}
            >
              <span className="fc-select__value">{patrolWord(t, patrol)}</span>
            </button>
          </SettingsRow>
        </SettingsCard>
        <SettingsCard description={t("objectives.commodore.settings.commanderHint")}>
          <SettingsRow label={t("objectives.commodore.settings.commander")} icon={<TargetIcon />} disabled={!online}>
            <CommodoreCoordinateField
              t={t}
              target="launch"
              label={t("objectives.commodore.settings.commanderAria")}
              value={commanderValue(state)}
              fallback={DEFAULT_LAUNCH}
              disabled={!online}
              {...(commanderOverridden ? { reset: { label: t("objectives.commodore.settings.useDefault"), onSelect: () => act(() => setCommodoreCommander(theaterId, null)) } } : {})}
              onChange={(next) => act(() => setCommodoreCommander(theaterId, commanderCoordinates(state, next)))}
            />
          </SettingsRow>
        </SettingsCard>
        <SettingsCard>
          {/* 정보 행 — 누름 없음. 값 줄은 다른 행의 값과 같은 자리·같은 글자다(비활성 단추가 아니다). */}
          <SettingsRow label={t("objectives.commodore.mobile.usage")} icon={<ChartIcon />}>
            <span className="fc-select__trigger fc-select--mobile objectives-cm-info-value"><span className="fc-select__value">{usage}</span></span>
          </SettingsRow>
        </SettingsCard>
      </div>
    </div>
  );
}
