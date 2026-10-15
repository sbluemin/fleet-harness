import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { theaterAvatarKey, type MongleSpecial } from "@fleet-console/sdk/avatars";
import { subscribeAvatarBook } from "@fleet-console/sdk/avatars/browser";
import type { AgentConversationProps } from "@fleet-console/sdk/components/agent-chat-transcript";
import type { ConversationParticipant, ConversationSpeaker } from "@fleet-console/sdk/conversation";
import type { Translate } from "@fleet-console/sdk/i18n";
import type { ClientConversationCapability, ConversationSurfaceDescriptor } from "@fleet-console/sdk/plugin";
import type { ClientTheaterInboxCapability } from "@fleet-console/sdk/theater-inbox";

import { commodoreConversationEntries, commodoreConversationLiveEntries, commodoreConversationTarget, errorWord } from "./commodore-chat.js";
import { CommodoreAskCards, ENDED_ASK_CODES } from "./commodore-ask.js";
import { CommodoreClearButton, CommodoreComposer, CommodoreDirective, CommodoreIntel, CommodoreSettings } from "./commodore-inbox-section.js";
import { useCommodoreReferenceHost } from "./commodore-reference-input.js";
import { commodoreMongleState, commodoreSummary } from "./commodore-header.js";
import { commodoreName, useCommodoreName } from "./commodore-name.js";
import { CommodoreTrail } from "./commodore-trail.js";
import { COMMODORE_INBOX_SECTION_ID, commodoreConversationRenderer, commodoreMongleActivity, commodoreTheaterLabel, loadCommodore, loadTranscript, noteCommodoreLanguage, readCommodore, retryCommodore, subscribeCommodore, useCommodore } from "./commodore-state.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { readTheater, revealObjective, subscribeObjective, useObjectiveTheater } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 대화 중심 화면(Console 실험 기능)의 사령관 — 가운데 칸에 기록과 입력이, 오른쪽 패널 앞 묶음에 목표(행위 곁 칸)·지시·정보·
 * 설정이 선다(Theater 설정 곁의 「사령관」 섹션). 데이터·쓰기 경로는 Inbox 시트와 같은 사령관 상태이고, 여닫기는 SDK 능력
 * (`ctx.conversation`)만 쓴다. 대화 중심 화면에서 Theater 머리나 Inbox 요청이 사령관 기록을 열면 Inbox 섹션의 `openConversation` 이
 * 이 대화를 세운다. 대화 중심 화면이 꺼져 있으면 이 모듈은 아무것도 열지 않고, 머리는 Inbox 시트를 연다.
 */

export const COMMODORE_SURFACE_ID = "commodore";
const TAB_IDS = { goals: "commodore-goals", directive: "commodore-directive", intel: "commodore-intel", settings: "commodore-settings" } as const;
type ConversationTab = keyof typeof TAB_IDS;

let port: ClientConversationCapability | null = null;
let inbox: ClientTheaterInboxCapability | null = null;

/** 호스트 「Theater 설정」 섹션의 정준 id(SDK `TheaterInboxAddress` 문서). 칸을 모르면 호스트가 시스템 프롬프트 칸으로 연다. */
const THEATER_SETTINGS_SECTION = "console:settings";
const THEATER_SYSTEM_PROMPT_PAGE = "system-prompt";

/**
 * 설치 때 받은 능력을 쥔다. 구버전 호스트(능력 없음)면 대화 중심 화면은 없는 것으로 다룬다. Theater Inbox 는 지시 탭의
 * 「시스템 프롬프트」 링크가 쓴다 — 대화 중심 화면에서는 호스트가 그 칸을 오른쪽 패널의 Theater 설정 탭으로 연다.
 */
export function connectCommodoreConversation(next: ClientConversationCapability | undefined, nextInbox?: ClientTheaterInboxCapability): () => void {
  port = next ?? null;
  inbox = nextInbox ?? null;
  return () => {
    if (port === next) port = null;
    if (inbox === nextInbox) inbox = null;
  };
}

