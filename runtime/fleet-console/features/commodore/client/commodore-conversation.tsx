import { CommodorePeerLedger, commodoreParticipants } from "./commodore-peer-ledger.js";
import { useCommodoreOpenUIPort } from "./openui-ports.js";
import { commodoreName, messageCommodore, renameCommodore, useCommodoreName } from "./commodore-state.js";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { commodoreAvatarKey } from "../../workspace/shared/avatars.js";
import type { AgentConversationProps } from "../../execution/shared/chat-renderer.js";
import type { ConversationParticipant, ConversationSpeaker } from "../../execution/shared/conversation/types.js";
import type { Translate } from "@fleet-console/i18n";
import type { ClientConversationCapability, ConversationSurfaceDescriptor } from "../../workspace/shared/conversation-surfaces.js";
import type { ClientTheaterInboxCapability } from "../../workspace/shared/theater-inbox.js";

import { commodoreChatEntries, commodoreCliFailure, commodoreConsultationCutoff, commodoreConversationEntries, commodoreConversationLiveEntries, commodoreConversationTarget, errorWord } from "./commodore-chat.js";
import { ENDED_ASK_CODES } from "./commodore-ask.js";
import { useCommodoreDecisionDock } from "./commodore-person-inbox.js";
import { attachToCommodoreComposer, CommodoreClearButton, CommodoreComposer, CommodoreDescription, CommodoreIntel } from "./commodore-inbox-section.js";
import { CommodoreCliFailureCard } from "./commodore-cli-status.js";
import { commodoreCliCause } from "../shared/contracts/cli-status.js";
import { CommodoreComposerSettings, requestCommodoreComposerSettings, type CommodoreComposerSettingsSection } from "./commodore-composer-settings.js";
import { openReferencedObjective, useCommodoreObjectiveIndex, useCommodoreReferenceHost } from "./commodore-reference-input.js";
import { commodoreMongleState, commodoreSummary } from "./commodore-header.js";
import { useCommodoreMongleActivity } from "./commodore-avatar.js";
import { CommodoreMapScreen } from "./commodore-map/map-view.js";
import { CommodoreMapToggle } from "./commodore-map-toggle.js";
import { mapPanelFacts } from "./commodore-map/map-panel.js";
import { readCommodoreMapMode, requestCommodoreMapEdit, setCommodoreMapMode, setCommodoreMapSelection, subscribeCommodoreMapMode, useCommodoreMapEditRequest, useCommodoreMapMode } from "./commodore-map-mode.js";
import { COMMODORE_INBOX_SECTION_ID, commodoreConversationRenderer, commodoreLedgerRenderer, loadCommodore, loadTranscript, noteCommodoreLanguage, openCommodoreMobile, readCommodore, retryCommodore, retryCommodoreNewSession, skipCommodoreFailed, subscribeCommodore, transcriptNeeded, useCommodore, useCommodoreMemory } from "./commodore-state.js";
import { getConversationSurface, useConversationSurface } from "../../workspace/client/conversation/conversation-surface-store.js";
import { useConversationDockHeight } from "../../workspace/client/conversation/conversation-dock-height.js";
import { getConversationSubject } from "../../workspace/client/conversation/conversation-slots.js";
import { revealContextExtra } from "../../workspace/client/conversation/context-rail/store.js";
import { getState } from "../../../core/client/src/integration/store.js";
import { useTheaterInboxState } from "../../workspace/client/theater-inbox/store.js";
import { readCommodoreList, setZoneCommodore, useZoneCommodore } from "./commodore-list.js";
import { useCommodoreSpeakerSection } from "./sidebar-sections.js";
import { getT, type CommodoreMessageKey } from "./i18n/index.js";
import { readTheater, subscribeObjective, useObjectiveTheater } from "./board.js";

type T = Translate<CommodoreMessageKey>;

/**
 * 대화 중심 화면(Console 실험 기능)의 사령관 — 가운데 칸에 기록과 입력이 서고, 우측 사이드바 없이 채팅창 내부에
 * 정체성(상단 pill 프로필 팝오버), 목표·루틴(우측 부유 엣지 스택), 신경망 상세(지도 무대 안 부유 글래스 인스펙터)가 통합된다.
 * 데이터·쓰기 경로는 Inbox 시트와 같은 사령관 상태이고, 여닫기는 SDK 능력(`ctx.conversation`)만 쓴다.
 */

export const COMMODORE_SURFACE_ID = "commodore";
/** 퇴역한 사령관 우측 사이드바 탭 id — 옛 Console 이 넘긴 사이드바 상태는 무시한다. */
const RETIRED_COMMODORE_TABS = new Set(["commodore-routines", "commodore-info"]);

