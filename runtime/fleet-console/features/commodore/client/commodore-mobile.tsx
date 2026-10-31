import { CommodorePeerLedger, commodoreParticipants } from "./commodore-peer-ledger.js";
import { CommodoreRoutines } from "./commodore-routines.js";
import { openOwnedObjectiveOnPhone } from "./board.js";
import { useCommodoreName } from "./commodore-name.js";
import { useCommodoreOpenUIPort } from "./openui-ports.js";
import { messageCommodore } from "./commodore-state.js";
import { ConversationPillContext, useConversationPillHost } from "../../workspace/client/conversation/pill-takeover.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { AgentConversationEntry, AgentConversationProps } from "../../execution/shared/chat-renderer.js";
import type { ConversationParticipant, ConversationSpeaker } from "../../execution/shared/conversation/types.js";
import type { Translate } from "@fleet-console/i18n";
import type { ClientMobileBarCapability, PaneContext } from "../../workspace/shared/pane.js";
import type { RailEntryDestinationTrailing, RailEntryDestinationTrailingValue } from "../../workspace/shared/rail.js";
import { useChromeHeightProperty } from "@fleet-console/ui/react";
import { registerCommodoreDeparture } from "./commodore-delete-events.js";
import { SettingsCard, SettingsRow } from "../../settings/client/preferences-context.js";

import type { CommodoreLiveEvent, CommodoreTranscriptEntry } from "../shared/contracts/types.js";
import type { CommodoreMobileSessions } from "./deps.js";
import { commodoreChatEntries, commodoreConversationEntries, commodoreConversationLiveEntries, errorWord } from "./commodore-chat.js";
import { CommodoreAskCards, ENDED_ASK_CODES } from "./commodore-ask.js";
import { CommodoreTrailSection } from "./commodore-trail.js";
import { commanderCoordinates, commanderValue, CommodoreCoordinateField, commodoreCoordinates, commodoreValue } from "./commodore-controls.js";
import { CommodoreAvatar } from "./commodore-avatar.js";
import { CommodoreTheaters } from "./commodore-theater-tab.js";
import { CommodorePlugins } from "./commodore-plugins.js";
import { CommodoreMobileMemory } from "./commodore-mobile-memory.js";
import { useCommodoreObjectiveIndex, useCommodoreReferenceHost } from "./commodore-reference-input.js";
import { clockTime, nextRoutineWord, commodoreMongleState, commodoreSummary } from "./commodore-header.js";
import { useCommodoreList, useMobileCommodoreSelection } from "./commodore-list.js";
import { CommodoreComposer, CommodoreDescription, CommodoreSessionSettings, focusAtEnd, useCommodoreIntelAdd, type CommodorePendingMessage } from "./commodore-inbox-section.js";
import {
  commodoreComposerTopEntriesRenderer,
  commodoreConversationRenderer,
  commodoreLanguage,
  commodoreMobileActions,
  commodoreMobileSessions,
  commodoreTranscriptRenderer,
  loadCommodore,
  loadTranscript,
  noteCommodoreLanguage,
  openCommodoreMobile,
  readCommodore,
  transcriptNeeded,
  removeCommodoreIntel,
  retryCommodore,
  setCommodoreCommander,
  setCommodoreCoordinates,
  subscribeCommodore,
  useCommodore,
  useCommodoreEnabled,
  useCommodoreExperimentKnown,
  INTEL_EDIT_ATTRIBUTE,
  useCommodoreIntelEdits,
  useCommodoreMemory,
  useCommodoreMobileTab,
  useCommodoreMobilePanelRequest,
  useCommodoreOnline,
  type CommodoreMobileTab,
} from "./commodore-state.js";
import { getT, type CommodoreMessageKey } from "./i18n/index.js";
import { DEFAULT_LAUNCH } from "./defaults.js";
import { isRunningObjective, openObjectiveOnPhone, useObjectiveTheater } from "./board.js";
import "./commodore-mobile.css";

