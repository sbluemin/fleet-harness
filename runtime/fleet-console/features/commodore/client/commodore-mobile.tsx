import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { AgentConversationEntry, AgentConversationProps } from "@fleet-console/sdk/components/agent-chat-transcript";
import type { ConversationParticipant, ConversationSpeaker } from "@fleet-console/sdk/conversation";
import type { Translate } from "@fleet-console/sdk/i18n";
import type { ClientMobileBarCapability, PaneContext } from "@fleet-console/sdk/pane";
import type { RailEntryDestinationTrailing, RailEntryDestinationTrailingValue } from "@fleet-console/sdk/rail";
import { chromeRowHeight, useChromeHeightProperty, useMobileSettingsHost } from "@fleet-console/sdk/react/browser";
import { SettingsCard, SettingsRow } from "@fleet-console/sdk/settings/browser";

import type { CommodoreLiveEvent, CommodorePatrolMinutes, CommodoreTranscriptEntry } from "@fleet-console/sdk/commodore";
import { commodoreChatEntries, commodoreConversationEntries, commodoreConversationLiveEntries, errorWord } from "./commodore-chat.js";
import { CommodoreAskCards, ENDED_ASK_CODES } from "./commodore-ask.js";
import { CommodoreTrail } from "./commodore-trail.js";
import { commanderCoordinates, commanderValue, CommodoreCoordinateField, commodoreCoordinates, commodoreValue, DEFAULT_PATROL, PATROL_STEPS, patrolWord } from "./commodore-controls.js";
import { CommodoreAvatar } from "./commodore-avatar.js";
import { CommodoreMobileMemory } from "./commodore-mobile-memory.js";
import { useCommodoreObjectiveIndex, useCommodoreReferenceHost } from "./commodore-reference-input.js";
import { clockTime, commodoreMongleState, commodoreSummary } from "./commodore-header.js";
import { CommodoreComposer, focusAtEnd, useCommodoreIntelAdd, type CommodorePendingMessage } from "./commodore-inbox-section.js";
import {
  commodoreComposerTopEntriesRenderer,
  commodoreConversationRenderer,
  commodoreLanguage,
  commodoreTranscriptRenderer,
  loadCommodore,
  loadTranscript,
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
  INTEL_EDIT_ATTRIBUTE,
  useCommodoreIntelEdits,
  useCommodoreMobileTab,
  useCommodoreMobilePanelRequest,
  useCommodoreOnline,
  useCommodoreTheaterLabel,
  type CommodoreMobileTab,
} from "./commodore-state.js";
import { getT, type CommodoreMessageKey } from "./i18n/index.js";
import { DEFAULT_LAUNCH } from "./defaults.js";
import { openObjectiveOnPhone, useObjectiveTheater } from "./board.js";
import "./commodore-mobile.css";

/**
 * 모바일 바로가기 목적지 「사령관」(impl-spec S-53·S-54) — 데스크톱의 사이드바 줄 + 「사령관 기록」 시트를 폰 화면 한 장으로.
 * 호스트가 페인 컨텍스트에 `mobileBar`를 실을 때만 선다. 데스크톱 시트와 같은 스토어·같은 API다 — 자율 운영·메시지·지시(정보 포함)·
 * 모델·순찰·지휘관 모델·재시도 모두 같은 경로를 탄다. 대상은 지금 Theater 의 사령관이다.
 */

type T = Translate<CommodoreMessageKey>;
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

function failWord(t: T, error: unknown): string {
  const code = error instanceof Error ? error.message : "failed";
  if (ENDED_ASK_CODES.has(code)) return errorWord(t, code);
  return code === "commodore_disabled" ? t("commodore.failed.disabled") : code === "commodore_inactive" ? t("commodore.failed.inactive") : t("commodore.failed", { code });
}

/* ── 칩 오른쪽 상태(S-53 CM-1c) ─────────────────────────────── */

/**
 * 바로가기 「사령관」 칩 오른쪽 칸 — 자율 운영 루프의 상태만 보인다(건수 없음). 상태를 읽기 전이면 칸을 비운다.
 * 호스트는 값(text·tone)으로 비교하므로 같은 상태면 같은 결과면 된다. 상태 글리프는 싣지 않는다 — 사령관의 얼굴은 사령관 화면 머리의 아바타가 말한다.
 */
