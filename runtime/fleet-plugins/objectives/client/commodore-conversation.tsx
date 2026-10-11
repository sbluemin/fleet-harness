import { useEffect, useState, useSyncExternalStore } from "react";

import { theaterAvatarKey } from "@fleet-console/sdk/avatars";
import type { Translate } from "@fleet-console/sdk/i18n";
import type { ClientConversationCapability, ConversationSurfaceDescriptor } from "@fleet-console/sdk/plugin";
import type { ClientTheaterInboxCapability } from "@fleet-console/sdk/theater-inbox";

import { errorWord } from "./commodore-chat.js";
import { CommodoreClearButton, CommodoreComposer, CommodoreDirective, CommodoreIntel, CommodoreLog, CommodoreSettings } from "./commodore-inbox-section.js";
import { commodoreMongleState, commodoreSummary } from "./commodore-header.js";
import { CommodoreTrail } from "./commodore-trail.js";
import { COMMODORE_INBOX_SECTION_ID, commodoreTheaterLabel, loadCommodore, loadTranscript, noteCommodoreLanguage, readCommodore, retryCommodore, subscribeCommodore, useCommodore } from "./commodore-state.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { readTheater, subscribeObjective, useObjectiveTheater } from "./objectives-state.js";

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
  return code === "commodore_disabled" ? t("objectives.commodore.failed.disabled") : code === "commodore_inactive" ? t("objectives.commodore.failed.inactive") : t("objectives.commodore.failed", { code });
}

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
  return (
    <div className="objectives-commodore-conversation">
      {/* 맨 위 줄은 가운데 칸의 투명 오버레이다(머리 pill 과 그 옆 기록 비우기 단추가 떠 있다 — descriptor 의 actions) — 기록은 그
          밑으로 흘러 올라간다. 사령관의 지금 상태는 입력 아래 줄이 말한다. 읽기 전용이면 pill 의 부제가 그 사실을 말한다. */}
      {on && (run?.phase === "retrying" || run?.phase === "error") ? (
        <div className="objectives-commodore-retry">
          <span>{run.reason ? errorWord(t, run.reason) : t("objectives.commodore.meta.error")}</span>
          <button type="button" className="objectives-commodore-text-button" onClick={() => { setFailure(null); void retryCommodore(theaterId).catch(fail); }}>{t("objectives.commodore.drawer.retryNow")}</button>
        </div>
      ) : null}
      <div className="objectives-commodore-body is-log">
        <CommodoreLog t={t} language={language} theaterId={theaterId} entries={entries} live={live} hasMore={hasMore} loaded={transcriptLoaded} reveal={reveal} />
      </div>
      {failure ? <p className="objectives-commodore-failure" role="alert">{failure}</p> : null}
      <footer className="objectives-commodore-foot">
        {readOnly
          ? <button type="button" className="objectives-commodore-conversation-back" onClick={onBack}>{t("objectives.commodore.conversation.back")}</button>
          : <CommodoreComposer t={t} theaterId={theaterId} active={view ? view.active : true} context={run?.context} onFail={fail} onClear={() => setFailure(null)} />}
        <span className="objectives-commodore-conversation-status">{[...meta.map((part) => part.text), patrol].filter(Boolean).join(" · ")}</span>
      </footer>
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
      variant="round"
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
    const name = getT(ctx.language)("objectives.commodore.name");
    return label ? `${name} · ${label}` : name;
  },
  subtitle: (ctx) => (readParams(ctx.params)?.readOnly ? getT(ctx.language)("objectives.commodore.conversation.readOnly") : null),
  avatar: (ctx) => {
    const theaterId = readParams(ctx.params)?.theaterId;
    // 얼굴은 사이드바 머리 표식과 같은 사실이다 — 사령관이 턴을 도는 동안 pill 과 오른쪽 패널 머리도 작업 중이다.
    return theaterId ? { key: theaterAvatarKey(theaterId), role: "commodore", label: getT(ctx.language)("objectives.commodore.name"), state: commodoreMongleState(readCommodore(theaterId).view, readTheater(theaterId).objectives) } : null;
  },
  subscribe: (listener) => {
    const offCommodore = subscribeCommodore(listener);
    const offBoard = subscribeObjective(listener);
    return () => { offCommodore(); offBoard(); };
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