/** 옛 Console 이 넘긴 퇴역 사령관 사이드바 탭이면 null, 그 밖에는 그대로 돌려준다. */
export function commodoreRailTab(tabId: string): string | null {
  return RETIRED_COMMODORE_TABS.has(tabId) ? null : tabId;
}

let port: ClientConversationCapability | null = null;
let inbox: ClientTheaterInboxCapability | null = null;

/**
 * 설치 때 받은 능력을 쥔다. 구버전 호스트(능력 없음)면 대화 중심 화면은 없는 것으로 다룬다. Theater Inbox 능력은
 * 대화 배치가 아닐 때 사령관 기록 칸을 여는 데 쓴다.
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
  /** 팔레트 이동은 열린 대화의 컴포저로 키보드 포커스를 넘긴다. */
  readonly focusComposer?: boolean;
  /** 목표 대화에서 행위 기록을 보러 온 것 — 입력 대신 돌아가기만 선다. */
  readonly readOnly?: boolean;
  readonly objectiveId?: string;
  /** 채팅 대신 신경망(지도)으로 시작한다 — `node` 는 고를 노드 id, null 이면 고르지 않은 요약이다. */
  readonly map?: { readonly node: string | null };
}

/** 호스트의 대화 배치 여부 — Theater 머리의 첫 칸 판정도 같은 능력을 읽는다. */
export function isCommodoreConversationActive(): boolean {
  return port?.isActive() === true;
}

/** 대화 배치 여부가 바뀌면 깨운다 — 능력이 없는 호스트에서는 아무것도 하지 않는다. */
export function subscribeCommodoreConversationActive(listener: () => void): () => void {
  return port?.subscribe(listener) ?? (() => {});
}

/**
 * 가운데 칸이 이 사령관을 가리키는가. 사령관 대화뿐 아니라 그 사령관의 지휘관 대화도 사이드바 줄을 강조한다.
 * 표면이 서 있으면 그 표면의 사령관만 본다. 없으면 열린 Objective 의 소유 사령관을 본다.
 */
export function isCommodoreConversationSelected(commodoreId: string): boolean {
  const owner = commodoreId;
  const surface = getConversationSurface();
  if (surface) return readParams(surface.params)?.commodoreId === owner;
  const subject = getConversationSubject() ?? getState().objectiveRecords.find((record) => record.id === getState().activeObjectiveId);
  return subject?.commodoreId === owner;
}

/**
 * 가운데 칸에 그 사령관의 대화(입력창이 있는 것)가 지금 서 있는가. 읽기 전용 기록은 입력창이 없어 치지 않는다.
 * 호스트의 「붙일 곳」 판정(`ComposerQuoteReceiver.targets` 의 `current`)이 읽는다. 바뀜은 `subscribeCommodoreConversationActive` 가 깨운다.
 */
export function isCommodoreConversationOpen(commodoreId: string): boolean {
  const surface = port?.current();
  if (!surface || surface.surfaceId !== COMMODORE_SURFACE_ID) return false;
  const params = readParams(surface.params);
  return params?.commodoreId === commodoreId && !params.readOnly;
}

/** 대화 배치 여부를 따라 다시 그리는 훅 — 대화 배치의 구독자가 현재 표면을 다시 읽는다. */
export function useCommodoreConversationActive(): boolean {
  return useSyncExternalStore(
    subscribeCommodoreConversationActive,
    isCommodoreConversationActive,
    () => false,
  );
}

/**
 * 빈 상태의 「Theater 추가」·만들기 창 착지·옛 설정 주소가 간다 — 사령관 대화를 세우고 그 입력창의 설정 칸을 연다(기본은 작전 구역 칸).
 * 대화 배치 밖(모바일 등)에서는 대화가 서지 않아 false를 돌려준다.
 */
export function openCommodoreTheaterSettings(commodoreId: string, section: CommodoreComposerSettingsSection = "theaters"): boolean {
  if (!isCommodoreConversationOpen(commodoreId) && !openCommodoreConversation(commodoreId)) return false;
  requestCommodoreComposerSettings(commodoreId, section);
  return true;
}