export const commodoreDestinationTrailing: RailEntryDestinationTrailing = {
  subscribe: (listener) => subscribeCommodore(listener),
  get: (theaterId): RailEntryDestinationTrailingValue | null => {
    if (!theaterId) return null;
    const view = readCommodore(theaterId).view;
    if (!view) return null;
    const t = getT(commodoreLanguage());
    if (!view.active) return { text: t("commodore.mobile.off"), tone: "faint" };
    const run = view.run;
    if (run.phase === "turn") return { text: t("commodore.meta.turn") };
    if (run.phase === "retrying" && run.nextWakeAt) return { text: t("commodore.meta.retrying", { time: clockTime(run.nextWakeAt) }) };
    if (run.phase === "error") return { text: t("commodore.meta.error"), tone: "danger" };
    return { text: t("commodore.mobile.on") };
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
  const title = t("commodore.name");
  const theaterLabel = useCommodoreTheaterLabel(theaterId);

  // 사령관 화면이 서면 막대는 그 화면이 올린다(대화 pill · 칩 화면 제목). 그 밖(꺼짐·Theater 없음)은 제목과 지금 Theater 이름뿐이다.
  const screen = !(known && !enabled) && theaterId !== "";
  useEffect(() => {
    if (visible && !screen) mobileBar?.set({ title, ...(theaterLabel ? { subtitle: theaterLabel } : {}), depth: 0 });
  }, [mobileBar, visible, screen, title, theaterLabel]);

  if (known && !enabled) return <CommodoreDisabled t={t} />;
  if (!theaterId) return <div className="objectives-cm" />;
  return <CommodoreScreen key={theaterId} t={t} theaterId={theaterId} enabled={enabled} bar={visible ? mobileBar ?? null : null} title={title} theaterLabel={theaterLabel} panelRequest={visible ? ctx.params.commodorePanel : undefined} />;
}

/** 실험 기능이 꺼진 채 들어온 화면 — 보던 중 꺼지면 호스트가 홈으로 돌려보내므로, 옛 주소로 들어온 순간에만 잠깐 선다. */
function CommodoreDisabled({ t }: { readonly t: T }) {
  return (
    <div className="objectives-cm">
      <div className="objectives-cm-center">
        <p className="objectives-cm-center-text">{t("commodore.failed.disabled")}</p>
        <a data-press="r3" className="objectives-cm-pill" href="settings?section=experiments">{t("commodore.mobile.openExperiments")}</a>
      </div>
    </div>
  );
}

/** 대화 pill 의 보조 줄 — 자율 운영과 지금의 실행 상태를 한 줄로(켜면 다음 순찰, 도는 중·재시도·오류는 그 사실). */
function commodorePillStatus(t: T, view: CommodoreView | null): string {
  if (!view) return "";
  if (!view.active) return t("commodore.mobile.autonomyOff");
  const run = view.run;
  const autonomy = t("commodore.settings.autonomy");
  if (run.phase === "turn") return `${autonomy} · ${t("commodore.meta.turn")}`;
  if (run.phase === "retrying" && run.nextWakeAt) return `${autonomy} · ${t("commodore.meta.retrying", { time: clockTime(run.nextWakeAt) })}`;
  if (run.phase === "error") return `${autonomy} · ${t("commodore.meta.error")}`;
  return run.nextWakeAt ? `${autonomy} · ${t("commodore.drawer.nextPatrol", { time: clockTime(run.nextWakeAt) })}` : autonomy;
}

/**
 * 화면은 두 장이다. 기본은 그룹 대화와 같은 대화(사령관 기록이 말풍선, 머리는 대화 pill 하나)이고, pill 을 누르면 한 단 깊은 칩 화면
 * — 맨 위 자율 운영 행과 기록·목표·지시·기억·설정 탭 — 이 선다. 기억 항목은 한 단씩 쌓이고, ‹·시스템 뒤로는 한 단씩 돌아온다.
 */
function CommodoreScreen({ t, theaterId, enabled, bar, title, theaterLabel, panelRequest }: { readonly t: T; readonly theaterId: string; readonly enabled: boolean; readonly bar: ClientMobileBarCapability | null; readonly title: string; readonly theaterLabel: string | undefined; readonly panelRequest: string | undefined }) {
  const { view, entries, live, hasMore, transcriptLoaded } = useCommodore(theaterId);
  const tab = useCommodoreMobileTab();
  const online = useCommodoreOnline();
  const board = useObjectiveTheater(theaterId);
  const [panel, setPanel] = useState(false);
  const openPanel = useCallback(() => setPanel(true), []);
  useCommodoreMobilePanelRequest(panelRequest, openPanel);
  const [memoryTrail, setMemoryTrail] = useState<readonly string[]>([]);
  const openMemory = useCallback((ref: string) => setMemoryTrail((trail) => [...trail, ref]), []);
  const trimMemory = useCallback((length: number) => setMemoryTrail((trail) => trail.slice(0, length)), []);
  useEffect(() => { if (!panel || tab !== "memory") setMemoryTrail([]); }, [panel, tab]);
  const [failure, setFailure] = useState<string | null>(null);
  const mongle = commodoreMongleState(view, board.objectives);
  const pillStatus = commodorePillStatus(t, view);
  useEffect(() => {
    if (!bar) return;
    if (panel) bar.set({ title, ...(theaterLabel ? { subtitle: theaterLabel } : {}), depth: 1 + (tab === "memory" ? memoryTrail.length : 0), onBack: () => { if (tab === "memory" && memoryTrail.length) setMemoryTrail((trail) => trail.slice(0, -1)); else setPanel(false); } });
    else bar.set({
      title,
      ...(pillStatus ? { subtitle: pillStatus } : {}),
      depth: 0,
      pill: { label: t("commodore.mobile.openPanel"), avatar: <CommodoreAvatar theaterId={theaterId} state={mongle} size={36} label="" decorative />, avatarKey: mongle, onPress: () => setPanel(true) },
    });
  }, [bar, panel, tab, memoryTrail, title, theaterLabel, pillStatus, mongle, theaterId, t]);

  useEffect(() => {
    if (!enabled) return;
    void loadCommodore(theaterId);
    if (!readCommodore(theaterId).transcriptLoaded) void loadTranscript(theaterId);
  }, [theaterId, enabled]);
  useEffect(() => { setFailure(null); }, [tab, panel]);

  const fail = useCallback((error: unknown) => setFailure(failWord(t, error)), [t]);
  const clear = useCallback(() => setFailure(null), []);
  const openLog = useCallback(() => { setCommodoreMobileTab("log"); setPanel(true); }, []);
  const on = view?.active === true;
  const run = view?.run;
  const tabs: readonly { readonly id: CommodoreMobileTab; readonly label: string }[] = [
    { id: "log", label: t("commodore.tabs.log") },
    { id: "goals", label: t("commodore.trail.title") },
    { id: "directive", label: t("commodore.tabs.directive") },
    { id: "memory", label: t("commodore.tabs.memory") },
    { id: "settings", label: t("commodore.tabs.settings") },
  ];

  // 화면은 호스트 상단 막대 뒤로 흐른다 — 대화는 호스트 대화 화면이 막대 몫(--m-chrome-top)을 기록 위에 비우고, 칩 화면은 자율 운영 행과
  // 탭이 막대와 한 덩어리로 떠 있는 머리가 되어 탭 본문이 막대 몫에 머리의 제 높이(--objectives-cm-head)를 더해 비운다. 재시도·오류 띠는 알림 띠라
  // 그것이 서면 호스트가 막대 아래에서 화면을 시작한다.
  const flow = !(on && (run?.phase === "retrying" || run?.phase === "error"));
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  useChromeHeightProperty(headRef, rootRef, "--objectives-cm-head", chromeRowHeight);
  return (
    <div ref={rootRef} className="objectives-cm" {...(flow ? { "data-mobile-chrome": "flow" } : {})}>
      {on && (run?.phase === "retrying" || run?.phase === "error") ? (
        <div className="objectives-cm-band">
          {run.phase === "retrying" ? (
            <span className="objectives-cm-band-text">{[run.reason ? errorWord(t, run.reason) : null, run.nextWakeAt ? t("commodore.drawer.retryAt", { time: clockTime(run.nextWakeAt) }) : null].filter(Boolean).join(" · ")}</span>
          ) : (
            <span className="objectives-cm-band-text is-danger">{[t("commodore.meta.error"), run.reason ? errorWord(t, run.reason) : null].filter(Boolean).join(" · ")}</span>
          )}
          <button type="button" data-press="r1" className="objectives-cm-band-act" disabled={!online} onClick={() => { clear(); void retryCommodore(theaterId).catch(fail); }}>{t("commodore.drawer.retryNow")}</button>
        </div>
      ) : null}
      {panel ? (
        <>
          <div ref={headRef} className="objectives-cm-chrome">
            <AutonomyRow t={t} theaterId={theaterId} view={view} online={online} onFail={fail} onClear={clear} />
            <CommodoreMobileTabs t={t} tabs={tabs} selected={tab} onSelect={(next) => { if (next === "memory") setMemoryTrail([]); setCommodoreMobileTab(next); }} />
          </div>
          {tab === "log" ? <CommodoreMobileLog t={t} language={commodoreLanguage() ?? "en"} theaterId={theaterId} view={view} entries={entries} live={live} hasMore={hasMore} loaded={transcriptLoaded} online={online} failure={failure} onFail={fail} onClear={clear} /> : null}
          {tab === "goals" ? <div className="objectives-cm-fill objectives-cm-goals"><CommodoreTrail t={t} language={commodoreLanguage() ?? "en"} theaterId={theaterId} onOpenObjective={(objectiveId) => openObjectiveOnPhone(objectiveId, theaterId)} /></div> : null}
          {tab === "directive" && view ? <CommodoreMobileDirective t={t} theaterId={theaterId} view={view} online={online} failure={failure} onFail={fail} onClear={clear} /> : null}
          {tab === "memory" ? <CommodoreMobileMemory t={t} theaterId={theaterId} trail={memoryTrail} onOpen={openMemory} onTrim={trimMemory} /> : null}
          {tab === "settings" && view ? <CommodoreMobileSettings t={t} theaterId={theaterId} view={view} online={online} failure={failure} onFail={fail} onClear={clear} /> : null}
        </>
      ) : (
        <CommodoreMobileChat
          t={t}
          language={commodoreLanguage() ?? "en"}
          theaterId={theaterId}
          view={view}
          entries={entries}
          live={live}
          hasMore={hasMore}
          loaded={transcriptLoaded}
          online={online}
          failure={failure}
          onFail={fail}
          onClear={clear}
          onOpenLog={openLog}
        />
      )}
    </div>
  );
}

/** 넘친 탭 줄만 가로로 민다 — scrollIntoView 는 바깥 세로 스크롤도 움직이므로 쓰지 않는다. */
function CommodoreMobileTabs({ t, tabs, selected, onSelect }: {
  readonly t: T;
  readonly tabs: readonly { readonly id: CommodoreMobileTab; readonly label: string }[];
  readonly selected: CommodoreMobileTab;
  readonly onSelect: (tab: CommodoreMobileTab) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const edges = () => {
      row.classList.toggle("is-scroll", row.scrollWidth > row.clientWidth + 0.5);
      row.classList.toggle("is-start", row.scrollLeft <= 0.5);
      row.classList.toggle("is-end", row.scrollLeft >= row.scrollWidth - row.clientWidth - 0.5);
    };
    const fit = () => {
      const active = row.querySelector<HTMLElement>(".is-on");
      if (active) {
        const left = active.offsetLeft - 16;
        const right = active.offsetLeft + active.offsetWidth + 16 - row.clientWidth;
        if (row.scrollLeft > left) row.scrollLeft = left;
        else if (row.scrollLeft < right) row.scrollLeft = right;
      }
      edges();
    };
    fit();
    row.addEventListener("scroll", edges, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(row);
    for (const child of Array.from(row.children)) observer?.observe(child);
    return () => { row.removeEventListener("scroll", edges); observer?.disconnect(); };
  }, [selected, t]);
  return <div ref={rowRef} className="objectives-cm-tabs" role="tablist" aria-label={t("commodore.tabs.aria")}>
    {tabs.map((item) => <button key={item.id} type="button" role="tab" data-press="r1" aria-selected={selected === item.id} className={selected === item.id ? "is-on" : undefined} onClick={() => onSelect(item.id)}>{item.label}</button>)}
  </div>;
}

/* ── 자율 운영 행(CM-2a-3) ─────────────────────────────────────────────── */

function AutonomyRow({ t, theaterId, view, online, onFail, onClear }: { readonly t: T; readonly theaterId: string; readonly view: CommodoreView | null; readonly online: boolean; readonly onFail: (error: unknown) => void; readonly onClear: () => void }) {
  const board = useObjectiveTheater(theaterId);
  const [busy, setBusy] = useState(false);
  // 상태 줄은 한 줄 말줄임이다(commodore-mobile.css) — 잘린 끝도 스위치 설명으로 읽히게 이어 둔다.
  const statusId = useId();
  const on = view?.state.autonomy === true;
  const run = view?.run;
  const { meta } = commodoreSummary(t, view, board.objectives);
  const parts = meta.filter((part) => part.key === "running" || part.key === "handled").map((part) => part.text).join(" · ");
  let status: ReactNode = null;
  if (busy) status = t("commodore.mobile.switching");
  else if (view && !view.boardReady) status = t("commodore.failed.boardUnavailable");
  else if (view && !view.active) status = meta.map((part) => part.text).join(" · ");
  else if (view && run?.phase === "turn") status = <>{t("commodore.meta.turn")} · {parts}</>;
  else if (view && run?.phase === "retrying" && run.nextWakeAt) status = <>{t("commodore.meta.retrying", { time: clockTime(run.nextWakeAt) })} · {parts}</>;
  else if (view && run?.phase === "error") status = <><span className="is-danger">{t("commodore.meta.error")}</span> · {parts}</>;
  else if (view) status = <>{[run?.nextWakeAt ? t("commodore.drawer.nextPatrol", { time: clockTime(run.nextWakeAt) }) : null, parts].filter(Boolean).join(" · ")}</>;
  const toggle = () => {
    // 바꾸는 동안의 두 번째 누름은 버린다 — 서버 결과가 진실이다.
    if (busy || !view || !view.boardReady || !online) return;
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
        aria-label={t("commodore.settings.autonomy")}
        aria-describedby={status !== null ? statusId : undefined}
        disabled={!view || !view.boardReady || !online}
        onClick={toggle}
      >
        {/* 머리는 이 Theater 사령관의 아바타다 — 사이드바 머리 표식과 같은 얼굴(작업 중·대기·오류·쉼)로 상태를 말하고, 상태 줄은 글이 맡는다. */}
        <span className="objectives-cm-trow-ic"><CommodoreAvatar theaterId={theaterId} state={commodoreMongleState(view, board.objectives)} size={28} off={!view?.active} label="" decorative /></span>
        <span className="objectives-cm-trow-tx">
          <b>{t("commodore.settings.autonomy")}</b>
          {status !== null ? <span id={statusId} className="objectives-cm-trow-ds">{status}</span> : null}
        </span>
        <span className={`objectives-cm-tog${on ? " is-on" : ""}${busy ? " is-busy" : ""}`} aria-hidden="true" />
      </button>
    </div>
  );
}

/* ── 대화(기본 화면) ──────────────────────────────────────────────────── */

/**
 * 그룹 대화와 같은 대화 화면(호스트 `ctx.chat.Conversation`) — 데스크톱 대화 중심 화면의 사령관 대화와 같은 투영이다. 사람의 말은
 * 오른쪽 말풍선, 사령관의 글은 왼쪽 말풍선, 보드 행위는 가운데 행위 줄, 깨움·세션 교대는 노트 줄. 사람이 보낸 이미지는 같은
 * 첨부 미리보기(`messageImages` → `ChatDispatchAttachments`)로 선다. 보내는 동안의 말은 확정 줄이 오기 전까지 흐린 사람 말풍선이다.
 * 사령관 이름은 칩 화면의 기록 탭(상세 원장)을 연다.
 */
function CommodoreMobileChat({ t, language, theaterId, view, entries, live, hasMore, loaded, online, failure, onFail, onClear, onOpenLog }: {
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
  readonly onOpenLog: () => void;
}) {
  const Conversation = commodoreConversationRenderer();
  const TopEntries = commodoreComposerTopEntriesRenderer();
  const board = useObjectiveTheater(theaterId);
  const asks = view?.state.asks;
  const [pending, setPending] = useState<CommodorePendingMessage | null>(null);
  const index = useCommodoreObjectiveIndex(theaterId);
  const confirmed = useMemo(() => commodoreConversationEntries(t, theaterId, entries, [], board.objectives, asks, index.finished), [t, theaterId, entries, board.objectives, asks, index.finished]);
  const items = useMemo<readonly AgentConversationEntry[]>(() => {
    const base = commodoreConversationLiveEntries(t, entries, live, confirmed);
    if (!pending) return base;
    return [...base, {
      kind: "message", id: `pending-${pending.key}`, at: pending.at, operationId: "", speaker: { kind: "human", name: "Human" }, text: pending.text, streaming: false, pending: true,
      ...(pending.images.length > 0 ? { attachments: pending.images.map((image) => ({ preview: { id: image.key, url: image.url } })) } : {}),
    }];
  }, [t, entries, live, confirmed, pending]);
  const turning = view?.active === true && view.run.phase === "turn";
  const speaker = useMemo<ConversationSpeaker>(() => ({ kind: "commodore", name: t("commodore.name") }), [t]);
  const participants = useMemo<readonly ConversationParticipant[]>(() => [{ speaker, activity: turning ? "running" : "idle" }], [speaker, turning]);
  const working = useMemo<readonly ConversationSpeaker[]>(() => (turning ? [speaker] : []), [speaker, turning]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const readOlder = useCallback(() => {
    setLoadingOlder(true);
    void loadTranscript(theaterId, { older: true }).finally(() => setLoadingOlder(false));
  }, [theaterId]);
  const openReference = useCallback((objectiveId: string) => openObjectiveOnPhone(objectiveId, theaterId), [theaterId]);
  const references = useCommodoreReferenceHost(t, theaterId, openReference);
  const openBoardAction = useMemo<AgentConversationProps["openBoardAction"]>(() => ({
    label: t("commodore.trail.open"),
    open: (entry) => { if (entry.objectiveId) openObjectiveOnPhone(entry.objectiveId, theaterId); },
  }), [t, theaterId]);
  // 원장(기록 탭)에 설 턴이 있을 때만 이름이 눌린다 — 눌리는 척하지 않는다.
  const hasTurn = turning || entries.some((entry) => entry.kind === "wake" || entry.kind === "text" || entry.kind === "tool" || entry.kind === "result" || entry.kind === "ask");
  const openLedger = useMemo<AgentConversationProps["openLedger"]>(() => (hasTurn ? () => onOpenLog() : null), [hasTurn, onOpenLog]);
  const composer = (
    <div className="objectives-cm-dock">
      <CommodoreComposer t={t} theaterId={theaterId} active={view ? view.active : false} phone={{ online, failure, onPending: setPending }} topEntries={!Conversation && TopEntries ? <TopEntries /> : null} onFail={onFail} onClear={onClear} />
    </div>
  );
  return (
    <div className="objectives-cm-fill objectives-cm-conversation">
      {Conversation ? (
        <Conversation
          entries={items}
          participants={participants}
          working={working}
          language={language}
          theaterId={theaterId}
          loading={!loaded}
          empty={t("commodore.log.empty")}
          older={hasMore ? { label: t("commodore.log.older"), loading: loadingOlder, load: readOlder } : null}
          openBoardAction={openBoardAction}
          openLedger={openLedger}
          references={references}
          cards={<CommodoreAskCards theaterId={theaterId} t={t} language={language} phone onEnded={onFail} />}
          composer={composer}
          composerTopEntries
        />
      ) : composer}
    </div>
  );
}

/* ── 기록 탭(CM-2b) ───────────────────────────────────────────────────── */

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
  const TopEntries = commodoreComposerTopEntriesRenderer();
  const asks = view?.state.asks;
  const index = useCommodoreObjectiveIndex(theaterId);
  const chat = useMemo(() => commodoreChatEntries(t, theaterId, entries, live, asks, index), [t, theaterId, entries, live, asks, index]);
  const openReference = useCallback((objectiveId: string) => openObjectiveOnPhone(objectiveId, theaterId), [theaterId]);
  const references = useCommodoreReferenceHost(t, theaterId, openReference);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pending, setPending] = useState<CommodorePendingMessage | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 입력 독은 기록 위에 떠 있다 — 기록이 독 뒤까지 내려가고 독 높이(`--m-dock-h`)만큼 아래를 비운다(스크롤 범위는 그대로).
  const fillRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  useChromeHeightProperty(dockRef, fillRef, "--m-dock-h");
  const pinned = useRef(true);
  const programmaticTop = useRef<number | null>(null);
  const olderAnchor = useRef<number | null>(null);
  const on = view?.active === true;
  const run = view?.run;
  const turn = on && run?.phase === "turn";

  const scrollToBottom = useCallback((node: HTMLDivElement) => {
    node.scrollTop = node.scrollHeight;
    programmaticTop.current = node.scrollTop;
  }, []);

  // 열면 맨 아래. 그 뒤로는 바닥에 붙어 있을 때만 새 줄을 따라간다. 이전 기록을 붙이면 보던 자리를 지킨다.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (olderAnchor.current !== null) {
      node.scrollTop = node.scrollHeight - olderAnchor.current;
      programmaticTop.current = node.scrollTop;
      olderAnchor.current = null;
      return;
    }
    if (pinned.current) scrollToBottom(node);
  }, [chat, pending, turn, loaded, scrollToBottom]);

  // 부모(CommodoreScreen)의 useLayoutEffect 가 --objectives-cm-head 를 적은 직후와, 독(--m-dock-h)·전사 자식이 자랄 때도 바닥 고정을 유지한다.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (pinned.current) scrollToBottom(node);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) scrollToBottom(node);
    });
    observer.observe(node);
    if (dockRef.current) observer.observe(dockRef.current);
    for (const child of Array.from(node.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [chat, pending, turn, loaded, scrollToBottom]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node || node.clientHeight === 0) return;
    if (node.scrollTop === programmaticTop.current) return;
    programmaticTop.current = null;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };
  const older = () => {
    const node = scrollRef.current;
    olderAnchor.current = node ? node.scrollHeight - node.scrollTop : null;
    setLoadingOlder(true);
    void loadTranscript(theaterId, { older: true }).finally(() => setLoadingOlder(false));
  };

  let body: ReactNode;
  if (!loaded) {
    body = <div className="objectives-cm-center"><p className="objectives-cm-center-text">{t("commodore.mobile.loading")}</p></div>;
  } else if (chat.length === 0 && !turn && !pending) {
    body = (
      <div className="objectives-cm-center">
        <span className="objectives-cm-bigmono"><PennantIcon /></span>
        <p className="objectives-cm-center-text">{t("commodore.log.empty")}</p>
      </div>
    );
  } else {
    body = (
      <>
        {hasMore ? <button type="button" data-press="r1" className="objectives-cm-tbtn is-center" disabled={loadingOlder} onClick={older}>{t("commodore.log.older")}</button> : null}
        {Transcript ? <Transcript entries={chat} language={language} mobile references={references} /> : null}
        {pending ? (
          <div className="objectives-cm-msg">
            <p className="objectives-cm-head"><b>{t("commodore.log.you")}</b><span className="objectives-cm-time">{clockTime(pending.at)}</span><span>{t("commodore.mobile.sending")}</span></p>
            {pending.images.length > 0 ? <div className="objectives-cm-msg-images">{pending.images.map((image) => <img key={image.key} src={image.url} alt={image.name} />)}</div> : null}
            <p className="objectives-cm-bubble">{pending.text}</p>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div ref={fillRef} className="objectives-cm-fill">
      <div ref={scrollRef} className={`objectives-cm-chat${loaded && (chat.length > 0 || turn || pending) ? "" : " is-center"}`} onScroll={onScroll}>
        {body}
        <CommodoreAskCards theaterId={theaterId} t={t} language={language} phone onEnded={onFail} />
      </div>
      {/* 입력 독 — 데스크톱 사령관·지휘관 대화와 같은 캡슐 입력창이다(첨부·「+」 메뉴·안내 줄). 폰에서 달라지는 것만 phone 으로 넘긴다. */}
      <div ref={dockRef} className="objectives-cm-dock">
        <CommodoreComposer t={t} theaterId={theaterId} active={view ? view.active : false} phone={{ online, failure, onPending: setPending }} topEntries={TopEntries ? <TopEntries /> : null} onFail={onFail} onClear={onClear} />
      </div>
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
  // 실패 한 줄은 그 일을 한 자리(지시 저장 단추 곁, 정보 목록 곁)에 선다 — 한 탭에 두 일이 있다.
  const [failedAt, setFailedAt] = useState<"directive" | "intel">("directive");
  const failIn = (part: "directive" | "intel") => (error: unknown) => { setFailedAt(part); onFail(error); };
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
    void saveCommodoreDirective(theaterId, draft).then(() => setSaved(true)).catch(failIn("directive")).finally(() => setSaving(false));
  };
  return (
    <div className="objectives-cm-content">
      <div className="objectives-cm-pad">
        <label className="objectives-cm-glab" htmlFor="objectives-cm-directive">{t("commodore.directive.label")}</label>
        <textarea id="objectives-cm-directive" className="objectives-cm-field is-tall" value={draft} maxLength={8_000} placeholder={t("commodore.directive.placeholder")} onChange={(event) => { setDraft(event.target.value); setSaved(false); }} />
        <p className="objectives-cm-secnote">{t("commodore.directive.hint")}</p>
        {failure && failedAt === "directive" ? <p className="objectives-cm-note" role="alert">{failure}</p> : null}
        <div className="objectives-cm-crow">
          <span className="objectives-cm-secnote is-grow">{directive.rev > 0 ? t("commodore.directive.rev", { rev: directive.rev, time: clockTime(directive.updatedAt) }) : ""}</span>
          <button type="button" data-press="r3" className="objectives-cm-pill is-inverse" disabled={saving || !dirty || !online} onClick={save}>{t("commodore.directive.save")}</button>
        </div>
        {saved && !dirty ? <p className="objectives-cm-secnote is-done" role="status">{t(view.active ? "commodore.directive.saved" : "commodore.directive.savedIdle")}</p> : null}
        {/* 지시 아래 구분선 하나 밑에 정보와 정보 출처 — 데스크톱 지시 칸과 같은 구성이다. */}
        <hr className="objectives-cm-divider" />
        <CommodoreMobileIntel t={t} theaterId={theaterId} view={view} online={online} failure={failedAt === "intel" ? failure : null} onFail={failIn("intel")} onClear={onClear} />
      </div>
    </div>
  );
}

/* ── 지시 탭의 정보(CM-2d) ─────────────────────────────────────────────── */

function CommodoreMobileIntel({ t, theaterId, view, online, failure, onFail, onClear }: TabProps) {
  const { intel, sources } = view.state;
  const adder = useCommodoreIntelAdd(theaterId, { phone: true, online, onFail, onClear });
  const editing = useCommodoreIntelEdits(theaterId, intel, { onClear });
  const sourceLabel = (source: string) => source === "person" ? t("commodore.intel.fromYou") : sources.find((candidate) => candidate.id === source)?.label ?? source;
  const day = (at: number) => { const date = new Date(at); return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  return (
    <>
      <p className="objectives-cm-glab">{t("commodore.intel.label")}</p>
      {intel.length === 0 ? <p className="objectives-cm-secnote">{t("commodore.intel.empty")}</p> : null}
      {failure ? <p className="objectives-cm-note" role="alert">{failure}</p> : null}
      <div ref={editing.listRef} className="objectives-cm-grp">
        {intel.map((item) => {
          const edit = editing.edits[item.id];
          // 출처와 「수정됨」 사이는 끊기지 않는 공백 — 표시가 줄 끝에서 홀로 떨어지지 않는다.
          const meta = `${day(item.at)} · ${sourceLabel(item.source)}${item.editedAt !== undefined ? `\u00a0·\u00a0${t("commodore.intel.edited")}` : ""}`;
          // 폰 자판의 Enter 는 줄바꿈이다 — 저장·취소는 단추로 한다.
          if (edit) return (
            <div key={item.id} className="objectives-cm-gr is-editing">
              <textarea
                ref={focusAtEnd}
                className="objectives-cm-field objectives-cm-intel-field"
                value={edit.draft}
                maxLength={4_000}
                readOnly={edit.saving}
                aria-label={t("commodore.intel.editField")}
                onChange={(event) => editing.change(item.id, event.target.value)}
                onKeyDown={(event) => { if (event.key === "Escape" && !edit.saving) { event.preventDefault(); event.stopPropagation(); editing.cancel(item.id); } }}
              />
              {edit.error ? <p className="objectives-cm-note" role="alert">{t("commodore.failed", { code: errorWord(t, edit.error) })}</p> : null}
              <div className="objectives-cm-crow">
                <span className="objectives-cm-secnote is-grow objectives-cm-intel-meta">{meta}</span>
                <button type="button" data-press="r3" className="objectives-cm-pill" disabled={edit.saving} onClick={() => editing.cancel(item.id)}>{t("commodore.intel.cancel")}</button>
                <button type="button" data-press="r3" className="objectives-cm-pill is-inverse" disabled={edit.saving || !online || !edit.draft.trim() || edit.draft.trim() === item.text} onClick={() => editing.save(item.id)}>{t(edit.saving ? "commodore.intel.saving" : "commodore.intel.save")}</button>
              </div>
            </div>
          );
          return (
            <div key={item.id} className="objectives-cm-gr">
              <span className="objectives-cm-gr-tx objectives-cm-intel-tx" onClick={() => { if (online && !window.getSelection()?.toString()) editing.open(item.id); }}>{item.text}<small className="objectives-cm-intel-meta">{meta}</small></span>
              {/* 단추 둘은 세로로 쌓아 본문 칸을 넓게 둔다. */}
              <span className="objectives-cm-intel-actions">
                <button type="button" data-press="r1" className="objectives-cm-tbtn" {...{ [INTEL_EDIT_ATTRIBUTE]: item.id }} aria-label={t("commodore.intel.editAria")} disabled={!online} onClick={() => editing.open(item.id)}>{t("commodore.intel.edit")}</button>
                <button type="button" data-press="r1" className="objectives-cm-tbtn" aria-label={t("commodore.intel.removeAria")} disabled={!online} onClick={() => { onClear(); void removeCommodoreIntel(theaterId, item.id).catch(onFail); }}>{t("commodore.intel.remove")}</button>
              </span>
            </div>
          );
        })}
        {/* 「+ 정보 추가」 — 목록 맨 아래 같은 묶음의 한 줄. 화면 키보드의 Enter 는 줄바꿈이라 글이 있으면 곁에 「추가」가 선다. */}
        <div className="objectives-cm-gr objectives-cm-intel-add">
          <span className="objectives-cm-intel-plus" aria-hidden="true">+</span>
          <textarea {...adder.field} readOnly={adder.adding || !online} aria-label={t("commodore.intel.add")} placeholder={t("commodore.intel.add")} />
          {adder.draft.trim() ? <button type="button" data-press="r1" className="objectives-cm-tbtn" disabled={adder.adding || !online} onClick={adder.add}>{t("commodore.intel.addShort")}</button> : null}
        </div>
      </div>
      <p className="objectives-cm-glab">{t("commodore.intel.sources")} <span className="is-light">· {t("commodore.intel.sourcesLater")}</span></p>
      {sources.length > 0 ? (
        <div className="objectives-cm-grp">
          {sources.map((source) => <div key={source.id} className="objectives-cm-gr"><span className="objectives-cm-gr-tx">{source.label}<small className="is-mono">{source.locator}</small></span></div>)}
        </div>
      ) : null}
      <p className="objectives-cm-secnote">{sources.length === 0 ? `${t("commodore.intel.sourcesEmpty")} ` : ""}{t("commodore.intel.sourcesHint")}</p>
    </>
  );
}

/* ── 설정 탭(CM-2e) ───────────────────────────────────────────────────── */

function CommodoreMobileSettings({ t, theaterId, view, online, failure, onFail, onClear }: TabProps) {
  const { state, defaults, run } = view;
  const act = (work: () => Promise<void>) => { onClear(); void work().catch(onFail); };
  const host = useMobileSettingsHost();
  const defaultWord = t("commodore.patrol.default");
  // 좌표 두 칸은 데스크톱 서랍과 같은 공유 선택기 — 폰 설정 화면 안이라 호스트의 좌표 시트로 열린다. 비우면 기본값이다.
  const modelOverridden = state.model !== undefined;
  const commanderOverridden = state.commanderModel !== undefined;

  const patrol = state.patrolMinutes ?? DEFAULT_PATROL;
  const usage = [t("commodore.drawer.session", { n: run.totals.session }), t("commodore.drawer.cost", { cost: run.totals.costUsd.toFixed(2) })].join(" · ");

  return (
    <div className="objectives-cm-content">
      <div className="objectives-cm-pad objectives-cm-settings">
        {failure ? <p className="objectives-cm-note" role="alert">{failure}</p> : null}
        <SettingsCard description={t("commodore.settings.modelHint")}>
          <SettingsRow label={t("commodore.settings.model")} icon={<SparkIcon />} disabled={!online}>
            <CommodoreCoordinateField
              t={t}
              target="agent"
              label={t("commodore.drawer.modelAria")}
              value={commodoreValue(state)}
              fallback={defaults}
              disabled={!online}
              {...(modelOverridden ? { reset: { label: t("commodore.settings.useDefault"), onSelect: () => act(() => setCommodoreCoordinates(theaterId, null)) } } : {})}
              onChange={(next) => act(() => setCommodoreCoordinates(theaterId, commodoreCoordinates(state, defaults, next)))}
            />
          </SettingsRow>
        </SettingsCard>
        <SettingsCard description={t("commodore.settings.patrolHint")}>
          <SettingsRow label={t("commodore.settings.patrol")} icon={<ClockIcon />} disabled={!online}>
            <button
              type="button"
              className="fc-select__trigger fc-select--mobile"
              aria-haspopup="dialog"
              disabled={!online || !host}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                host?.openChoice({
                  title: t("commodore.settings.patrol"),
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
        <SettingsCard description={t("commodore.settings.commanderHint")}>
          <SettingsRow label={t("commodore.settings.commander")} icon={<TargetIcon />} disabled={!online}>
            <CommodoreCoordinateField
              t={t}
              target="launch"
              label={t("commodore.settings.commanderAria")}
              value={commanderValue(state)}
              fallback={DEFAULT_LAUNCH}
              disabled={!online}
              {...(commanderOverridden ? { reset: { label: t("commodore.settings.useDefault"), onSelect: () => act(() => setCommodoreCommander(theaterId, null)) } } : {})}
              onChange={(next) => act(() => setCommodoreCommander(theaterId, commanderCoordinates(state, next)))}
            />
          </SettingsRow>
        </SettingsCard>
        <SettingsCard>
          {/* 정보 행 — 누름 없음. 값 줄은 다른 행의 값과 같은 자리·같은 글자다(비활성 단추가 아니다). */}
          <SettingsRow label={t("commodore.mobile.usage")} icon={<ChartIcon />}>
            <span className="fc-select__trigger fc-select--mobile objectives-cm-info-value"><span className="fc-select__value">{usage}</span></span>
          </SettingsRow>
        </SettingsCard>
      </div>
    </div>
  );
}