/**
 * 모바일 바로가기 목적지 「사령관」(impl-spec S-53·S-54) — 데스크톱의 사이드바 줄 + 「사령관 기록」 시트를 폰 화면 한 장으로.
 * 호스트가 페인 컨텍스트에 `mobileBar`를 실을 때만 선다. 데스크톱 시트와 같은 스토어·같은 API다 — 자율 운영·메시지·설명·정보·
 * 모델·루틴·지휘관 모델·재시도 모두 같은 경로를 탄다. 대상은 지금 Theater 의 사령관이다.
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
/* 세부 구역 행 · ⋮ 메뉴 — 같은 문법. 연필·톱니·더하기·Theater 는 호스트 폰 아이콘과 같은 경로, 책갈피는 기억 탭의 빈 화면 아이콘이다. */
const LogIcon = () => <Icon><path d="M5 6h14M5 10h14M5 14h10M5 18h7" /></Icon>;
const InfoIcon = () => <Icon><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8v.01" /></Icon>;
const GearIcon = () => <Icon><circle cx="12" cy="12" r="3.2" /><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8" /></Icon>;
const TrashIcon = () => <Icon><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></Icon>;
const PlusIcon = () => <Icon><path d="M12 5v14M5 12h14" /></Icon>;
const TheaterIcon = () => <Icon><path d="M5 5h14M4 9h16v10H4z" /></Icon>;
/** 지휘관 목록 시트 — 호스트 `MobileIcon` `commanders`와 같은 경로. */
const CommandersIcon = () => <Icon><circle cx="9" cy="8" r="2.2" /><path d="M4.2 18.2v-.6a3.4 3.4 0 0 1 3.4-3.4h2.8a3.4 3.4 0 0 1 3.4 3.4v.6" /><circle cx="16.2" cy="9" r="1.8" /><path d="M15.2 14.2a3.2 3.2 0 0 1 3.1 2.4" /></Icon>;
const ChevronIcon = () => <Icon size={16}><path d="m9 5 7 7-7 7" /></Icon>;

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
  get: (commodoreId): RailEntryDestinationTrailingValue | null => {
    if (!commodoreId) return null;
    const view = readCommodore(commodoreId).view;
    if (!view) return null;
    const t = getT(commodoreLanguage());
    const run = view.run;
    if (run.phase === "turn") return { text: t("commodore.meta.turn") };
    if (run.phase === "retrying" && run.nextWakeAt) return { text: t("commodore.meta.retrying", { time: clockTime(run.nextWakeAt) }) };
    if (run.phase === "error") return { text: t("commodore.meta.error"), tone: "danger" };
    return { text: t(view.active ? "commodore.meta.autonomous" : "commodore.meta.inactive") };
  },
};

/* ── 화면 ─────────────────────────────────────────────────────────────── */

