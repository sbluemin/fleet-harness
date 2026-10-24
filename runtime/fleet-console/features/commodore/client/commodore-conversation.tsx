import { commodoreName, useCommodoreName } from "./commodore-name.js";
import { useCommodoreOpenUIPort } from "./openui-ports.js";
import { messageCommodore } from "./commodore-state.js";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { theaterAvatarKey } from "../../workspace/shared/avatars.js";
import type { AgentConversationProps } from "../../execution/shared/chat-renderer.js";
import type { ConversationParticipant, ConversationSpeaker } from "../../execution/shared/conversation/types.js";
import type { Translate } from "@fleet-console/i18n";
import type { ClientConversationCapability, ConversationSurfaceDescriptor } from "../../workspace/shared/conversation-surfaces.js";
import type { ClientTheaterInboxCapability } from "../../workspace/shared/theater-inbox.js";

import { commodoreChatEntries, commodoreConversationEntries, commodoreConversationLiveEntries, commodoreConversationTarget, errorWord } from "./commodore-chat.js";
import { CommodoreAskCards, ENDED_ASK_CODES } from "./commodore-ask.js";
import { attachToCommodoreComposer, CommodoreClearButton, CommodoreComposer, CommodoreDirective, CommodoreIntel, CommodoreSettings } from "./commodore-inbox-section.js";
import { openReferencedObjective, useCommodoreObjectiveIndex, useCommodoreReferenceHost } from "./commodore-reference-input.js";
import { commodoreMongleState, commodoreSummary } from "./commodore-header.js";
import { CommodoreMemory } from "./commodore-memory.js";
import { CommodoreTrail } from "./commodore-trail.js";
import { COMMODORE_INBOX_SECTION_ID, commodoreConversationRenderer, commodoreLedgerRenderer, loadCommodore, loadTranscript, noteCommodoreLanguage, openCommodoreMobile, readCommodore, retryCommodore, subscribeCommodore, useCommodore } from "./commodore-state.js";
import { getT, type CommodoreMessageKey } from "./i18n/index.js";
import { readTheater, subscribeObjective, useObjectiveTheater } from "./board.js";
import { contextsOf, ownerOfContext } from "./commodore-state.js";

type T = Translate<CommodoreMessageKey>;

/**
 * 대화 중심 화면(Console 실험 기능)의 사령관 — 가운데 칸에 기록과 입력이, 오른쪽 패널 앞 묶음에 기록(행위 곁 칸)·지시(정보 포함)·
 * 기억·설정이 선다(Theater 설정 곁의 「사령관」 섹션). 데이터·쓰기 경로는 Inbox 시트와 같은 사령관 상태이고, 여닫기는 SDK 능력
 * (`ctx.conversation`)만 쓴다. 대화 중심 화면에서 Theater 머리나 Inbox 요청이 사령관 기록을 열면 Inbox 섹션의 `openConversation` 이
 * 이 대화를 세운다. 대화 중심 화면이 꺼져 있으면 이 모듈은 아무것도 열지 않고, 머리는 Inbox 시트를 연다.
 */

export const COMMODORE_SURFACE_ID = "commodore";
const TAB_IDS = { goals: "commodore-goals", directive: "commodore-directive", memory: "commodore-memory", settings: "commodore-settings" } as const;
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

/** 가운데 칸의 사령관 대화가 이 Theater 를 가리키는가 — 읽기 전용 기록도 같은 사령관 행을 강조한다. */
export function isCommodoreConversationSelected(theaterId: string): boolean {
  const surface = port?.current();
  const owner = ownerOfContext(theaterId);
  return surface?.surfaceId === COMMODORE_SURFACE_ID && owner !== null && readParams(surface.params)?.commodoreId === owner;
}

/**
 * 가운데 칸에 그 Theater 의 사령관 대화(입력창이 있는 것)가 지금 서 있는가. 읽기 전용 기록은 입력창이 없어 치지 않는다.
 * 호스트의 「붙일 곳」 판정(`ComposerQuoteReceiver.targets` 의 `current`)이 읽는다. 바뀜은 `subscribeCommodoreConversationActive` 가 깨운다.
 */