export interface CommodoreConversationOptions {
  /** 이 시각을 덮는 턴을 드러낸다(행위 곁 칸·목표 대화의 사령관 행위 줄). */
  readonly revealAt?: number;
  /** 목표 대화에서 행위 기록을 보러 온 것 — 입력 대신 돌아가기만 선다. */
  readonly readOnly?: boolean;
  readonly objectiveId?: string;
}

/** 호스트의 대화 배치 여부 — Theater 머리의 첫 칸 판정도 같은 능력을 읽는다. */
export function isCommodoreConversationActive(): boolean {
  return port?.isActive() === true;
}

/** 대화 배치 여부가 바뀌면 깨운다 — 능력이 없는 호스트에서는 아무것도 하지 않는다. */
export function subscribeCommodoreConversationActive(listener: () => void): () => void {
  return port?.subscribe(listener) ?? (() => {});
}

/** 대화 배치 여부를 따라 다시 그리는 훅 — 우측 사이드바의 목표 상세가 머리를 걷을지 정한다. */
export function useCommodoreConversationActive(): boolean {
  return useSyncExternalStore(
    subscribeCommodoreConversationActive,
    isCommodoreConversationActive,
    () => false,
  );
}

/** 가운데 칸에 그 Theater 의 사령관을 세운다. 대화 중심 화면이 꺼져 있으면 false — 부르는 쪽이 시트로 돌아간다. */
export function openCommodoreConversation(theaterId: string, options: CommodoreConversationOptions = {}): boolean {
  if (!port || !port.isActive()) return false;
  const opened = port.open(COMMODORE_SURFACE_ID, { theaterId, ...options });
  if (!opened) return false;
  void loadCommodore(theaterId);
  if (!readCommodore(theaterId).transcriptLoaded) void loadTranscript(theaterId);
  if (options.revealAt !== undefined) revealCommodoreTurn(theaterId, options.revealAt);
  return true;
}

/** 사령관 아바타 편집기를 열 수 있는가 — 대화 중심 화면이 서 있고 호스트가 편집기 열기(`editAvatar`)를 준다. 폰·구버전 호스트는 아니다. */
export function canEditCommodoreAvatar(): boolean {
  return port?.isActive() === true && typeof port.editAvatar === "function";
}

/**
 * 그 Theater 의 사령관 대화를 세우고 오른쪽 패널 머리의 아바타 편집기를 「스페셜」 묶음으로 연다. special 은 미리 골라 둘 새다 —
 * 초안일 뿐이고 저장은 사람이 「적용」을 누른다. 열 수 없으면 false.
 */
export function openCommodoreAvatarSpecial(theaterId: string, special: MongleSpecial | null): boolean {
  if (!canEditCommodoreAvatar() || !openCommodoreConversation(theaterId)) return false;
  return port?.editAvatar?.(theaterAvatarKey(theaterId), { section: "special", special }) === true;
}

/**
 * 사령관 기록을 연다 — 대화 중심 화면이면 가운데 대화, 아니면 Theater Inbox 의 사령관 기록 칸(질문 카드가 그 위에 서 있다).
 * 사이드바 「내 결정」의 질문 줄과 확인 필요 행이 부른다.
 */
export function openCommodoreLog(theaterId: string): void {
  if (openCommodoreConversation(theaterId)) return;
  inbox?.open({ theaterId, sectionId: COMMODORE_INBOX_SECTION_ID, pageId: "log" });
}

/* ── 턴 드러내기 — 가운데 기록과 오른쪽 목표 탭이 함께 쓴다 ─────────────── */

let reveal: { readonly theaterId: string; readonly at: number; readonly nonce: number } | null = null;
const revealListeners = new Set<() => void>();

export function revealCommodoreTurn(theaterId: string, at: number): void {
  reveal = { theaterId, at, nonce: (reveal?.nonce ?? 0) + 1 };
  for (const listener of revealListeners) listener();
}