const COMMODORE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 사령관 자기 Theater 목록의 첫 Theater — 사령관에서 Theater 로 가는 방향만 쓴다. 없으면 undefined. */
export function commodoreHomeTheater(commodoreId: string): string | undefined {
  return readCommodoreList().find((row) => row.commodoreId === commodoreId)?.theaters.find((theater) => theater.theaterId)?.theaterId ?? undefined;
}
/** 가운데 칸에 그 Theater 의 사령관을 세운다. 대화 중심 화면이 꺼져 있으면 false — 부르는 쪽이 시트로 돌아간다. Theater id는 UUID가 아니라 여기서 거절한다. */
export function openCommodoreConversation(commodoreId: string, options: CommodoreConversationOptions = {}): boolean {
  if (!port || !port.isActive() || !COMMODORE_UUID.test(commodoreId)) return false;
  // 그 사령관 자기 Theater 목록의 첫 Theater 를 대화 파라미터에 둔다. 패널이 열리는 화면 Theater는 이 값이다.
  // 섹션 문맥은 theater()가 사령관 UUID로 돌려 주고, Inbox도 그 UUID를 쓴다.
  const theaterId = commodoreHomeTheater(commodoreId);
  const opened = port.open(COMMODORE_SURFACE_ID, { ...options, commodoreId, ...(theaterId ? { theaterId } : {}) });
  if (!opened) return false;
  void loadCommodore(commodoreId);
  if (transcriptNeeded(commodoreId)) void loadTranscript(commodoreId);
  if (options.revealAt !== undefined) revealCommodoreTurn(commodoreId, options.revealAt);
  return true;
}

/**
 * 사령관 대화를 세우고 우측 부유 엣지 스택의 목표 플라이아웃을 연다. 대화 중심 화면이 꺼져 있으면 아무것도 하지 않는다.
 */
export function openCommodoreTasksPanel(commodoreId: string): void {
  if (!isCommodoreConversationOpen(commodoreId) && !openCommodoreConversation(commodoreId)) return;
  revealContextExtra("goals");
}

/**
 * 사령관 대화를 세우고 신경망(지도)으로 바꿔 `nodeId` 노드를 고른다 — null 이면 고르지 않은 요약이다. 없어진 「정보」 칸 주소(설명·정보·기억)가
 * 이리로 온다. 대화 중심 화면이 꺼져 있으면 false 다.
 */
export function openCommodoreMap(commodoreId: string, nodeId: string | null): boolean {
  // 새로 서는 대화는 본문이 마운트하며 이 값으로 시작하고, 이미 선 대화는 아래에서 곧장 바꾼다.
  if (!openCommodoreConversation(commodoreId, { map: { node: nodeId } })) return false;
  setCommodoreMapMode(commodoreId, "map");
  setCommodoreMapSelection(commodoreId, nodeId);
  return true;
}

/**
 * 사령관 기록을 연다 — 대화 중심 화면이면 가운데 대화, 아니면 Theater Inbox 의 사령관 기록 칸(질문 카드가 그 위에 서 있다).
 * 사이드바 「내 결정」의 질문 줄과 확인 필요 행이 부른다.
 */
export function openCommodoreLog(commodoreId: string, theaterId: string | null = null): void {  if (openCommodoreConversation(commodoreId)) return;
  if (theaterId) inbox?.open({ theaterId, sectionId: "commodore:commodore", pageId: "log" });
}

/**
 * 지금 다루는 사령관(작전 구역 사령관)을 따라 둔다 — 가운데 칸에 선 사령관 대화가 먼저, 대화가 없으면 기억한 사령관, 그다음 열린
 * Inbox 의 사령관이다. 새 세션 진입이 이 값을 읽는다. Theater 목록은 설정 탭 맨 위에 있어 따로 탭을 세우지 않는다.
 */
export function CommodoreZoneHost(): null {
  const selection = useConversationSurface();
  const inbox = useTheaterInboxState();
  const zone = useZoneCommodore();
  const fromSelection = selection?.surfaceId === COMMODORE_SURFACE_ID && typeof selection.params.commodoreId === "string" ? selection.params.commodoreId : null;
  const fromInbox = inbox !== null && COMMODORE_UUID.test(inbox.theaterId) ? inbox.theaterId : null;
  const commodoreId = fromSelection ?? (selection === null ? zone ?? fromInbox : fromInbox);
  useEffect(() => {
    if (commodoreId && COMMODORE_UUID.test(commodoreId)) setZoneCommodore(commodoreId);
  }, [commodoreId]);
  useEffect(() => {
    const onOpenPool = () => {
      const target = (commodoreId && COMMODORE_UUID.test(commodoreId) ? commodoreId : null)
        ?? readCommodoreList().find((row) => COMMODORE_UUID.test(row.commodoreId))?.commodoreId;
      if (!target) return;
      openCommodoreTheaterSettings(target, "pool");
    };
    window.addEventListener("fleet:open-routing-pool", onOpenPool);
    return () => window.removeEventListener("fleet:open-routing-pool", onOpenPool);
  }, [commodoreId]);
  return null;
}