export function isCommodoreConversationOpen(theaterId: string): boolean {
  const surface = port?.current();
  if (!surface || surface.surfaceId !== COMMODORE_SURFACE_ID) return false;
  const params = readParams(surface.params);
  const owner = ownerOfContext(theaterId);
  return owner !== null && params?.commodoreId === owner && !params.readOnly;
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
export function openCommodoreConversation(commodoreId: string, options: CommodoreConversationOptions = {}): boolean {
  if (!port || !port.isActive() || !commodoreId) return false;
  const theaterId = contextsOf(commodoreId)[0];
  const opened = port.open(COMMODORE_SURFACE_ID, { commodoreId, ...(theaterId ? { theaterId } : {}), ...options });
  if (!opened) return false;
  void loadCommodore(commodoreId);
  if (!readCommodore(commodoreId).transcriptLoaded) void loadTranscript(commodoreId);
  if (options.revealAt !== undefined) revealCommodoreTurn(commodoreId, options.revealAt);
  return true;
}

/**
 * 사령관 기록을 연다 — 대화 중심 화면이면 가운데 대화, 아니면 Theater Inbox 의 사령관 기록 칸(질문 카드가 그 위에 서 있다).
 * 사이드바 「내 결정」의 질문 줄과 확인 필요 행이 부른다.
 */
export function openCommodoreLog(commodoreId: string, theaterId: string | null = null): void {
  if (openCommodoreConversation(commodoreId)) return;
  if (theaterId) inbox?.open({ theaterId, sectionId: "commodore:commodore", pageId: "log" });
}

/* ── 턴 드러내기 — 가운데 기록과 오른쪽 목표 탭이 함께 쓴다 ─────────────── */

let reveal: { readonly commodoreId: string; readonly at: number; readonly nonce: number } | null = null;
const revealListeners = new Set<() => void>();

export function revealCommodoreTurn(commodoreId: string, at: number): void {
  reveal = { commodoreId, at, nonce: (reveal?.nonce ?? 0) + 1 };
  for (const listener of revealListeners) listener();
}

function useCommodoreReveal(theaterId: string) {
  const current = useSyncExternalStore(
    (listener) => { revealListeners.add(listener); return () => { revealListeners.delete(listener); }; },
    () => reveal,
    () => null,
  );
  return current?.commodoreId === theaterId ? current : null;
}

/* ── 사령관 원장 — 가운데 칸의 읽기 전용 턴 기록 ─────────────────────── */

/**
 * 원장을 연 Theater — 그룹 대화의 지휘관 원장처럼 가운데 칸 상태로만, 페이지 수명 동안 쥔다(저장하지 않고 다른 표면과 나누지 않는다).
 * 원장은 채팅뷰와 같은 펼친 턴 기록(`ctx.chat.Transcript` + `commodoreChatEntries`)이다 — 턴 중 주입·대기·다시 실음이 그 어휘로 선다.
 */
const ledgers = new Set<string>();
const ledgerListeners = new Set<() => void>();

function setCommodoreLedger(theaterId: string, open: boolean): void {
  if (ledgers.has(theaterId) === open) return;
  if (open) ledgers.add(theaterId); else ledgers.delete(theaterId);
  for (const listener of ledgerListeners) listener();
}

function useCommodoreLedger(theaterId: string): boolean {
  return useSyncExternalStore(
    (listener) => { ledgerListeners.add(listener); return () => { ledgerListeners.delete(listener); }; },
    () => ledgers.has(theaterId),
    () => false,
  );
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

function readParams(params: Readonly<Record<string, unknown>>): { readonly commodoreId: string; readonly theaterId: string | null; readonly readOnly: boolean } | null {
  if (typeof params.commodoreId !== "string") return null;
  return { commodoreId: params.commodoreId, theaterId: typeof params.theaterId === "string" ? params.theaterId : null, readOnly: params.readOnly === true };
}

function failureWord(t: T, error: unknown): string {
  const code = error instanceof Error ? error.message : "failed";
  if (ENDED_ASK_CODES.has(code)) return errorWord(t, code);
  return code === "commodore_disabled" ? t("commodore.failed.disabled") : code === "commodore_inactive" ? t("commodore.failed.inactive") : t("commodore.failed", { code });
}

/** 드러낼 시각이 읽은 기록 창보다 앞이면 이전 쪽을 이만큼까지 더 읽는다 — 한 요청이 기록 전체를 끌어오지 않게. */
const REVEAL_PAGE_LIMIT = 10;

/**
 * 가운데 칸의 사령관 대화 — Objective 대화와 같은 화면(호스트 `ctx.chat.Conversation`)이다. 사람의 말·사령관의 글은 말풍선,
 * 보드에 쓴 행위는 가운데 행위 줄(펼치면 이유, 누르면 그 목표), 세션 교대·실패는 노트 줄이다. 입력·지우기·읽기 전용 돌아가기는
 * 이 플러그인의 것을 그 화면의 입력 자리에 세운다. 접힌 턴 줄과 곁 칸 이음매는 Inbox 시트의 기록(`CommodoreLog`)에만 남는다.
 */
function CommodoreConversationBody({ commodoreId, theaterId, readOnly, language, onBack }: { readonly commodoreId: string; readonly theaterId: string | null; readonly readOnly: boolean; readonly language: "en" | "ko"; readonly onBack: () => void }) {
  const t = getT(language);
  noteCommodoreLanguage(language);
  const { view, entries, live, hasMore, transcriptLoaded } = useCommodore(commodoreId);
  const board = useObjectiveTheater(commodoreId);
  const reveal = useCommodoreReveal(commodoreId);
  const failure = useConversationFailure(commodoreId);
  const setFailure = (next: string | null) => setConversationFailure(commodoreId, next);
  useEffect(() => {
    void loadCommodore(commodoreId);
    if (!readCommodore(commodoreId).transcriptLoaded) void loadTranscript(commodoreId);
  }, [commodoreId]);
  const fail = (error: unknown) => setFailure(failureWord(t, error));
  const run = view?.run;
  const { meta, patrol } = commodoreSummary(t, view, board.objectives);
  const Conversation = commodoreConversationRenderer();
  const screenTheaterId = theaterId ?? "";
  const index = useCommodoreObjectiveIndex(commodoreId);
  const name = useCommodoreName(screenTheaterId, t);
  const confirmed = useMemo(() => commodoreConversationEntries(t, commodoreId, entries, [], board.objectives, view?.state.asks, index.finished, name), [t, commodoreId, entries, board.objectives, view?.state.asks, index.finished, name]);
  const items = useMemo(() => commodoreConversationLiveEntries(t, entries, live, confirmed, name), [t, entries, live, confirmed, name]);
  // 사령관이 턴을 도는 동안 진행 줄이 서고, 최신 말풍선의 몽글도 작업 중 얼굴이다.
  const turning = run?.phase === "turn";
  const speaker = useMemo<ConversationSpeaker>(() => ({ kind: "commodore", name }), [name]);
  const participants = useMemo<readonly ConversationParticipant[]>(() => [{ speaker, activity: turning ? "running" : "idle" }], [speaker, turning]);
  const working = useMemo<readonly ConversationSpeaker[]>(() => (turning ? [speaker] : []), [speaker, turning]);

  const [loadingOlder, setLoadingOlder] = useState(false);
  const readOlder = () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    void loadTranscript(commodoreId, { older: true }).finally(() => setLoadingOlder(false));
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
  const references = useCommodoreReferenceHost(t, commodoreId);
  const openUIOpen = useCommodoreOpenUIPort(commodoreId);
  // 행위 줄이 여는 목표 — 기록 토큰과 같은 착지(가운데 칸에 그 목표의 대화, 레일의 목표 패널)다. 보드가 열려 있어야만 닿는 reveal 이 아니다.
  const openBoardAction = useMemo<AgentConversationProps["openBoardAction"]>(() => ({
    label: t("commodore.trail.open"),
    open: (entry) => { if (entry.objectiveId && screenTheaterId) openReferencedObjective(screenTheaterId, entry.objectiveId); },
  }), [t, screenTheaterId]);

  // 원장 — 그룹 대화처럼 사령관 이름·진행 줄 표식과 낱말이 연다. 연 순간 도는 턴이 있으면 그 턴을 드러낸다. 원장에 설 턴이 없으면
  // 열 원장이 없으므로 입구를 주지 않는다(눌리는 척하지 않는다). 읽은 창은 아무 줄에서나 시작하므로(쪽·보관 상한) 깨움 줄이 아니라
  // 턴을 이루는 줄과 지금의 실행 상태로 가린다 — 창이 턴 한가운데서 시작해도 도는 턴의 원장은 열린다.
  const Ledger = commodoreLedgerRenderer();
  const ledgerOpen = useCommodoreLedger(commodoreId) && Ledger !== null;
  const hasTurn = turning || entries.some((entry) => entry.kind === "wake" || entry.kind === "text" || entry.kind === "tool" || entry.kind === "result" || entry.kind === "ask");
  // 도는 턴의 시작 — 그 깨움이 창 밖이면 창의 첫 줄에서 그 턴이 이어진다(`commodoreChatEntries` 가 거기서 턴을 연다).
  const runningAt = turning ? entries.findLast((entry) => entry.kind === "wake")?.at ?? entries[0]?.at : undefined;
  const [ledgerReveal, setLedgerReveal] = useState<{ readonly at: number; readonly nonce: number } | null>(null);
  const showInLedger = (at: number) => setLedgerReveal((previous) => ({ at, nonce: (previous?.nonce ?? 0) + 1 }));
  const openLedger = useMemo<AgentConversationProps["openLedger"]>(() => (hasTurn && Ledger ? () => {
    if (runningAt !== undefined) showInLedger(runningAt); else setLedgerReveal(null);
    setCommodoreLedger(commodoreId, true);
  } : null), [hasTurn, Ledger, runningAt, commodoreId]);
  // 원장이 열린 채 곁 칸·목표 대화가 턴을 가리키면 그 요청은 원장이 받는다 — 대화는 지금 그려지지 않는다. 앞쪽 읽기는 위의 같은 효과가 맡는다.
  useEffect(() => {
    if (reveal && ledgerOpen) showInLedger(reveal.at);
  }, [reveal?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps -- 새 요청(nonce)에만 옮긴다.
  const ledgerEntries = useMemo(() => (ledgerOpen ? commodoreChatEntries(t, commodoreId, entries, live, view?.state.asks, index) : []), [ledgerOpen, t, commodoreId, entries, live, view?.state.asks, index]);
  // 원장 바닥 줄의 좌표 — 그 세션이 실제로 도는 모델·강도다(Objective 원장이 세션 payload 의 좌표를 그리는 것과 같다). 열린 세션이면
  // 감독자가 푼 좌표, 아니면 기록의 마지막 세션 줄. 설정값으로 대신하지 않는다 — 설정은 다음 교대에서야 세션이 된다. 모르면 그리지 않는다.
  const lastSession = useMemo(() => entries.findLast((entry) => entry.kind === "session" && entry.model !== undefined), [entries]);
  const ledgerCoordinates = useMemo(() => {
    const live = run?.session;
    if (live) return { model: live.model, effort: live.effort ?? null };
    return lastSession?.kind === "session" && lastSession.model ? { model: lastSession.model, effort: lastSession.effort ?? null } : null;
  }, [run?.session, lastSession]);

  // 답 단추는 기존 사령관 메시지 API로 보낸다. 초안은 건드리지 않으며 읽기 전용이면 전송 포트를 주지 않는다.
  const sendOpenUI = useCallback((text: string) => { void messageCommodore(commodoreId, text).catch(() => {}); }, [commodoreId]);
  // 사령관의 지금 상태는 빈 입력의 자리표가 말한다. 읽기 전용이면 입력 대신 돌아가기가 선다.
  const composer = (
    <footer className="objectives-commodore-foot">
      {failure ? <p className="objectives-commodore-failure" role="alert">{failure}</p> : null}
      {readOnly
        ? <button type="button" className="objectives-commodore-conversation-back" onClick={onBack}>{t("commodore.conversation.back")}</button>
        : <CommodoreComposer t={t} theaterId={commodoreId} active={view?.boardReady === true && view.enabled} context={run?.context} placeholder={[...meta.map((part) => part.text), patrol].filter(Boolean).join(" · ")} onFail={fail} onClear={() => setFailure(null)} />}
    </footer>
  );
  return (
    <div className="objectives-commodore-conversation">
      {/* 맨 위 줄은 가운데 칸의 투명 오버레이다(머리 pill 과 그 옆 기록 비우기 단추가 떠 있다 — descriptor 의 actions) — 대화는 그
          밑으로 흘러 올라간다. */}
      {(run?.phase === "retrying" || run?.phase === "error") ? (
        <div className="objectives-commodore-retry">
          <span>{run.reason ? errorWord(t, run.reason) : t("commodore.meta.error")}</span>
          <button type="button" className="objectives-commodore-text-button" onClick={() => { setFailure(null); void retryCommodore(commodoreId).catch(fail); }}>{t("commodore.drawer.retryNow")}</button>
        </div>
      ) : null}
      {ledgerOpen && Ledger ? (
        // 그룹 대화가 지휘관 원장을 여는 그 틀·본문·바닥 줄(호스트 `ctx.chat.Ledger`)이다. 이 상자는 머리 pill 오버레이 밑자리만 진다.
        <div className="objectives-commodore-ledger" data-commodore-ledger="">
          <Ledger
            speaker={speaker}
            theaterId={screenTheaterId}
            language={language}
            onBack={() => setCommodoreLedger(commodoreId, false)}
            entries={ledgerEntries}
            reveal={ledgerReveal}
            older={hasMore ? { label: t("commodore.log.older"), loading: loadingOlder, load: readOlder } : null}
            references={references} openUIOpen={openUIOpen}
            coordinates={ledgerCoordinates}
            openui
          />
        </div>
      ) : (
      <div className="objectives-commodore-conversation-log">
        {Conversation ? (
          <Conversation
            entries={items}
            participants={participants}
            working={working}
            language={language}
            theaterId={screenTheaterId}
            loading={!transcriptLoaded}
            empty={t("commodore.log.empty")}
            older={hasMore ? { label: t("commodore.log.older"), loading: loadingOlder, load: readOlder } : null}
            reveal={revealEntry}
            openBoardAction={openBoardAction}
            openLedger={openLedger}
            references={references} openUIOpen={openUIOpen}
            cards={readOnly ? null : <CommodoreAskCards theaterId={commodoreId} t={t} language={language} onEnded={fail} />}
            composer={composer}
            composerTopEntries={!readOnly}
            {...(readOnly ? {} : { onOpenUISend: sendOpenUI })}
          />
        ) : composer}
      </div>
      )}
    </div>
  );
}

/** 머리 pill 안의 기록 비우기 — 사령관 원장은 구성원 턴 접기 없이 서며, 실패는 가운데 본문의 실패 줄이 말한다. */
function CommodoreConversationActions({ commodoreId, language }: { readonly commodoreId: string; readonly language: "en" | "ko" }) {
  const t = getT(language);
  return (
    <CommodoreClearButton
      t={t}
      theaterId={commodoreId}
      variant="caption"
      onFail={(error) => setConversationFailure(commodoreId, failureWord(t, error))}
      onClear={() => setConversationFailure(commodoreId, null)}
    />
  );
}

/* ── 오른쪽 패널 탭 ────────────────────────────────────────────────────── */

function CommodoreConversationTab({ tab, commodoreId, theaterId, language }: { readonly tab: ConversationTab; readonly commodoreId: string; readonly theaterId: string | null; readonly language: "en" | "ko" }) {
  const t = getT(language);
  const { view } = useCommodore(commodoreId);
  const [failure, setFailure] = useState<string | null>(null);
  const fail = (error: unknown) => setFailure(failureWord(t, error));
  const clear = () => setFailure(null);
  if (tab === "goals") {
    return (
      <div className="objectives-commodore-conversation-tab is-goals">
        <CommodoreTrail t={t} language={language} theaterId={commodoreId} onReveal={(at) => revealCommodoreTurn(commodoreId, at)} />
      </div>
    );
  }
  if (!view) return null;
  return (
    <div className="objectives-commodore-body objectives-commodore-conversation-tab">
      {tab === "directive" ? (
        <>
          <CommodoreDirective t={t} theaterId={commodoreId} directive={view.state.directive} active={view.active} onOpenSystemPrompt={() => { if (theaterId) inbox?.open({ theaterId, sectionId: THEATER_SETTINGS_SECTION, pageId: THEATER_SYSTEM_PROMPT_PAGE, focus: "editor-end" }); }} onFail={fail} onClear={clear} />
          <CommodoreIntel t={t} theaterId={commodoreId} intel={view.state.intel} sources={view.state.sources} onFail={fail} onClear={clear} />
        </>
      ) : null}
      {tab === "memory" ? <CommodoreMemory t={t} theaterId={commodoreId} /> : null}
      {tab === "settings" ? <CommodoreSettings t={t} language={language} theaterId={commodoreId} view={view} onFail={fail} onClear={clear} /> : null}
      {failure ? <p className="objectives-commodore-failure" role="alert">{failure}</p> : null}
    </div>
  );
}

/** 탭이 대신하는 Theater Inbox 사령관 칸 — 그 칸을 여는 요청(지시 링크 등)이 대화 중심 화면에서 이 탭을 연다. 기록은 가운데 칸이다. */
const TAB_INBOX_PAGES = { goals: "log", directive: "directive", memory: "memory", settings: "settings" } as const;

const TAB_TITLES: Record<ConversationTab, CommodoreMessageKey> = {
  goals: "commodore.tabs.log",
  directive: "commodore.tabs.directive",
  memory: "commodore.tabs.memory",
  settings: "commodore.tabs.settings",
};

/** Console 이 가운데 칸·오른쪽 패널에 세우는 사령관 대화. */
export const commodoreConversationSurface: ConversationSurfaceDescriptor = {
  id: COMMODORE_SURFACE_ID,
  title: (ctx) => {
    const theaterId = readParams(ctx.params)?.theaterId ?? "";
    return commodoreName(theaterId, getT(ctx.language));
  },
  subtitle: (ctx) => (readParams(ctx.params)?.readOnly ? getT(ctx.language)("commodore.conversation.readOnly") : null),
  avatar: (ctx) => {
    const params = readParams(ctx.params);
    const theaterId = params?.theaterId;
    return theaterId ? { key: theaterAvatarKey(theaterId), role: "commodore", label: commodoreName(theaterId, getT(ctx.language)), state: commodoreMongleState(readCommodore(params.commodoreId).view, readTheater(params.commodoreId).objectives) } : null;
  },
  subscribe: (listener) => {
    const offCommodore = subscribeCommodore(listener);
    const offBoard = subscribeObjective(listener);
    return () => { offCommodore(); offBoard(); };
  },
  // 사령관 세션은 이 scope 로 Session 브라우저를 얻는다(Console 사령관 feature의 tools.browser). 호스트가 지구본·카드·칸을 그린다.
  sessionBrowser: (ctx) => {
    const params = readParams(ctx.params);
    if (!params) return null;
    // 플릿 브라우저의 주석·스크린샷은 이 대화의 사령관 입력창에 붙는다 — 읽기 전용(보관) 대화에는 입력창이 없다.
    return { scopeId: `commodore:${params.commodoreId}`, ...(params.readOnly || !params.theaterId ? {} : { attach: (files: readonly File[]) => attachToCommodoreComposer(params.commodoreId, files) }) };
  },
  actions: (ctx) => {
    const params = readParams(ctx.params);
    return params && !params.readOnly ? <CommodoreConversationActions commodoreId={params.commodoreId} language={ctx.language} /> : null;
  },
  render: (ctx) => {
    const params = readParams(ctx.params);
    return params ? <CommodoreConversationBody commodoreId={params.commodoreId} theaterId={params.theaterId} readOnly={params.readOnly} language={ctx.language} onBack={ctx.close} /> : null;
  },
  // 이 대화는 그 Theater 의 Inbox 「사령관」 섹션을 대신한다 — 오른쪽 패널이 이 탭들을 Theater 설정 곁의 「사령관」 섹션으로 묶는다.
  theater: (ctx) => {
    const params = readParams(ctx.params);
    return params?.theaterId ? { theaterId: params.theaterId, inboxSection: COMMODORE_INBOX_SECTION_ID } : null;
  },
  tabs: (Object.keys(TAB_IDS) as ConversationTab[]).map((tab) => ({
    id: TAB_IDS[tab],
    inboxPage: TAB_INBOX_PAGES[tab],
    // 「기록」의 목표 흔적은 스스로 스크롤하며 바닥에 붙는다 — 칸 전체를 받는다. 나머지 탭은 호스트 읽기 열에 선다.
    ...(tab === "goals" ? { layout: "fill" as const } : {}),
    title: (locale) => getT(locale === "ko" ? "ko" : "en")(TAB_TITLES[tab]),
    render: (ctx) => {
      const params = readParams(ctx.params);
      return params ? <CommodoreConversationTab tab={tab} commodoreId={params.commodoreId} theaterId={params.theaterId} language={ctx.language} /> : null;
    },
  })),
  defaultTab: TAB_IDS.goals,
  onLeaveDesktop: ({ params, tabId }) => {
    const target = readParams(params);
    if (!target || target.readOnly) return;
    const tab = (Object.keys(TAB_IDS) as ConversationTab[]).find((candidate) => TAB_IDS[candidate] === tabId);
    // 「기록」 탭은 목표 흔적이다 — 폰에는 같은 흔적을 그리는 「목표」 탭이 따로 있다(기록은 가운데 대화).
    openCommodoreMobile(tab === "goals" ? "goals" : tab ? TAB_INBOX_PAGES[tab] : "log", target.theaterId, tab !== undefined);
  },
};