function useCommodoreReveal(theaterId: string) {
  const current = useSyncExternalStore(
    (listener) => { revealListeners.add(listener); return () => { revealListeners.delete(listener); }; },
    () => reveal,
    () => null,
  );
  return current?.theaterId === theaterId ? current : null;
}

/* ── 실패 한 줄 — 가운데 본문과 머리 pill 옆 지우기 단추가 함께 쓴다 ─────────── */

const failures = new Map<string, string>();
const failureListeners = new Set<() => void>();
// 실패 줄이 지금 서 있는 Theater — 본문이 세운다. 닫히거나 다른 Theater 로 바뀐 뒤에 끝난 요청의 실패는 적지 않는다
// (모듈 공유라 적으면 다음에 열 때 지난 실패가 선다).
const liveFailureLines = new Map<string, number>();

function setConversationFailure(theaterId: string, failure: string | null): void {
  if (failure !== null && !liveFailureLines.has(theaterId)) return;
  if ((failures.get(theaterId) ?? null) === failure) return;
  if (failure === null) failures.delete(theaterId);
  else failures.set(theaterId, failure);
  for (const listener of failureListeners) listener();
}

function useConversationFailure(theaterId: string): string | null {
  useEffect(() => {
    liveFailureLines.set(theaterId, (liveFailureLines.get(theaterId) ?? 0) + 1);
    return () => {
      const left = (liveFailureLines.get(theaterId) ?? 1) - 1;
      if (left > 0) liveFailureLines.set(theaterId, left);
      else liveFailureLines.delete(theaterId);
      setConversationFailure(theaterId, null);
    };
  }, [theaterId]);
  return useSyncExternalStore(
    (listener) => { failureListeners.add(listener); return () => { failureListeners.delete(listener); }; },
    () => failures.get(theaterId) ?? null,
    () => null,
  );
}

/* ── 가운데 칸 ─────────────────────────────────────────────────────────── */

function readParams(params: Readonly<Record<string, unknown>>): { readonly theaterId: string; readonly readOnly: boolean } | null {
  return typeof params.theaterId === "string" ? { theaterId: params.theaterId, readOnly: params.readOnly === true } : null;
}

function failureWord(t: T, error: unknown): string {
  const code = error instanceof Error ? error.message : "failed";
  if (ENDED_ASK_CODES.has(code)) return errorWord(t, code);
  return code === "commodore_disabled" ? t("objectives.commodore.failed.disabled") : code === "commodore_inactive" ? t("objectives.commodore.failed.inactive") : t("objectives.commodore.failed", { code });
}

/** 드러낼 시각이 읽은 기록 창보다 앞이면 이전 쪽을 이만큼까지 더 읽는다 — 한 요청이 기록 전체를 끌어오지 않게. */
const REVEAL_PAGE_LIMIT = 10;

/**
 * 가운데 칸의 사령관 대화 — Operation 대화와 같은 화면(호스트 `ctx.chat.Conversation`)이다. 사람의 말·사령관의 글은 말풍선,
 * 보드에 쓴 행위는 가운데 행위 줄(펼치면 이유, 누르면 그 목표), 세션 교대·실패는 노트 줄이다. 입력·지우기·읽기 전용 돌아가기는
 * 이 플러그인의 것을 그 화면의 입력 자리에 세운다. 접힌 턴 줄과 곁 칸 이음매는 Inbox 시트의 기록(`CommodoreLog`)에만 남는다.
 */