export function MobileCommodore({ ctx }: { readonly ctx: PaneContext }) {
  const t = getT(ctx.language);
  const enabled = useCommodoreEnabled();
  const known = useCommodoreExperimentKnown();
  const { mobileBar, visible } = ctx;
  const rawCommodore = ctx.params["commodoreId"];
  const rawTheater = ctx.params["theaterId"];
  const paramCommodoreId = typeof rawCommodore === "string" && rawCommodore.length > 0 ? rawCommodore : null;
  // 주소의 사령관, 없으면 기기에 기억한 선택. 고른 적 없으면 임의의 수신자를 세우지 않는다.
  const selectedCommodoreId = useMobileCommodoreSelection();
  const listed = useCommodoreList();
  const commodoreId = paramCommodoreId ?? selectedCommodoreId;
  useEffect(() => {
    if (!commodoreId || !visible) return;
    if (paramCommodoreId === commodoreId && rawTheater === undefined) return;
    ctx.panes.replaceParams({ commodoreId });
  }, [commodoreId, ctx.panes, paramCommodoreId, rawTheater, visible]);
  if (ctx.language) noteCommodoreLanguage(ctx.language);
  const row = commodoreId ? listed.find((item) => item.commodoreId === commodoreId) ?? null : null;
  const firstTheaterLabel = row?.theaters.find((theater) => theater.label)?.label ?? "";
  const fallbackName = t("commodore.name");
  const title = useCommodoreName(commodoreId ?? "", t);
  const named = title !== fallbackName || !commodoreId ? title : (firstTheaterLabel || fallbackName);
  const theaterLabel = firstTheaterLabel && firstTheaterLabel !== named ? firstTheaterLabel : (!firstTheaterLabel && named !== fallbackName ? fallbackName : "");

  // 사령관 화면이 서면 막대는 그 화면이 올린다(대화 pill · 칩 화면 제목). 그 밖(꺼짐·Theater 없음)은 제목과 지금 Theater 이름뿐이다.
  const screen = !(known && !enabled) && commodoreId !== null;
  useEffect(() => {
    if (visible && !screen) mobileBar?.set({ title: named, ...(theaterLabel ? { subtitle: theaterLabel } : {}), depth: 0 });
  }, [mobileBar, visible, screen, named, theaterLabel]);

  if (known && !enabled) return <CommodoreDisabled t={t} />;
  if (!commodoreId) return <div className="objectives-cm" />;
  const scopeTheaterId = row?.theaters[0]?.theaterId ?? "";
  return <CommodoreScreen key={commodoreId} t={t} theaterId={scopeTheaterId} commodoreId={commodoreId} enabled={enabled} bar={visible ? mobileBar ?? null : null} title={named} alias={row?.alias ?? ""} panelRequest={visible ? ctx.params.commodorePanel : undefined} />;
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

/** 루틴 유무와 별개로 메시지 턴의 진행·오류도 그대로 보인다. */
function commodorePillStatus(t: T, view: CommodoreView | null): string {
  if (!view) return "";
  const run = view.run;
  const mode = t(view.active ? "commodore.meta.autonomous" : "commodore.meta.inactive");
  if (run.phase === "turn") return `${mode} · ${t("commodore.meta.turn")}`;
  if (run.phase === "retrying" && run.nextWakeAt) return `${mode} · ${t("commodore.meta.retrying", { time: clockTime(run.nextWakeAt) })}`;
  if (run.phase === "error") return `${mode} · ${t("commodore.meta.error")}`;
  const routine = nextRoutineWord(t, view);
  return routine ? `${mode} · ${routine}` : mode;
}

/** 세부 하위 화면의 막대 제목 — 지금 탭 이름과 같은 말이다. */
function sectionTitle(t: T, section: CommodoreMobileTab): string {
  switch (section) {
    case "sessions": return t("commodore.tabs.sessions");
    case "log": return t("commodore.tabs.log");
    case "routines": return t("commodore.tabs.routines");
    case "info": return t("commodore.tabs.info");
    case "settings": return t("commodore.tabs.settings");
  }
}

/**
 * 화면은 세 단이다. 기본(깊이 0)은 그룹 대화와 같은 대화(사령관 기록이 말풍선, 머리는 대화 pill 하나)이고, pill 은 세부(깊이 1)를 열고, 오른쪽 글리프는 지휘관 시트를 연다.
 * 세부는 큰 아바타 · 이름 · 「편집」과 구역 행 카드(지휘관 세션·기록·목표 / 정보·설정)다. 행을 누르면 그 구역 본문이 깊이 2의
 * 하위 화면으로 서고, 기억 항목은 그 위에 한 단씩 쌓인다. ‹·시스템 뒤로·`__fleetMobileBack`은 모두 막대의 `onBack` 하나로 한 단씩 돌아온다.
 * 깊은 링크(`openCommodoreMobile(tab, id, true)`)와 대화의 원장 열기는 세부와 그 구역을 한 번에 세운다(깊이 0 → 2) — 뒤로는 구역 → 세부 → 대화다.
 */
function CommodoreScreen({ t, theaterId, commodoreId, enabled, bar, title, alias, panelRequest }: { readonly t: T; readonly theaterId: string; readonly commodoreId: string | null; readonly enabled: boolean; readonly bar: ClientMobileBarCapability | null; readonly title: string; readonly alias: string; readonly panelRequest: string | undefined }) {
  const { view, entries, live, hasMore, transcriptLoaded, transcriptError } = useCommodore(commodoreId);
  const requested = useCommodoreMobileTab();
  const online = useCommodoreOnline();
  const sessionsPort = commodoreMobileSessions();
  const SessionsList = sessionsPort?.List ?? null;
  const actions = commodoreMobileActions();
  const board = useObjectiveTheater(commodoreId);
  const [panel, setPanel] = useState(false);
  const pill = useConversationPillHost(commodoreId ? { kind: "commodore", id: commodoreId } : null, bar !== null && !panel);
  // 세부 안에서 연 구역. null이면 세부(프로필) 자체다. 세션 본문을 호스트가 주지 않으면 그 자리는 기록이다.
  const [section, setSection] = useState<CommodoreMobileTab | null>(null);
  const openSection = useCallback((next: CommodoreMobileTab) => { setSection(next === "sessions" && !SessionsList ? "log" : next); setPanel(true); }, [SessionsList]);
  const openRequested = useCallback(() => openSection(requested), [openSection, requested]);
  useCommodoreMobilePanelRequest(panelRequest, openRequested);
  const [memoryTrail, setMemoryTrail] = useState<readonly string[]>([]);
  const openMemory = useCallback((ref: string) => setMemoryTrail((trail) => [...trail, ref]), []);
  const trimMemory = useCallback((length: number) => setMemoryTrail((trail) => trail.slice(0, length)), []);
  useEffect(() => { if (!panel || section !== "info") setMemoryTrail([]); }, [panel, section]);
  const [failure, setFailure] = useState<string | null>(null);
  const shownFailure = failure ?? (transcriptError ? failWord(t, new Error(transcriptError)) : null);
  const mongle = commodoreMongleState(view, board.objectives);
  const pillStatus = commodorePillStatus(t, view);
  // 세부에서 다른 화면으로 옮기는 동작 — 세부(구역·기억 단계 포함)를 먼저 접어 막대가 쌓은 깊이 항목을 걷고, 그 뒤로(popstate)가 내려앉은 뒤에 옮긴다(`mobileBar.leave`).
  // 접기 전에 옮기면 그 항목이 history에 남아, 다음 뒤로가 그것을 걷으며 주소만 사령관으로 돌아가고 화면은 남는다(홈 시트의 「닫고 나서 연다」와 같은 규칙).
  const leave = useCallback((run: () => void) => {
    if (!bar) { run(); return; }
    bar.leave(() => { setSection(null); setMemoryTrail([]); setPanel(false); }, run);
  }, [bar]);
  useEffect(() => commodoreId ? registerCommodoreDeparture(commodoreId, leave) : undefined, [commodoreId, leave]);
  const newSession = useMemo(() => (actions && commodoreId ? () => leave(() => actions.newSession(commodoreId)) : null), [actions, commodoreId, leave]);
  useEffect(() => {
    if (!bar) return;
    if (!panel) {
      bar.set({
        title,
        ...(pillStatus ? { subtitle: pillStatus } : {}),
        depth: 0,
        // 칩은 세부, 오른쪽은 지금 칩이 열던 지휘관 시트. 세부의 ⋮(새 세션·Theater·삭제)는 깊이 1에 그대로 둔다.
        pill: { takeover: pill.takeover, label: t("commodore.mobile.openPanel"), avatar: commodoreId ? <CommodoreAvatar commodoreId={commodoreId} state={mongle} size={36} label="" decorative /> : null, avatarKey: mongle, onPress: () => { setSection(null); setPanel(true); } },
        ...(actions && commodoreId ? { actions: [{ id: "commanders", label: t("commodore.mobile.commanders"), icon: <CommandersIcon />, run: () => actions.commanders(commodoreId) }] } : {}),
      });
      return;
    }
    if (section === null) {
      // 세부의 막대는 둥근 ‹ · ⋮ 뿐이다 — 이름은 본문의 큰 머리가 말한다. ⋮ 는 데스크톱 사이드바 사령관 메뉴의 새 세션 · Theater… 를 옮긴 것이다.
      bar.set({
        title: "",
        round: true,
        depth: 1,
        onBack: () => setPanel(false),
        menu: {
          label: t("commodore.mobile.more"),
          caption: title,
          items: [
            ...(newSession ? [{ id: "new-session", label: t("commodore.mobile.newSession"), icon: <PlusIcon />, disabled: !online, run: newSession }] : []),
            { id: "theaters", label: t("commodore.mobile.theaters"), icon: <TheaterIcon />, run: () => setSection("settings") },
            ...(actions && commodoreId ? [{ id: "delete", label: t("commodore.mobile.delete"), icon: <TrashIcon />, destructive: true, disabled: !online, run: () => actions.delete(commodoreId) }] : []),
          ],
        },
      });
      return;
    }
    bar.set({
      title: sectionTitle(t, section),
      subtitle: title,
      round: true,
      depth: 2 + (section === "info" ? memoryTrail.length : 0),
      onBack: () => { if (section === "info" && memoryTrail.length) setMemoryTrail((trail) => trail.slice(0, -1)); else setSection(null); },
    });
  }, [bar, panel, section, memoryTrail, title, pillStatus, mongle, theaterId, commodoreId, newSession, online, t, actions, pill.takeover]);

  useEffect(() => {
    if (!enabled) return;
    if (!commodoreId) return;
    void loadCommodore(commodoreId);
    if (transcriptNeeded(commodoreId)) void loadTranscript(commodoreId);
  }, [commodoreId, enabled]);
  useEffect(() => { setFailure(null); }, [section, panel]);

  const fail = useCallback((error: unknown) => setFailure(failWord(t, error)), [t]);
  const clear = useCallback(() => setFailure(null), []);
  const openLog = useCallback(() => openSection("log"), [openSection]);
  const run = view?.run;
  const editLook = actions && commodoreId ? () => actions.editLook({ commodoreId, label: title, alias }) : null;

  // 화면은 호스트 상단 막대 뒤로 흐른다 — 대화는 호스트 대화 화면이, 세부와 하위 화면은 제 스크롤 영역이 막대 몫(--m-chrome-top)을 위에 비운다.
  // 재시도·오류 띠는 알림 띠라 그것이 서면 호스트가 막대 아래에서 화면을 시작한다.
  const flow = !(run?.phase === "retrying" || run?.phase === "error");
  return (
    <div className="objectives-cm" {...(flow ? { "data-mobile-chrome": "flow" } : {})}>
      {(run?.phase === "retrying" || run?.phase === "error") ? (
        <div className="objectives-cm-band">
          {run.phase === "retrying" ? (
            <span className="objectives-cm-band-text">{[run.reason ? errorWord(t, run.reason) : null, run.nextWakeAt ? t("commodore.drawer.retryAt", { time: clockTime(run.nextWakeAt) }) : null].filter(Boolean).join(" · ")}</span>
          ) : (
            <span className="objectives-cm-band-text is-danger">{[t("commodore.meta.error"), run.reason ? errorWord(t, run.reason) : null].filter(Boolean).join(" · ")}</span>
          )}
          <button type="button" data-press="r1" className="objectives-cm-band-act" disabled={!online || !commodoreId} onClick={() => { if (!commodoreId) return; clear(); void retryCommodore(commodoreId).catch(fail); }}>{t("commodore.drawer.retryNow")}</button>
        </div>
      ) : null}
      {panel ? (
        <>
          {section === null && commodoreId ? <CommodoreMobileProfile t={t} commodoreId={commodoreId} view={view} name={title} sessions={sessionsPort} onOpen={openSection} onEdit={editLook} /> : null}
          {section === "sessions" && SessionsList && commodoreId ? <div className="objectives-cm-fill objectives-cm-sessions"><SessionsList commodoreId={commodoreId} leave={leave} /></div> : null}
          {section === "log" ? <CommodoreMobileLog t={t} language={commodoreLanguage() ?? "en"} theaterId={commodoreId ?? ""} view={view} entries={entries} live={live} hasMore={hasMore} loaded={transcriptLoaded} online={online} failure={shownFailure} onFail={fail} onClear={clear} leave={leave} /> : null}
          {section === "routines" ? <div className="objectives-cm-content"><CommodoreRoutines commodoreId={commodoreId ?? ""} language={commodoreLanguage() ?? "en"} phone /></div> : null}
          {/* 정보 화면 — 설명 · 정보 아래 기억이 한 스크롤로 선다. 기억 항목을 열면 그 항목이 화면 전체를 받는다. */}
          {section === "info" && view ? <CommodoreMobileMemory t={t} theaterId={commodoreId ?? ""} trail={memoryTrail} onOpen={openMemory} onTrim={trimMemory} leave={leave} header={<CommodoreMobileDescription t={t} theaterId={commodoreId ?? ""} view={view} online={online} failure={failure} onFail={fail} onClear={clear} />} footer={<CommodoreTrailSection t={t} language={commodoreLanguage() ?? "en"} theaterId={commodoreId ?? ""} phone onOpenObjective={(objectiveId) => leave(() => openObjectiveOnPhone(objectiveId, theaterId))} />} /> : null}
          {section === "settings" && view ? <CommodoreMobileSettings t={t} theaterId={commodoreId ?? ""} view={view} online={online} failure={failure} onFail={fail} onClear={clear} /> : null}
        </>
      ) : (
        <ConversationPillContext.Provider value={pill.port}><CommodoreMobileChat
          t={t}
          language={commodoreLanguage() ?? "en"}
          commodoreId={commodoreId ?? ""}
          theaterId={theaterId}
          view={view}
          entries={entries}
          live={live}
          hasMore={hasMore}
          loaded={transcriptLoaded}
          online={online}
          failure={shownFailure}
          onFail={fail}
          onClear={clear}
          onOpenLog={openLog}
        /></ConversationPillContext.Provider>
      )}
    </div>
  );
}

/* ── 세부(프로필) ─────────────────────────────────────────────────────── */

const noAttentionCount = (_commodoreId: string): number => 0;
const isLive = (objective: { readonly done: object | null; readonly removed: object | null }) => objective.done === null && objective.removed === null;

/**
 * 세부 첫 화면 — 큰 아바타 · 이름 · 상태 한 줄 · 「편집」(이름·모양 시트), 그 아래 둥근 카드 두 장의 구역 행이다. 행 오른쪽 회색 값은
 * 이미 읽는 스토어에서만 얻는다(보드 목표 · 사령관 상태 · 기억). 값이 없으면 칸을 비우고 › 만 둔다.
 */
function CommodoreMobileProfile({ t, commodoreId, view, name, sessions, onOpen, onEdit }: {
  readonly t: T;
  readonly commodoreId: string;
  readonly view: CommodoreView | null;
  readonly name: string;
  readonly sessions: CommodoreMobileSessions | null;
  readonly onOpen: (section: CommodoreMobileTab) => void;
  readonly onEdit: (() => void) | null;
}) {
  const board = useObjectiveTheater(commodoreId);
  const memory = useCommodoreMemory(commodoreId);
  const objectives = board.objectives.filter(isLive);
  const status = view && !view.boardReady ? t("commodore.failed.boardUnavailable") : commodorePillStatus(t, view);
  // 지휘관 세션 — 그 화면 머리의 「확인 필요 N」과 같은 수(호스트의 확인 필요 요약)가 먼저, 없으면 진행 중인 목표 수.
  const useAttentionCount = sessions?.useAttentionCount ?? noAttentionCount;
  const attention = useAttentionCount(commodoreId);
  const running = objectives.filter(isRunningObjective).length;
  const sessionsValue: ProfileValue = attention > 0 ? { text: t("commodore.mobile.attention", { n: attention }), tone: "awaiting" } : running > 0 ? { text: t("commodore.mobile.running", { n: running }) } : null;
  const run = view?.run;
  const logValue: ProfileValue = !run ? null
    : run.phase === "turn" ? { text: t("commodore.meta.turn") }
    : run.phase === "error" ? { text: t("commodore.meta.error"), tone: "danger" }
    : run.phase === "retrying" && run.nextWakeAt ? { text: t("commodore.meta.retrying", { time: clockTime(run.nextWakeAt) }) }
    : run.totals.actions > 0 ? { text: t("commodore.meta.handled", { n: run.totals.actions }) } : null;
  const memoryValue: ProfileValue = memory.loaded && memory.entries.length > 0 ? { text: t("commodore.mobile.count", { n: memory.entries.length }) } : null;
  const settingsValue: ProfileValue = view ? { text: view.state.model ?? view.defaults.model } : null;
  const routinesValue: ProfileValue = view ? { text: t("commodore.routines.enabledCount", { n: (view.state.routines ?? []).filter((r) => r.enabled).length }) } : null;
  const usage = run ? [t("commodore.mobile.usage"), t("commodore.drawer.session", { n: run.totals.session }), t("commodore.drawer.cost", { cost: run.totals.costUsd.toFixed(2) })].join(" · ") : "";
  return (
    <div className="objectives-cm-profile">
      <div className="objectives-cm-hero">
        <CommodoreAvatar commodoreId={commodoreId} state={commodoreMongleState(view, board.objectives)} size={104} label="" decorative />
        <h2 className="objectives-cm-hero-name">{name}</h2>
        {status ? <p className="objectives-cm-hero-status">{status}</p> : null}
        {onEdit ? <button type="button" data-press="r3" className="objectives-cm-pill objectives-cm-edit" aria-label={t("commodore.mobile.editAria", { name })} onClick={onEdit}>{t("commodore.mobile.edit")}</button> : null}
      </div>
      <nav className="objectives-cm-cards" aria-label={t("commodore.mobile.sections")}>
        <div className="objectives-cm-card">
          {sessions ? <ProfileRow section="sessions" icon={<TargetIcon />} label={t("commodore.tabs.sessions")} value={sessionsValue} onOpen={onOpen} /> : null}
          <ProfileRow section="log" icon={<LogIcon />} label={t("commodore.tabs.log")} value={logValue} onOpen={onOpen} />
          <ProfileRow section="routines" icon={<ClockIcon />} label={t("commodore.tabs.routines")} value={routinesValue} onOpen={onOpen} />
        </div>
        <div className="objectives-cm-card">
          <ProfileRow section="info" icon={<InfoIcon />} label={t("commodore.tabs.info")} value={memoryValue} onOpen={onOpen} />
          <ProfileRow section="settings" icon={<GearIcon />} label={t("commodore.tabs.settings")} value={settingsValue} onOpen={onOpen} />
        </div>
      </nav>
      {usage ? <p className="objectives-cm-profile-foot">{usage}</p> : null}
    </div>
  );
}

type ProfileValue = { readonly text: string; readonly tone?: "awaiting" | "danger" } | null;

function ProfileRow({ section, icon, label, value, onOpen }: { readonly section: CommodoreMobileTab; readonly icon: ReactNode; readonly label: string; readonly value: ProfileValue; readonly onOpen: (section: CommodoreMobileTab) => void }) {
  return (
    <button type="button" data-press="r2" className="objectives-cm-prow" data-section={section} onClick={() => onOpen(section)}>
      <span className="objectives-cm-prow-ic">{icon}</span>
      <span className="objectives-cm-prow-lb">{label}</span>
      {value ? <span className={`objectives-cm-prow-val${value.tone ? ` is-${value.tone}` : ""}`}>{value.text}</span> : null}
      <span className="objectives-cm-prow-caret"><ChevronIcon /></span>
    </button>
  );
}

/* ── 대화(기본 화면) ──────────────────────────────────────────────────── */

/**
 * 그룹 대화와 같은 대화 화면(호스트 `ctx.chat.Conversation`) — 데스크톱 대화 중심 화면의 사령관 대화와 같은 투영이다. 사람의 말은
 * 오른쪽 말풍선, 사령관의 글은 왼쪽 말풍선, 보드 행위는 가운데 행위 줄, 깨움·세션 교대는 노트 줄. 사람이 보낸 이미지는 같은
 * 첨부 미리보기(`messageImages` → `ChatDispatchAttachments`)로 선다. 보내는 동안의 말은 확정 줄이 오기 전까지 흐린 사람 말풍선이다.
 * 사령관 이름은 칩 화면의 기록 탭(상세 원장)을 연다.
 */
function CommodoreMobileChat({ t, language, commodoreId, theaterId, view, entries, live, hasMore, loaded, online, failure, onFail, onClear, onOpenLog }: {
  readonly t: T;
  readonly language: "en" | "ko";
  readonly commodoreId: string;
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
  const board = useObjectiveTheater(commodoreId);
  const asks = view?.state.asks;
  const [pending, setPending] = useState<CommodorePendingMessage | null>(null);
  const index = useCommodoreObjectiveIndex(commodoreId);
  const name = useCommodoreName(commodoreId, t);
  const confirmed = useMemo(() => commodoreConversationEntries(t, commodoreId, entries, [], board.objectives, asks, index.finished, name), [t, commodoreId, entries, board.objectives, asks, index.finished, name]);
  const items = useMemo<readonly AgentConversationEntry[]>(() => {
    const base = commodoreConversationLiveEntries(t, entries, live, confirmed, name, commodoreId);
    if (!pending) return base;
    return [...base, {
      kind: "message", id: `pending-${pending.key}`, at: pending.at, objectiveId: "", speaker: { kind: "human", name: "Human" }, text: pending.text, streaming: false, pending: true,
      ...(pending.images.length > 0 ? { attachments: pending.images.map((image) => ({ preview: { id: image.key, url: image.url } })) } : {}),
    }];
  }, [t, entries, live, confirmed, pending, name, commodoreId]);
  const turning = view?.run.phase === "turn";
  const speaker = useMemo<ConversationSpeaker>(() => ({ kind: "commodore", name, commodoreId }), [name, commodoreId]);
  const participants = useMemo<readonly ConversationParticipant[]>(() => commodoreParticipants(speaker, turning, confirmed), [speaker, turning, confirmed]);
  const [peerLedger, setPeerLedger] = useState<ConversationSpeaker | null>(null);
  const working = useMemo<readonly ConversationSpeaker[]>(() => (turning ? [speaker] : []), [speaker, turning]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const readOlder = useCallback(() => {
    setLoadingOlder(true);
    void loadTranscript(commodoreId, { older: true }).finally(() => setLoadingOlder(false));
  }, [commodoreId]);
  const openReference = useCallback((objectiveId: string) => openOwnedObjectiveOnPhone(commodoreId, objectiveId), [commodoreId]);
  const references = useCommodoreReferenceHost(t, commodoreId, openReference);
  const openCommodore = useCallback((id: string) => openCommodoreMobile("log", id), []);
  const openUIOpen = useCommodoreOpenUIPort(commodoreId, openReference, openCommodore);
  const openBoardAction = useMemo<AgentConversationProps["openBoardAction"]>(() => ({
    label: t("commodore.trail.open"),
    open: (entry) => { if (entry.objectiveId) references.open?.(entry.objectiveId); },
  }), [t, references]);
  // 원장(기록 탭)에 설 턴이 있을 때만 이름이 눌린다 — 눌리는 척하지 않는다.
  const hasTurn = turning || entries.some((entry) => entry.kind === "wake" || entry.kind === "text" || entry.kind === "tool" || entry.kind === "result" || entry.kind === "ask");
  const openLedger = useMemo<AgentConversationProps["openLedger"]>(() => (hasTurn || participants.length > 1 ? (target) => {
    if (target.commodoreId && target.commodoreId !== commodoreId) setPeerLedger(target); else onOpenLog();
  } : null), [hasTurn, participants.length, commodoreId, onOpenLog]);
  // 답 단추는 사령관에게 바로 보낸다. 입력창 초안·화면 키보드는 건드리지 않는다.
  const sendOpenUI = useCallback((text: string) => { void messageCommodore(commodoreId, text).catch(() => {}); }, [commodoreId]);
  const composer = (
    <div className="objectives-cm-dock">
      <CommodoreComposer t={t} theaterId={commodoreId} active={view?.boardReady === true && view.enabled} phone={{ online, failure, onPending: setPending }} topEntries={!Conversation && TopEntries ? <TopEntries /> : null} onFail={onFail} onClear={onClear} />
    </div>
  );
  return (
    <div className="objectives-cm-fill objectives-cm-conversation">
      {peerLedger ? <CommodorePeerLedger speaker={peerLedger} language={language} onBack={() => setPeerLedger(null)} /> : Conversation ? (
        <Conversation
          entries={items}
          participants={participants}
          working={working}
          language={language}
          commodoreId={commodoreId}
          loading={!loaded}
          empty={t("commodore.log.empty")}
          older={hasMore ? { label: t("commodore.log.older"), loading: loadingOlder, load: readOlder } : null}
          openBoardAction={openBoardAction}
          openLedger={openLedger}
          references={references} openUIOpen={openUIOpen}
          cards={<CommodoreAskCards theaterId={commodoreId} contextTheaterId={theaterId} t={t} language={language} phone onEnded={onFail} />}
          composer={composer}
          composerTopEntries
          onOpenUISend={sendOpenUI}
        />
      ) : composer}
    </div>
  );
}

/* ── 기록 탭(CM-2b) ───────────────────────────────────────────────────── */

function CommodoreMobileLog({ t, language, theaterId, view, entries, live, hasMore, loaded, online, failure, onFail, onClear, leave }: {
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
  /** 기록 탭은 세부 안에 있다 — 목표 참조·질문 카드로 다른 화면을 열 때 세부를 먼저 접는다. */
  readonly leave: (run: () => void) => void;
}) {
  // 데스크톱 시트와 같은 채팅 턴 렌더러 — 오래된 것 위, 새 것 아래(입력창 바로 위가 최신).
  const Transcript = commodoreTranscriptRenderer();
  const TopEntries = commodoreComposerTopEntriesRenderer();
  const asks = view?.state.asks;
  const index = useCommodoreObjectiveIndex(theaterId);
  const chat = useMemo(() => commodoreChatEntries(t, theaterId, entries, live, asks, index), [t, theaterId, entries, live, asks, index]);
  const openReference = useCallback((objectiveId: string) => leave(() => openOwnedObjectiveOnPhone(theaterId, objectiveId)), [theaterId, leave]);
  const references = useCommodoreReferenceHost(t, theaterId, openReference);
  const openCommodore = useCallback((id: string) => leave(() => openCommodoreMobile("log", id)), [leave]);
  const openUIOpen = useCommodoreOpenUIPort(theaterId, openReference, openCommodore);
  // 답 단추는 사령관에게 바로 보낸다. 입력창 초안·화면 키보드는 건드리지 않는다.
  const sendOpenUI = useCallback((text: string) => { void messageCommodore(theaterId, text).catch(() => {}); }, [theaterId]);
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
  const run = view?.run;
  const turn = run?.phase === "turn";

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

  // 막대 몫(--m-chrome-top)이 정해진 직후와, 독(--m-dock-h)·전사 자식이 자랄 때도 바닥 고정을 유지한다.
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
        {Transcript ? <Transcript entries={chat} language={language} mobile references={references} openUIOpen={openUIOpen} openui onOpenUISend={sendOpenUI} /> : null}
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
        <CommodoreAskCards theaterId={theaterId} t={t} language={language} phone leave={leave} onEnded={onFail} />
      </div>
      {/* 입력 독 — 데스크톱 사령관·지휘관 대화와 같은 캡슐 입력창이다(첨부·「+」 메뉴·안내 줄). 폰에서 달라지는 것만 phone 으로 넘긴다. */}
      <div ref={dockRef} className="objectives-cm-dock">
        <CommodoreComposer t={t} theaterId={theaterId} active={view?.boardReady === true && view.enabled} phone={{ online, failure, onPending: setPending }} topEntries={TopEntries ? <TopEntries /> : null} onFail={onFail} onClear={onClear} />
      </div>
    </div>
  );
}

/* ── 정보 화면의 설명·정보(CM-2c) ─────────────────────────────────────── */

interface TabProps {
  readonly t: T;
  readonly theaterId: string;
  readonly view: CommodoreView;
  readonly online: boolean;
  readonly failure: string | null;
  readonly onFail: (error: unknown) => void;
  readonly onClear: () => void;
}

/** 정보 화면 머리 — 설명 입력과 그 아래 정보 목록. 기억 트리가 이 아래에 이어 선다. */
function CommodoreMobileDescription({ t, theaterId, view, online, failure, onFail, onClear }: TabProps) {
  // 실패는 그 일을 한 섹션 곁에 남긴다.
  const [failedAt, setFailedAt] = useState<"description" | "intel">("description");
  const failIn = (part: "description" | "intel") => (error: unknown) => { setFailedAt(part); onFail(error); };
  return (
    <>
      <CommodoreDescription key={theaterId} t={t} commodoreId={theaterId} description={view.state.description} phone online={online} onFail={failIn("description")} onClear={onClear} />
      {failure && failedAt === "description" ? <p className="objectives-cm-note" role="alert">{failure}</p> : null}
      <CommodoreMobileIntel t={t} theaterId={theaterId} view={view} online={online} failure={failedAt === "intel" ? failure : null} onFail={failIn("intel")} onClear={onClear} />
    </>
  );
}

/* ── 정보 화면의 정보 목록(CM-2d) ──────────────────────────────────────── */

function CommodoreMobileIntel({ t, theaterId, view, online, failure, onFail, onClear }: TabProps) {
  const { intel, sources } = view.state;
  const adder = useCommodoreIntelAdd(theaterId, { phone: true, online, onFail, onClear });
  const editing = useCommodoreIntelEdits(theaterId, intel, { onClear });
  const sourceLabel = (source: string) => source === "person" ? t("commodore.intel.fromYou") : sources.find((candidate) => candidate.id === source)?.label ?? source;
  const day = (at: number) => { const date = new Date(at); return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  return (
    <section className="objectives-commodore-panel-section">
      <h3 className="objectives-commodore-panel-title">{t("commodore.intel.label")}</h3>
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
    </section>
  );
}

/* ── 설정 탭(CM-2e) ───────────────────────────────────────────────────── */

function CommodoreMobileSettings({ t, theaterId, view, online, failure, onFail, onClear }: TabProps) {
  const { state, defaults, run } = view;
  const act = (work: () => Promise<void>) => { onClear(); void work().catch(onFail); };
  // 좌표 두 칸은 데스크톱 서랍과 같은 공유 선택기 — 폰 설정 화면 안이라 호스트의 좌표 시트로 열린다. 비우면 기본값이다.
  const modelOverridden = state.model !== undefined;
  const commanderOverridden = state.commanderModel !== undefined;

  const usage = [t("commodore.drawer.session", { n: run.totals.session }), t("commodore.drawer.cost", { cost: run.totals.costUsd.toFixed(2) })].join(" · ");

  return (
    <div className="objectives-cm-content">
      <div className="objectives-cm-pad objectives-cm-settings">
        {failure ? <p className="objectives-cm-note" role="alert">{failure}</p> : null}
        <CommodoreTheaters commodoreId={theaterId} phone />
        <CommodorePlugins t={t} commodoreId={theaterId} phone />
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
        <SettingsCard>
          <SettingsRow label={t("commodore.settings.commander")} hint={t("commodore.settings.commanderHint")} icon={<TargetIcon />} disabled={!online}>
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
          <CommodoreSessionSettings key={theaterId} t={t} commodoreId={theaterId} phone />
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