/* ── 턴 드러내기 — 가운데 기록과 사령관 패널이 함께 쓴다 ─────────────── */

let reveal: { readonly commodoreId: string; readonly at: number; readonly nonce: number } | null = null;
const revealListeners = new Set<() => void>();

export function revealCommodoreTurn(commodoreId: string, at: number): void {
  reveal = { commodoreId, at, nonce: (reveal?.nonce ?? 0) + 1 };
  for (const listener of revealListeners) listener();
}

/** 대화가 줄을 찾은 요청. 저장소를 비우지 않는다 — 지금 인스턴스의 표시를 지우지 않고, 다음 마운트만 거른다. */
let consumedRevealNonce = -1;

function consumeCommodoreReveal(nonce: number): void {
  consumedRevealNonce = nonce;
}

function useCommodoreReveal(theaterId: string) {
  const current = useSyncExternalStore(
    (listener) => { revealListeners.add(listener); return () => { revealListeners.delete(listener); }; },
    () => reveal,
    () => null,
  );
  return current?.commodoreId === theaterId && current.nonce !== consumedRevealNonce ? current : null;
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

function readParams(params: Readonly<Record<string, unknown>>): { readonly commodoreId: string; readonly theaterId: string | null; readonly readOnly: boolean; readonly map: { readonly node: string | null } | null } | null {
  if (typeof params.commodoreId !== "string") return null;
  const map = typeof params.map === "object" && params.map !== null ? params.map as { readonly node?: unknown } : null;
  return {
    commodoreId: params.commodoreId,
    theaterId: typeof params.theaterId === "string" ? params.theaterId : null,
    readOnly: params.readOnly === true,
    map: map ? { node: typeof map.node === "string" ? map.node : null } : null,
  };
}

function failureWord(t: T, error: unknown): string {
  const code = error instanceof Error ? error.message : "failed";
  if (ENDED_ASK_CODES.has(code)) return errorWord(t, code);
  return code === "commodore_disabled" ? t("commodore.failed.disabled") : code === "commodore_inactive" ? t("commodore.failed.inactive") : t("commodore.failed", { code });
}

/** 목표의 그룹 대화도 소유 사령관의 설정을 편집한다. 실행 중인 지휘관 세션의 좌표와는 별개다. */
export function CommodoreGroupComposerSettings({ commodoreId, language, onFailure }: {
  readonly commodoreId: string;
  readonly language: "en" | "ko";
  readonly onFailure: (message: string | null) => void;
}) {
  const { view } = useCommodore(commodoreId);
  const t = getT(language);
  useEffect(() => { void loadCommodore(commodoreId); }, [commodoreId]);
  return view ? <CommodoreComposerSettings t={t} commodoreId={commodoreId} view={view} onFail={(error) => onFailure(failureWord(t, error))} onClear={() => onFailure(null)} /> : null;
}

/** 드러낼 시각이 읽은 기록 창보다 앞이면 이전 쪽을 이만큼까지 더 읽는다 — 한 요청이 기록 전체를 끌어오지 않게. */
const REVEAL_PAGE_LIMIT = 10;

/**
 * 가운데 칸의 사령관 대화 — Objective 대화와 같은 화면(호스트 `ctx.chat.Conversation`)이다. 사람의 말·사령관의 글은 말풍선,
 * 보드에 쓴 행위는 가운데 행위 줄(펼치면 이유, 누르면 그 목표), 세션 교대·실패는 노트 줄이다. 입력·지우기·읽기 전용 돌아가기는
 * 이 플러그인의 것을 그 화면의 입력 자리에 세운다. 접힌 턴 줄과 곁 칸 이음매는 Inbox 시트의 기록(`CommodoreLog`)에만 남는다.
 */
function CommodoreConversationBody({ commodoreId, theaterId, readOnly, startMap, language, onBack }: { readonly commodoreId: string; readonly theaterId: string | null; readonly readOnly: boolean; readonly startMap: { readonly node: string | null } | null; readonly language: "en" | "ko"; readonly onBack: () => void }) {
  const t = getT(language);
  noteCommodoreLanguage(language);
  const { view, entries, live, hasMore, transcriptLoaded, transcriptError, clearedAt } = useCommodore(commodoreId);
  const board = useObjectiveTheater(commodoreId);
  const reveal = useCommodoreReveal(commodoreId);
  const failure = useConversationFailure(commodoreId) ?? (transcriptError ? failureWord(t, new Error(transcriptError)) : null);
  const setFailure = (next: string | null) => setConversationFailure(commodoreId, next);
  useEffect(() => {
    void loadCommodore(commodoreId);
    if (transcriptNeeded(commodoreId)) void loadTranscript(commodoreId);
  }, [commodoreId]);
  // 다시 들어오면 채팅으로 시작한다 — 신경망으로 연 대화(없어진 「정보」 칸 주소)만 신경망에서 그 노드를 고른 채 시작한다.
  const startMapRef = useRef(startMap);
  startMapRef.current = startMap;
  useEffect(() => {
    const landing = startMapRef.current;
    if (!landing) { setCommodoreMapMode(commodoreId, "chat"); return; }
    setCommodoreMapMode(commodoreId, "map");
    setCommodoreMapSelection(commodoreId, landing.node);
  }, [commodoreId]);
  const fail = (error: unknown) => setFailure(failureWord(t, error));
  const run = view?.run;
  const { meta, routine } = commodoreSummary(t, view, board.objectives);
  const Conversation = commodoreConversationRenderer();
  const speakerSection = useCommodoreSpeakerSection(commodoreId);
  const screenTheaterId = theaterId ?? "";
  const index = useCommodoreObjectiveIndex(commodoreId);
  const name = useCommodoreName(commodoreId, t);
  const consultationCutoff = commodoreConsultationCutoff(view, clearedAt);
  const confirmed = useMemo(() => commodoreConversationEntries(t, commodoreId, entries, [], board.objectives, view?.state.asks, index.finished, name, consultationCutoff), [t, commodoreId, entries, board.objectives, view?.state.asks, index.finished, name, consultationCutoff]);
  const items = useMemo(() => commodoreConversationLiveEntries(t, entries, live, confirmed, name, commodoreId), [t, entries, live, confirmed, name, commodoreId]);
  // 사령관이 턴을 도는 동안 진행 줄이 서고, 최신 말풍선의 몽글도 작업 중 얼굴이다.
  const turning = run?.phase === "turn";
  const speaker = useMemo<ConversationSpeaker>(() => ({ kind: "commodore", name, commodoreId }), [name, commodoreId]);
  const participants = useMemo<readonly ConversationParticipant[]>(() => commodoreParticipants(speaker, turning, confirmed), [speaker, turning, confirmed]);
  const [peerLedger, setPeerLedger] = useState<ConversationSpeaker | null>(null);
  useEffect(() => setPeerLedger(null), [commodoreId]);
  const working = useMemo<readonly ConversationSpeaker[]>(() => (turning ? [speaker] : []), [speaker, turning]);
  // 진행 줄의 이름 뒤 낱말 — 아바타가 연기하는 것과 같은 턴의 계열이다.
  const activity = useCommodoreMongleActivity(turning ? commodoreId : null);
  const dockRef = useRef<HTMLElement | null>(null);
  useConversationDockHeight(dockRef);

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
  const revealEntry = useMemo<AgentConversationProps["reveal"]>(() => (reveal && target ? {
    entryId: target,
    nonce: reveal.nonce,
    // 대화가 그 줄을 찾은 뒤에만 소비한다. 데이터에 id 가 있어도 아직 노드가 없으면 요청은 남는다.
    applied: () => consumeCommodoreReveal(reveal.nonce),
  } : null), [reveal, target]);
  const references = useCommodoreReferenceHost(t, commodoreId);
  const openUIOpen = useCommodoreOpenUIPort(commodoreId, undefined, openCommodoreConversation);
  // 행위 줄과 기록 참조는 가운데 칸의 목표 대화로 간다. 우측 사령관 패널의 열림은 바꾸지 않는다.
  const openBoardAction = useMemo<AgentConversationProps["openBoardAction"]>(() => ({
    label: t("commodore.trail.open"),
    open: (entry) => {
      if (entry.objectiveId.startsWith("commodore:")) references.open?.(entry.objectiveId);
      else if (entry.objectiveId && screenTheaterId) openReferencedObjective(screenTheaterId, entry.objectiveId);
    },
  }), [t, screenTheaterId, references]);

  // 원장 — 그룹 대화처럼 사령관 이름·진행 줄 표식과 낱말이 연다. 연 순간 도는 턴이 있으면 그 턴을 드러낸다. 원장에 설 턴이 없으면
  // 열 원장이 없으므로 입구를 주지 않는다(눌리는 척하지 않는다). 읽은 창은 아무 줄에서나 시작하므로(쪽·보관 상한) 깨움 줄이 아니라
  // 턴을 이루는 줄과 지금의 실행 상태로 가린다 — 창이 턴 한가운데서 시작해도 도는 턴의 원장은 열린다.
  const Ledger = commodoreLedgerRenderer();
  const ledgerOpen = useCommodoreLedger(commodoreId) && Ledger !== null;
  // 원장이 대화를 대신 그릴 때는 GroupConversation 의 applied 가 없다. 줄이 잡힌 뒤에만 소비한다.
  useEffect(() => {
    if (!reveal || !ledgerOpen || target === null) return;
    const nonce = reveal.nonce;
    const frame = requestAnimationFrame(() => consumeCommodoreReveal(nonce));
    return () => cancelAnimationFrame(frame);
  }, [reveal, ledgerOpen, target]);
  const hasTurn = turning || entries.some((entry) => entry.kind === "wake" || entry.kind === "text" || entry.kind === "tool" || entry.kind === "result" || entry.kind === "ask");
  // 도는 턴의 시작 — 그 깨움이 창 밖이면 창의 첫 줄에서 그 턴이 이어진다(`commodoreChatEntries` 가 거기서 턴을 연다).
  const runningAt = turning ? entries.findLast((entry) => entry.kind === "wake")?.at ?? entries[0]?.at : undefined;
  const [ledgerReveal, setLedgerReveal] = useState<{ readonly at: number; readonly nonce: number } | null>(null);
  const showInLedger = (at: number) => setLedgerReveal((previous) => ({ at, nonce: (previous?.nonce ?? 0) + 1 }));
  const openLedger = useMemo<AgentConversationProps["openLedger"]>(() => ((hasTurn || participants.length > 1) && Ledger ? (target) => {
    if (target.commodoreId && target.commodoreId !== commodoreId) { setPeerLedger(target); return; }
    if (runningAt !== undefined) showInLedger(runningAt); else setLedgerReveal(null);
    setCommodoreLedger(commodoreId, true);
  } : null), [hasTurn, Ledger, runningAt, commodoreId, participants.length]);
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

  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => { setSettingsOpen(false); }, [commodoreId]);
  // 답 단추는 기존 사령관 메시지 API로 보낸다. 초안은 건드리지 않으며 읽기 전용이면 전송 포트를 주지 않는다.
  const sendOpenUI = useCallback((text: string) => { void messageCommodore(commodoreId, text).catch(() => {}); }, [commodoreId]);
  // 사령관의 지금 상태는 빈 입력의 자리표가 말한다. 읽기 전용이면 입력 대신 돌아가기가 선다.
  // 결정 대기함(B+) — 칩·한 줄·펼친 내용은 대화 독 안에 서고(`decision`), 입력창은 한 줄이 열리면 그 결정의 답 칸이 된다. 읽기 전용에는 없다.
  const decision = useCommodoreDecisionDock({ theaterId: commodoreId, language, onEnded: fail });
  const dock = readOnly ? null : decision;
  const renderComposer = (trailing?: ReactNode) => (
    <footer ref={dockRef} className="objectives-commodore-foot">
      {failure ? <p className="objectives-commodore-failure" role="alert">{failure}</p> : null}
      {readOnly
        ? <button type="button" className="objectives-commodore-conversation-back" onClick={onBack}>{t("commodore.conversation.back")}</button>
        : <CommodoreComposer t={t} theaterId={commodoreId} active={view?.boardReady === true && view.enabled} running={run?.phase === "turn"} placeholder={[...meta.map((part) => part.text), routine].filter(Boolean).join(" · ")} trailing={trailing} decisionTarget={dock?.target ?? null} onFail={fail} onClear={() => setFailure(null)} cliGate cliFailure={commodoreCliFailure(entries)} />}
    </footer>
  );
  const topSettings = !readOnly && view ? <CommodoreComposerSettings t={t} commodoreId={commodoreId} view={view} onFail={fail} onClear={() => setFailure(null)} onOpenChange={setSettingsOpen} /> : null;
  const mapMode = useCommodoreMapMode(commodoreId);
  const editRequest = useCommodoreMapEditRequest(commodoreId);
  const [mapFailure, setMapFailure] = useState<string | null>(null);
  useEffect(() => { setMapFailure(null); }, [commodoreId]);
  const failMap = useCallback((error: unknown) => setMapFailure(failureWord(t, error)), [t]);
  const clearMapFailure = useCallback(() => setMapFailure(null), []);
  return (
    <div className="objectives-commodore-conversation" data-settings-open={settingsOpen ? "true" : undefined}>
      {/* 맨 위 줄은 가운데 칸의 투명 오버레이다(머리 pill 과 그 옆 기록 비우기 단추가 떠 있다 — descriptor 의 actions) — 대화는 그
          밑으로 흘러 올라간다. */}
      {/* CLI 원인 실패는 「오류 · …」 대신 원인·해결 카드가 받는다. C1 상태 줄과 같은 문구를 쓴다. */}
      {(run?.phase === "retrying" || run?.phase === "error") && commodoreCliCause(run.reason) === null ? (
        <div className="objectives-commodore-retry">
          <span>{run.reason ? errorWord(t, run.reason) : t("commodore.meta.error")}</span>
          <button type="button" className="objectives-commodore-text-button" onClick={() => { setFailure(null); void retryCommodore(commodoreId).catch(fail); }}>{t("commodore.drawer.retryNow")}</button>
          <button type="button" className="objectives-commodore-text-button" onClick={() => { setFailure(null); void retryCommodoreNewSession(commodoreId).catch(fail); }}>{t("commodore.drawer.retryNewSession")}</button>
          {/* 대기 중인 실패 메시지가 있을 때만 — 대화를 지우지 않고 그 말만 빼고 이어 간다. */}
          {run.failedMessage ? <button type="button" className="objectives-commodore-text-button" onClick={() => { setFailure(null); void skipCommodoreFailed(commodoreId).catch(fail); }}>{t("commodore.drawer.skipFailed")}</button> : null}
        </div>
      ) : null}
      {mapMode === "map" && view ? (
        <CommodoreMapScreen
          t={t}
          commodoreId={commodoreId}
          state={view.state}
          facts={mapPanelFacts(view.run, view.defaults.model)}
          floatingPanel
          onQuickEdit={(target) => { clearMapFailure(); requestCommodoreMapEdit(commodoreId, target); }}
          onPanelClear={clearMapFailure}
          editors={(pickedIntelId) => ({
            description: <CommodoreDescription key={commodoreId} t={t} commodoreId={commodoreId} description={view.state.description} {...(editRequest?.target === "desc" ? { autoEditKey: editRequest.nonce } : {})} onFail={failMap} onClear={clearMapFailure} />,
            intel: <CommodoreIntel t={t} theaterId={commodoreId} intel={view.state.intel} sources={view.state.sources} selectedId={pickedIntelId} {...(editRequest?.target === "intel" ? { focusAddKey: editRequest.nonce } : {})} onFail={failMap} onClear={clearMapFailure} />,
          })}
          failureLine={mapFailure ? <p className="objectives-commodore-failure" role="alert">{mapFailure}</p> : null}
          onExit={() => setCommodoreMapMode(commodoreId, "chat")}
        />
      ) : null}
      {mapMode === "chat" ? (
        <>{peerLedger ? <div className="objectives-commodore-ledger" data-commodore-ledger=""><CommodorePeerLedger speaker={peerLedger} language={language} onBack={() => setPeerLedger(null)} /></div> : ledgerOpen && Ledger ? (
        // 그룹 대화가 지휘관 원장을 여는 그 틀·본문·바닥 줄(호스트 `ctx.chat.Ledger`)이다. 이 상자는 머리 pill 오버레이 밑자리만 진다.
        <div className="objectives-commodore-ledger" data-commodore-ledger="">
          <Ledger
            speaker={speaker}
            commodoreId={commodoreId}
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
            speakerMarks={false}
            working={working}
            language={language}
            commodoreId={commodoreId}
            speakerSection={speakerSection}
            commodoreActivity={activity}
            loading={!transcriptLoaded}
            empty={t("commodore.log.empty")}
            older={hasMore ? { label: t("commodore.log.older"), loading: loadingOlder, load: readOlder } : null}
            reveal={revealEntry}
            openBoardAction={openBoardAction}
            openLedger={openLedger}
            references={references} openUIOpen={openUIOpen}
            cards={readOnly ? null : <CommodoreCliFailureCard t={t} commodoreId={commodoreId} entries={entries} onFail={fail} />}
            decision={dock}
            composer={readOnly ? renderComposer(null) : ({ trailing }) => renderComposer(trailing)}
            composerTopEnd={topSettings}
            composerTopEntries={!readOnly}
            {...(readOnly ? {} : { onOpenUISend: sendOpenUI })}
          />
        ) : renderComposer(null)}
      </div>
      )}</>
      ) : null}
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