function CommodoreConversationBody({ theaterId, readOnly, language, onBack }: { readonly theaterId: string; readonly readOnly: boolean; readonly language: "en" | "ko"; readonly onBack: () => void }) {
  const t = getT(language);
  noteCommodoreLanguage(language);
  const { view, entries, live, hasMore, transcriptLoaded } = useCommodore(theaterId);
  const board = useObjectiveTheater(theaterId);
  const reveal = useCommodoreReveal(theaterId);
  const failure = useConversationFailure(theaterId);
  const setFailure = (next: string | null) => setConversationFailure(theaterId, next);
  useEffect(() => {
    void loadCommodore(theaterId);
    if (!readCommodore(theaterId).transcriptLoaded) void loadTranscript(theaterId);
  }, [theaterId]);
  const fail = (error: unknown) => setFailure(failureWord(t, error));
  const run = view?.run;
  const { on, meta, patrol } = commodoreSummary(t, view, board.objectives);
  const Conversation = commodoreConversationRenderer();
  const name = useCommodoreName(t, theaterId);
  const confirmed = useMemo(() => commodoreConversationEntries(t, theaterId, entries, [], board.objectives, view?.state.asks, name), [t, theaterId, entries, board.objectives, view?.state.asks, name]);
  const items = useMemo(() => commodoreConversationLiveEntries(t, entries, live, confirmed, name), [t, entries, live, confirmed, name]);
  // 사령관이 턴을 도는 동안 진행 줄이 서고, 최신 말풍선의 몽글도 작업 중 얼굴이다.
  const turning = on && run?.phase === "turn";
  const speaker = useMemo<ConversationSpeaker>(() => ({ kind: "commodore", name }), [name]);
  // 사령관은 Operation 이 없어 진행 줄이 활동을 스스로 읽지 못한다 — 감독자가 알린 활동을 참여자에 실어 준다.
  const step = turning ? commodoreMongleActivity(view) : null;
  const participants = useMemo<readonly ConversationParticipant[]>(() => [{ speaker, activity: turning ? "running" : "idle", ...(step ? { step } : {}) }], [speaker, turning, step]);
  const working = useMemo<readonly ConversationSpeaker[]>(() => (turning ? [speaker] : []), [speaker, turning]);

  const [loadingOlder, setLoadingOlder] = useState(false);
  const readOlder = () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    void loadTranscript(theaterId, { older: true }).finally(() => setLoadingOlder(false));
  };
  // 곁 칸·목표 대화가 가리킨 시각이 읽은 창보다 앞이면, 그 시각에 닿을 때까지 이전 쪽을 읽는다(상한 있음).
  const revealPages = useRef<{ nonce: number; pages: number }>({ nonce: -1, pages: 0 });
  useEffect(() => {
    if (!reveal || !hasMore || loadingOlder) return;
    const firstAt = entries[0]?.at;
    if (firstAt !== undefined && firstAt <= reveal.at) return;
    if (revealPages.current.nonce !== reveal.nonce) revealPages.current = { nonce: reveal.nonce, pages: 0 };
    if (revealPages.current.pages >= REVEAL_PAGE_LIMIT) return;
    revealPages.current.pages += 1;
    readOlder();
  }, [reveal, hasMore, entries, loadingOlder]); // eslint-disable-line react-hooks/exhaustive-deps -- readOlder 는 위 값만 읽는다.
  const target = reveal ? commodoreConversationTarget(items, reveal.at) : null;
  const revealEntry = useMemo<AgentConversationProps["reveal"]>(() => (reveal && target ? { entryId: target, nonce: reveal.nonce } : null), [reveal, target]);
  const references = useCommodoreReferenceHost(t, theaterId);
  const openBoardAction = useMemo<AgentConversationProps["openBoardAction"]>(() => ({
    label: t("objectives.commodore.trail.open"),
    open: (entry) => { if (entry.objectiveId) revealObjective({ objectiveId: entry.objectiveId }); },
  }), [t]);

  // 사령관의 지금 상태는 입력 아래 줄이 말한다. 읽기 전용이면 입력 대신 돌아가기가 서고, pill 의 부제가 그 사실을 말한다.
  const composer = (
    <footer className="objectives-commodore-foot">
      {failure ? <p className="objectives-commodore-failure" role="alert">{failure}</p> : null}
      {readOnly
        ? <button type="button" className="objectives-commodore-conversation-back" onClick={onBack}>{t("objectives.commodore.conversation.back")}</button>
        : <CommodoreComposer t={t} theaterId={theaterId} active={view ? view.active : true} context={run?.context} onFail={fail} onClear={() => setFailure(null)} />}
      <span className="objectives-commodore-conversation-status">{[...meta.map((part) => part.text), patrol].filter(Boolean).join(" · ")}</span>
    </footer>
  );
  return (
    <div className="objectives-commodore-conversation">
      {/* 맨 위 줄은 가운데 칸의 투명 오버레이다(머리 pill 과 그 옆 기록 비우기 단추가 떠 있다 — descriptor 의 actions) — 대화는 그
          밑으로 흘러 올라간다. */}
      {on && (run?.phase === "retrying" || run?.phase === "error") ? (
        <div className="objectives-commodore-retry">
          <span>{run.reason ? errorWord(t, run.reason) : t("objectives.commodore.meta.error")}</span>
          <button type="button" className="objectives-commodore-text-button" onClick={() => { setFailure(null); void retryCommodore(theaterId).catch(fail); }}>{t("objectives.commodore.drawer.retryNow")}</button>
        </div>
      ) : null}
      {/* 사령관의 질문 — 대화 위에 고정된다. 읽기 전용(지난 기록 보기)에서는 답하지 않는다. */}
      {readOnly ? null : <CommodoreAskCards theaterId={theaterId} t={t} onEnded={fail} />}
      <div className="objectives-commodore-conversation-log">
        {Conversation ? (
          <Conversation
            entries={items}
            participants={participants}
            working={working}
            language={language}
            theaterId={theaterId}
            loading={!transcriptLoaded}
            empty={t("objectives.commodore.log.empty")}
            older={hasMore ? { label: t("objectives.commodore.log.older"), loading: loadingOlder, load: readOlder } : null}
            reveal={revealEntry}
            openBoardAction={openBoardAction}
            references={references}
            composer={composer}
          />
        ) : composer}
      </div>
    </div>
  );
}

/** 머리 pill 옆 단추 묶음의 기록 비우기 — 실패는 가운데 본문의 실패 줄이 말한다. */
function CommodoreConversationActions({ theaterId, language }: { readonly theaterId: string; readonly language: "en" | "ko" }) {
  const t = getT(language);
  return (
    <CommodoreClearButton
      t={t}
      theaterId={theaterId}
      variant="caption"
      onFail={(error) => setConversationFailure(theaterId, failureWord(t, error))}
      onClear={() => setConversationFailure(theaterId, null)}
    />
  );
}

/* ── 오른쪽 패널 탭 ────────────────────────────────────────────────────── */

function CommodoreConversationTab({ tab, theaterId, language }: { readonly tab: ConversationTab; readonly theaterId: string; readonly language: "en" | "ko" }) {
  const t = getT(language);
  const { view } = useCommodore(theaterId);
  const [failure, setFailure] = useState<string | null>(null);
  const fail = (error: unknown) => setFailure(failureWord(t, error));
  const clear = () => setFailure(null);
  if (tab === "goals") {
    return (
      <div className="objectives-commodore-conversation-tab is-goals">
        <CommodoreTrail t={t} language={language} theaterId={theaterId} onReveal={(at) => revealCommodoreTurn(theaterId, at)} />
      </div>
    );
  }
  if (!view) return null;
  return (
    <div className="objectives-commodore-body objectives-commodore-conversation-tab">
      {tab === "directive" ? <CommodoreDirective t={t} theaterId={theaterId} directive={view.state.directive} active={view.active} onOpenSystemPrompt={() => inbox?.open({ theaterId, sectionId: THEATER_SETTINGS_SECTION, pageId: THEATER_SYSTEM_PROMPT_PAGE, focus: "editor-end" })} onFail={fail} onClear={clear} /> : null}
      {tab === "intel" ? <CommodoreIntel t={t} theaterId={theaterId} intel={view.state.intel} sources={view.state.sources} onFail={fail} onClear={clear} /> : null}
      {tab === "settings" ? <CommodoreSettings t={t} language={language} theaterId={theaterId} view={view} onFail={fail} onClear={clear} /> : null}
      {failure ? <p className="objectives-commodore-failure" role="alert">{failure}</p> : null}
    </div>
  );
}