/* ── 상단 pill 프로필 팝오버 하단 — 설명 미리보기와 신경망 바로가기 ─────── */

function CommodoreProfileFooter({ commodoreId, language, onClose }: { readonly commodoreId: string; readonly language: "en" | "ko"; readonly onClose: () => void }) {
  const t = getT(language);
  const { view } = useCommodore(commodoreId);
  const memory = useCommodoreMemory(commodoreId);
  const mapMode = useCommodoreMapMode(commodoreId);
  const description = view?.state.description.text.trim() ?? "";
  const intelCount = view?.state.intel.length ?? 0;
  const memoryCount = memory.entries.length;
  return (
    <div className="commodore-profile-footer">
      {description ? <p className="commodore-profile-desc">{description}</p> : null}
      <div className="commodore-profile-meta">
        <span>{t("commodore.map.countMemory", { n: memoryCount })} · {t("commodore.map.countIntel", { n: intelCount })}</span>
        {mapMode !== "map" ? (
          <button
            type="button"
            className="commodore-profile-map-link"
            onClick={() => {
              onClose();
              setCommodoreMapMode(commodoreId, "map");
            }}
          >
            {description || intelCount > 0 ? t("commodore.edge.editInMap") : t("commodore.edge.openMap")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Console 이 가운데 칸에 세우는 사령관 대화 — 우측 사이드바 없이 채팅창 내부에 정체성·목표·루틴·신경망을 통합한다. */
export const commodoreConversationSurface: ConversationSurfaceDescriptor = {
  id: COMMODORE_SURFACE_ID,
  pillOwner: (ctx) => {
    const params = readParams(ctx.params);
    return params ? { kind: "commodore", id: params.commodoreId } : null;
  },
  title: (ctx) => {
    const commodoreId = readParams(ctx.params)?.commodoreId ?? "";
    return commodoreName(commodoreId, getT(ctx.language));
  },
  subtitle: (ctx) => (readParams(ctx.params)?.readOnly ? getT(ctx.language)("commodore.conversation.readOnly") : null),
  // 상단 pill 프로필 팝오버에서 지휘관 이름처럼 그 자리에서 고친다 — 읽기 전용 대화는 고치지 않는다.
  rename: (ctx) => {
    const params = readParams(ctx.params);
    return params && !params.readOnly ? (title: string) => { void renameCommodore(params.commodoreId, title).catch(() => undefined); } : null;
  },
  profileFooter: (ctx, close) => {
    const params = readParams(ctx.params);
    return params && !params.readOnly ? <CommodoreProfileFooter commodoreId={params.commodoreId} language={ctx.language} onClose={close} /> : null;
  },
  avatar: (ctx) => {
    const params = readParams(ctx.params);
    if (!params) return null;
    // 모습은 사령관 UUID 열쇠로 읽고 쓴다 — 만들기 창·사이드바·폰 모습 시트와 같은 열쇠다.
    return { key: commodoreAvatarKey(params.commodoreId), role: "commodore", label: commodoreName(params.commodoreId, getT(ctx.language)), state: commodoreMongleState(readCommodore(params.commodoreId).view, readTheater(params.commodoreId).objectives) };
  },
  subscribe: (listener) => {
    const offCommodore = subscribeCommodore(listener);
    const offBoard = subscribeObjective(listener);
    // 지도 모드 전환도 머리·프로필 다시 그리기가 알아야 한다 — subtitle·actions와 같은 경로.
    const offMapMode = subscribeCommodoreMapMode(listener);
    return () => { offCommodore(); offBoard(); offMapMode(); };
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
  // 머리 줄 알림 종 오른쪽의 지도 전환 — 구분선 + 신경망 단추. 같은 단추로 채팅에 돌아온다.
  toolbarTail: (ctx) => {
    const params = readParams(ctx.params);
    return params ? <CommodoreMapToggle commodoreId={params.commodoreId} language={ctx.language} /> : null;
  },
  // 지도 모드에서는 본문 위 우측 부유 엣지 스택(컨텍스트 창·목표·루틴)을 걷는다 — 채팅 복귀 시 그대로 다시 선다.
  hideContextRail: (ctx) => {
    const params = readParams(ctx.params);
    return params ? readCommodoreMapMode(params.commodoreId) === "map" : false;
  },
  render: (ctx) => {
    const params = readParams(ctx.params);
    return params ? <CommodoreConversationBody commodoreId={params.commodoreId} theaterId={params.theaterId} readOnly={params.readOnly} startMap={params.map} language={ctx.language} onBack={ctx.close} /> : null;
  },
  // 소유 사령관의 도구 문맥과 대화 탐색 목록을 함께 쓴다.
  commodoreId: (ctx) => {
    const params = readParams(ctx.params);
    return params && !params.readOnly ? params.commodoreId : null;
  },
  // 이 대화는 그 Theater 의 Inbox 「사령관」 섹션을 대신한다.
  theater: (ctx) => {
    const params = readParams(ctx.params);
    return params ? { theaterId: params.commodoreId, inboxSection: COMMODORE_INBOX_SECTION_ID } : null;
  },
  onLeaveDesktop: ({ params }) => {
    const target = readParams(params);
    if (!target || target.readOnly) return;
    openCommodoreMobile("log", target.commodoreId, false);
  },
};