/** 탭이 대신하는 Theater Inbox 사령관 칸 — 그 칸을 여는 요청(지시 링크 등)이 대화 중심 화면에서 이 탭을 연다. 기록은 가운데 칸이다. */
const TAB_INBOX_PAGES: Record<ConversationTab, string> = { goals: "log", directive: "directive", intel: "intel", settings: "settings" };

const TAB_TITLES: Record<ConversationTab, ObjectiveMessageKey> = {
  goals: "objectives.commodore.conversation.goals",
  directive: "objectives.commodore.tabs.directive",
  intel: "objectives.commodore.tabs.intel",
  settings: "objectives.commodore.tabs.settings",
};

/** Console 이 가운데 칸·오른쪽 패널에 세우는 사령관 대화. */
export const commodoreConversationSurface: ConversationSurfaceDescriptor = {
  id: COMMODORE_SURFACE_ID,
  title: (ctx) => {
    const theaterId = readParams(ctx.params)?.theaterId ?? "";
    const label = commodoreTheaterLabel(theaterId);
    const name = commodoreName(getT(ctx.language), theaterId);
    return label ? `${name} · ${label}` : name;
  },
  subtitle: (ctx) => (readParams(ctx.params)?.readOnly ? getT(ctx.language)("objectives.commodore.conversation.readOnly") : null),
  avatar: (ctx) => {
    const theaterId = readParams(ctx.params)?.theaterId;
    // 얼굴은 사이드바 머리 표식과 같은 사실이다 — 사령관이 턴을 도는 동안 pill 과 오른쪽 패널 머리도 작업 중이다.
    if (!theaterId) return null;
    const view = readCommodore(theaterId).view;
    return { key: theaterAvatarKey(theaterId), role: "commodore", label: commodoreName(getT(ctx.language), theaterId), state: commodoreMongleState(view, readTheater(theaterId).objectives), activity: commodoreMongleActivity(view) };
  },
  subscribe: (listener) => {
    const offCommodore = subscribeCommodore(listener);
    const offBoard = subscribeObjective(listener);
    // 스페셜을 고르거나 떼면 제목의 이름(「사령관(보리)」)이 바뀐다.
    const offAvatars = subscribeAvatarBook(listener);
    return () => { offCommodore(); offBoard(); offAvatars(); };
  },
  // 사령관 세션은 이 scope 로 Session 브라우저를 얻는다(server/commodore/session.ts 의 tools.browser). 호스트가 지구본·카드·칸을 그린다.
  sessionBrowser: (ctx) => {
    const params = readParams(ctx.params);
    return params ? { scopeId: `commodore:${params.theaterId}` } : null;
  },
  actions: (ctx) => {
    const params = readParams(ctx.params);
    return params && !params.readOnly ? <CommodoreConversationActions theaterId={params.theaterId} language={ctx.language} /> : null;
  },
  render: (ctx) => {
    const params = readParams(ctx.params);
    return params ? <CommodoreConversationBody theaterId={params.theaterId} readOnly={params.readOnly} language={ctx.language} onBack={ctx.close} /> : null;
  },
  // 이 대화는 그 Theater 의 Inbox 「사령관」 섹션을 대신한다 — 오른쪽 패널이 이 탭들을 Theater 설정 곁의 「사령관」 섹션으로 묶는다.
  theater: (ctx) => {
    const params = readParams(ctx.params);
    return params ? { theaterId: params.theaterId, inboxSection: COMMODORE_INBOX_SECTION_ID } : null;
  },
  tabs: (Object.keys(TAB_IDS) as ConversationTab[]).map((tab) => ({
    id: TAB_IDS[tab],
    inboxPage: TAB_INBOX_PAGES[tab],
    title: (locale) => getT(locale === "ko" ? "ko" : "en")(TAB_TITLES[tab]),
    render: (ctx) => {
      const params = readParams(ctx.params);
      return params ? <CommodoreConversationTab tab={tab} theaterId={params.theaterId} language={ctx.language} /> : null;
    },
  })),
  defaultTab: TAB_IDS.goals,
};
