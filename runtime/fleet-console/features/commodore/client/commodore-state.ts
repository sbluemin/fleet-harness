import type { CommodoreClientDeps } from "./deps.js";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { uploadComposerAttachment, discardComposerAttachment } from "../../execution/client/composer-primitives/attachments.js";
import { createConversationStream } from "../../execution/shared/conversation/stream.js";

import type { AgentChatTranscriptProps, AgentConversationProps, AgentDecisionCardProps, AgentLedgerProps } from "../../execution/shared/chat-renderer.js";
import type { ModelRoster, ModelRosterTarget } from "../../ai-gateway/shared/models.js";
import type { ClientApiCapability } from "@fleet-console/infra/http/client-ports";
import { useModelRoster } from "../../ai-gateway/client/use-model-roster.js";

import type { MemoryEntry } from "../shared/contracts/memory.js";
import { patrolIntervalMs, type CommodorePatrolMinutes, type CommodoreStateView } from "../shared/contracts/types.js";
import type { CommodoreAsk, CommodoreEvent, CommodoreLiveEvent, CommodoreTranscriptEntry } from "../shared/contracts/types.js";
import { post } from "./request.js";
export { askObjectiveTitle } from "../shared/contracts/client-helpers.js";

/**
 * 사령관(Commodore)의 브라우저 쪽 상태 — 소유 UUID마다 서버의 `commodore/state` 한 건과 「사령관 기록」 한 쪽.
 *
 * Theater는 사령관을 찾기 위한 화면 문맥일 뿐이다. 진실은 서버다: 화면은 응답이 아니라 `commodore` 사건으로
 * 갱신되고, 스트림이 다시 붙으면 읽어 둔 사령관을 다시 읽는다. 실험 기능 「자율 운영」이 꺼져 있으면
 * 머리 글리프·메뉴·서랍이 서지 않으므로 아무것도 읽지 않는다.
 */

export const COMMODORE_CHANNEL = "commodore";

export type CommodoreTab = "log" | "directive" | "memory" | "settings";
/** 폰 화면의 구역 — 데스크톱 시트는 기록 곁 칸에 두는 「목표」가 폰에서는 구역 하나다. */
export type CommodoreMobileTab = CommodoreTab | "goals";

interface TheaterCommodore {
  readonly view: CommodoreStateView | null;
  readonly entries: readonly CommodoreTranscriptEntry[];
  readonly hasMore: boolean;
  /** 기록을 한 번이라도 읽었는가 — 서랍이 처음 열릴 때만 읽는다. */
  readonly transcriptLoaded: boolean;
  readonly clearedThrough: number;
  /** 마지막 확정 줄 뒤의 라이브 사건(글자 흐름·진행 중 도구) — 저장되지 않고, 확정 줄이 오면 그 몫을 걷는다. */
  readonly live: readonly CommodoreLiveEvent[];
}

const EMPTY: TheaterCommodore = { view: null, entries: [], hasMore: false, transcriptLoaded: false, clearedThrough: 0, live: [] };
/** 라이브 글자는 한 덩어리로 잇는다 — 확정 줄이 늦어도 사건 배열이 델타 수만큼 자라지 않게. */
const MAX_LIVE_TEXT = 60_000;

/** 확정 줄이 도착하면 그 줄이 대신하는 라이브 몫을 걷는다 — 글은 글자 흐름을, 도구는 같은 이름의 첫 진행 줄을, 그 밖의 줄은 전부. */
function settleLive(live: readonly CommodoreLiveEvent[], entry: CommodoreTranscriptEntry): readonly CommodoreLiveEvent[] {
  if (live.length === 0) return live;
  if (entry.kind === "text" || entry.kind === "thinking") return live.filter((event) => event.kind !== "text-delta");
  if (entry.kind === "tool") {
    const index = live.findIndex((event) => event.kind === "tool-start" && event.name === entry.name);
    return index < 0 ? live : [...live.slice(0, index), ...live.slice(index + 1)];
  }
  // 사람의 말과 그 말의 행방(도는 턴이 집음·다시 실음)은 흐르는 답을 대신하지 않는다 — 턴 중에 와도 글자 흐름은 그대로다.
  if (entry.kind === "message" || entry.kind === "delivered" || entry.kind === "requeued") return live;
  return [];
}

function appendLive(live: readonly CommodoreLiveEvent[], event: CommodoreLiveEvent): readonly CommodoreLiveEvent[] {
  const last = live.at(-1);
  if (event.kind === "text-delta" && last?.kind === "text-delta") return [...live.slice(0, -1), { kind: "text-delta", text: (last.text + event.text).slice(0, MAX_LIVE_TEXT) }];
  return [...live, event];
}
const TRANSCRIPT_PAGE = 200;
/** 기록은 화면에 보이는 만큼만 붙들고 있다 — 오래 켜 둔 서랍이 끝없이 자라지 않게. */
const MAX_HELD_ENTRIES = 2_000;

let installed: CommodoreClientDeps | null = null;
/** 소유 UUID → 그 사령관의 화면 상태. */
const theaters = new Map<string, TheaterCommodore>();
/** 화면 문맥(Theater) → 사령관 UUID. 경로·정체성이 아니다. */
const contextOwners = new Map<string, string>();
const contextResolving = new Map<string, Promise<string | null>>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let enabledSnapshot = false;
/** 전역 설정을 한 번이라도 읽었는가 — 읽기 전에는 실험 기능 켜짐을 모른다. */
let experimentsKnown = false;
/**
 * 사람이 읽는 Console 언어 — 머리 글리프·서랍이 그릴 때 알려 주고, 모든 commodore/* 요청 본문에 실린다. 서버는 Theater 마다
 * 기억해 사령관이 그 언어로 기록을 쓴다(목표 라우트가 language 를 싣는 것과 같다).
 */
let language: "en" | "ko" | null = null;

export function noteCommodoreLanguage(next: "en" | "ko"): void {
  language = next;
}

/** 마지막으로 알려진 사람의 언어 — 리액트 밖에서 읽히는 새 세션 '@' 행이 문구를 고른다. */
export function commodoreLanguage(): "en" | "ko" | undefined {
  return language ?? undefined;
}

const withLanguage = <B extends Record<string, unknown>>(body: B): B & { language?: "en" | "ko" } => (language ? { ...body, language } : body);

let revision = 0;

function notify(): void {
  revision += 1;
  for (const listener of [...listeners]) listener();
}

/** 바뀔 때마다 오르는 수 — 사이드바 줄 계산이 입력 비교에 쓴다. */
export function commodoreRevision(): number {
  return revision;
}

function rememberContext(theaterId: string, commodoreId: string): void {
  if (contextOwners.get(theaterId) === commodoreId) return;
  contextOwners.set(theaterId, commodoreId);
  notify();
}

/** 이미 풀어 둔 화면 문맥의 사령관 UUID. 아직 모르면 null. */
export function ownerOfContext(theaterId: string): string | null {
  return installed?.consoleState.getTheaters().find((theater) => theater.id === theaterId)?.commodore?.id ?? contextOwners.get(theaterId) ?? null;
}

/** 그 사령관을 가리키는 화면 문맥. 이동에만 쓰고 정체성으로 쓰지 않는다. */
export function contextsOf(commodoreId: string): readonly string[] {
  return [...contextOwners.entries()].filter(([, id]) => id === commodoreId).map(([theaterId]) => theaterId);
}

/** Theater 머리·사이드바에서 사령관 UUID를 구한다. 실패·없음은 null이고 Theater로 대체하지 않는다. */
export function resolveContext(theaterId: string): Promise<string | null> {
  const known = ownerOfContext(theaterId);
  if (known) { rememberContext(theaterId, known); return Promise.resolve(known); }
  const inflight = contextResolving.get(theaterId);
  if (inflight) return inflight;
  const client = api();
  if (!client) return Promise.resolve(null);
  const request = post<{ readonly commodoreId: string | null }>(client, "/commodore/resolve", { theaterId })
    .then((result) => {
      if (!result.commodoreId) return null;
      rememberContext(theaterId, result.commodoreId);
      return result.commodoreId;
    })
    .catch(() => null)
    .finally(() => { if (contextResolving.get(theaterId) === request) contextResolving.delete(theaterId); });
  contextResolving.set(theaterId, request);
  return request;
}

export function useCommodoreOwner(theaterId: string | null): string | null {
  const owner = useSyncExternalStore(
    subscribeCommodore,
    () => (theaterId ? ownerOfContext(theaterId) : null),
    () => (theaterId ? ownerOfContext(theaterId) : null),
  );
  useEffect(() => { if (theaterId) void resolveContext(theaterId); }, [theaterId]);
  return owner;
}

/**
 * 사이드바 줄이 읽는 사령관의 지금 — 자율 운영이 실제로 돌고 있는가(실험 기능 + 글리프), 그리고 감독자가 정체로 본 목표.
 * 읽지 않은 Theater 는 자동 운영하지 않는 것으로 다룬다. `enabled` 는 사령관 표면의 가용 여부이고,
 * `peek` 는 사람이 이 Theater 머리의 사령관 글리프에 머무는 중이다.
 */
export function commodoreBoardOf(commodoreId: string): { readonly active: boolean; readonly stalled: readonly string[]; readonly enabled: boolean; readonly peek: boolean } {
  if (!enabledSnapshot) return DISABLED_BOARD;
  const view = theaters.get(commodoreId)?.view;
  const peek = peekTheater !== null && ownerOfContext(peekTheater) === commodoreId;
  if (!view?.active) return { active: false, stalled: [], enabled: true, peek };
  return { active: true, stalled: view.run.stalled ?? [], enabled: true, peek };
}
const DISABLED_BOARD = { active: false, stalled: [] as readonly string[], enabled: false, peek: false };

/** 사람이 사령관 글리프에 머무는 Theater — 그동안 사이드바의 사령관 표식이 함께 밝아진다. */
let peekTheater: string | null = null;

export function setCommodorePeek(theaterId: string | null): void {
  if (peekTheater === theaterId) return;
  peekTheater = theaterId;
  notify();
}

function setTheater(theaterId: string, patch: Partial<TheaterCommodore>, announce = true): void {
  const current = theaters.get(theaterId) ?? EMPTY;
  if (patch.view && (patch.view.state.transcriptClearedThrough ?? 0) < current.clearedThrough) return;
  const clearedThrough = Math.max(current.clearedThrough, patch.clearedThrough ?? 0, patch.view?.state.transcriptClearedThrough ?? 0);
  const cleared = clearedThrough > current.clearedThrough;
  const next = { ...current, ...patch, clearedThrough };
  if (cleared) { next.entries = []; next.live = []; next.hasMore = false; }
  if (patch.entries || cleared) next.entries = (patch.entries ?? next.entries).filter((entry) => entry.seq > clearedThrough);
  theaters.set(theaterId, next);
  if (announce) notify();
}

function readEnabled(): boolean {
  return installed?.experiments.read()?.commodore === true;
}

function readExperimentsKnown(): boolean {
  return (installed?.experiments.read() ?? null) !== null;
}

/**
 * 모바일 바로가기 「사령관」 목적지의 보임 — 실험 기능 「자율 운영」이 켜져 있을 때만 선다(Theater 가 아직 안 읽힌 부팅 직후에도 판정은 같다).
 * 전역 설정을 아직 읽지 못한 부팅 직후에는 둔다: 이때 false 를 돌려주면 사령관 화면을 보던 새로고침이 홈으로 튕긴다.
 * 칩이 부팅 직후 잠깐 서는 일이 없도록 판정을 처음부터 같게 둔다.
 */
export const commodoreDestinationShown = {
  subscribe: (listener: () => void) => subscribeCommodore(listener),
  get: (_theaterId: string | null): boolean => !experimentsKnown || enabledSnapshot,
};

export function subscribeCommodore(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Theater 목록 중 사령관 행선지 이름이 기대는 몫(id·이름·별칭)의 서명 — 바뀐 때만 덱을 다시 읽게 한다. */
function commodoreNamesKey(): string {
  return (installed?.consoleState.getTheaters() ?? []).map((theater) => `${theater.id}\u0000${theater.label}\u0000${theater.commodore?.id ?? ""}\u0000${theater.commodore?.alias ?? ""}`).join("\u0001");
}

/**
 * 모든 등록 Theater의 사령관이 같은 행선지 목록을 공유한다. Theater 목록의 추가·제거·별칭 지정·해제는 설치가 콘솔 상태를 듣다가
 * 사령관 구독자에게 알리므로(`installCommodoreState`), 호스트가 플러그인 설치보다 먼저 구독해도 놓치지 않는다.
 */
export function subscribeCommodoreMentions(listener: () => void): () => void { return subscribeCommodore(listener); }
export function commodoreTheaterIds(): readonly string[] { return installed?.consoleState.getTheaters().map((theater) => theater.id) ?? []; }

export function installCommodoreState(ctx: CommodoreClientDeps): () => void {
  installed = ctx;
  enabledSnapshot = readEnabled();
  experimentsKnown = readExperimentsKnown();
  const loadRegistered = () => {
    for (const theaterId of commodoreTheaterIds()) void resolveContext(theaterId).then((commodoreId) => { if (commodoreId) void loadCommodore(commodoreId); });
  };
  let registered = commodoreTheaterIds().join("\0");
  // 이름(원래 이름·별칭)만 바뀌어도 사령관 행선지 이름이 따라가야 한다 — 읽기는 등록 목록이 바뀔 때만 새로 한다.
  let names = commodoreNamesKey();
  loadRegistered();
  const offConsole = ctx.consoleState.subscribe(() => {
    const nextNames = commodoreNamesKey();
    if (nextNames === names) return;
    names = nextNames;
    const next = commodoreTheaterIds().join("\0");
    if (next !== registered) {
      registered = next;
      loadRegistered();
    }
    notify();
  });
  const applyEvent = (event: CommodoreEvent) => {
    const commodoreId = event.commodoreId;
    for (const theaterId of event.theaterIds) rememberContext(theaterId, commodoreId);
    if (event.op === "memory") {
      if (memories.has(commodoreId)) void loadCommodoreMemory(commodoreId);
      return;
    }
    if (event.op === "state" && event.change === "clear") setTheater(commodoreId, { clearedThrough: event.state.transcriptClearedThrough ?? 0 }, false);
    const current = theaters.get(commodoreId);
    if (event.op === "transcript") {
      // 아직 서랍을 연 적 없는 Theater 의 기록은 붙들지 않는다 — 열 때 한 쪽을 읽는다.
      if (!current?.transcriptLoaded) return;
      if (current.entries.some((entry) => entry.seq === event.entry.seq)) return;
      setTheater(commodoreId, { entries: [...current.entries, event.entry].slice(-MAX_HELD_ENTRIES), live: settleLive(current.live, event.entry) }, false);
      return;
    }
    if (event.op === "live") {
      if (!current?.transcriptLoaded) return;
      setTheater(commodoreId, { live: appendLive(current.live, event.live) }, false);
      return;
    }
    if (!current?.view) {
      void loadCommodore(commodoreId, true);
      return;
    }
    if (event.op === "state") {
      const automatic = patrolIntervalMs(event.state) !== null;
      setTheater(commodoreId, { view: { ...current.view, state: event.state, active: current.view.boardReady && current.view.enabled && automatic } }, false);
      return;
    }
    if (event.op === "run") {
      setTheater(commodoreId, { view: { ...current.view, run: event.run, active: current.view.boardReady && current.view.enabled && patrolIntervalMs(current.view.state) !== null } }, false);
      if ((event.run.phase === "off" && current.view.active) || (event.run.phase !== "off" && !current.view.boardReady)) void loadCommodore(commodoreId, true);
    }
  };
  const stream = createConversationStream<CommodoreEvent>({
    delta: (event) => event.op === "live" && event.live.kind === "text-delta" ? { key: event.commodoreId, text: event.live.text } : null,
    withText: (event, text) => ({ op: "live", commodoreId: event.commodoreId, theaterIds: event.theaterIds, live: { kind: "text-delta", text } }),
    apply: (events) => {
      let changed = false;
      for (const event of events) {
        const before = theaters.get(event.commodoreId);
        applyEvent(event);
        changed ||= before !== theaters.get(event.commodoreId);
      }
      if (changed) notify();
    },
  });
  const offEvents = ctx.consoleEvents.subscribe(COMMODORE_CHANNEL, (payload) => {
    const event = payload as CommodoreEvent | null;
    if (!event || typeof event.commodoreId !== "string" || !Array.isArray(event.theaterIds)) return;
    if (event.op === "live" && !theaters.get(event.commodoreId)?.transcriptLoaded) return;
    stream.push(event);
  });
  // 단절 중의 사건은 다시 오지 않는다 — 읽어 둔 Theater 를 처음부터 다시 읽는다.
  const offReconnect = ctx.consoleEvents.onReconnect?.(() => {
    stream.flush();
    for (const [theaterId, current] of theaters) {
      if (current.view) void loadCommodore(theaterId, true);
      if (current.transcriptLoaded) void loadTranscript(theaterId, { reset: true });
    }
    for (const theaterId of memories.keys()) void loadCommodoreMemory(theaterId);
  });
  const offExperiments = ctx.experiments.subscribe(() => {
    const next = readEnabled();
    const known = readExperimentsKnown();
    if (next === enabledSnapshot && known === experimentsKnown) return;
    experimentsKnown = known;
    if (next === enabledSnapshot) { notify(); return; }
    enabledSnapshot = next;
    // 켜고 끈 결과는 서버의 view(enabled·active)에도 실린다 — 읽어 둔 Theater 를 다시 읽는다.
    for (const [theaterId, current] of theaters) if (current.view) void loadCommodore(theaterId, true);
    if (next) loadRegistered();
    notify();
  });
  return () => {
    offConsole();
    offEvents();
    stream.dispose();
    offReconnect?.();
    offExperiments();
    if (installed === ctx) installed = null;
    theaters.clear();
    contextOwners.clear();
    contextResolving.clear();
    loading.clear();
    memories.clear();
    notify();
  };
}

function api(): ClientApiCapability | null {
  return installed?.api ?? null;
}

export function loadCommodore(commodoreId: string, force = false): Promise<void> {
  const client = api();
  if (!client || !commodoreId || !enabledSnapshot) return Promise.resolve();
  if (!force && theaters.get(commodoreId)?.view) return Promise.resolve();
  const inflight = loading.get(commodoreId);
  if (inflight && !force) return inflight;
  const request = post<CommodoreStateView>(client, "/commodore/state", withLanguage({ commodoreId }))
    .then((view) => { setTheater(commodoreId, { view }); })
    .catch(() => undefined)
    .finally(() => { if (loading.get(commodoreId) === request) loading.delete(commodoreId); });
  loading.set(commodoreId, request);
  return request;
}

export async function loadTranscript(commodoreId: string, options: { readonly older?: boolean; readonly reset?: boolean } = {}): Promise<void> {
  const client = api();
  if (!client || !commodoreId) return;
  const current = theaters.get(commodoreId) ?? EMPTY;
  const before = options.older && !options.reset ? current.entries[0]?.seq : undefined;
  const page = await post<{ readonly entries: readonly CommodoreTranscriptEntry[]; readonly hasMore: boolean; readonly clearedThrough: number }>(client, "/commodore/transcript", withLanguage({ commodoreId, limit: TRANSCRIPT_PAGE, ...(before !== undefined ? { before } : {}) })).catch(() => null);
  if (!page) return;
  if (page.clearedThrough < (theaters.get(commodoreId)?.clearedThrough ?? 0)) return;
  setTheater(commodoreId, { clearedThrough: page.clearedThrough });
  const latest = theaters.get(commodoreId) ?? EMPTY;
  if (options.older && !options.reset) {
    const known = new Set(latest.entries.map((entry) => entry.seq));
    setTheater(commodoreId, { entries: [...page.entries.filter((entry) => !known.has(entry.seq)), ...latest.entries], hasMore: page.hasMore, transcriptLoaded: true });
    return;
  }
  const tail = latest.transcriptLoaded ? latest.entries.filter((entry) => entry.seq > (page.entries.at(-1)?.seq ?? -1)) : [];
  setTheater(commodoreId, { entries: [...page.entries, ...tail], hasMore: page.hasMore, transcriptLoaded: true, ...(options.reset ? { live: [] } : {}) });
}

/** 호스트의 채팅 턴 렌더러 — Objective 채팅과 같은 컴포넌트다. 설치 전이면 null. */
export function commodoreTranscriptRenderer(): ComponentType<AgentChatTranscriptProps> | null {
  return installed?.chat.Transcript ?? null;
}

/** 사령관 원장 — 그룹 대화의 지휘관 원장과 같은 틀·본문·바닥 줄(호스트 `ctx.chat.Ledger`). 설치 전이면 null. */
export function commodoreLedgerRenderer(): ComponentType<AgentLedgerProps> | null {
  return installed?.chat.Ledger ?? null;
}

/** 대화 중심 화면의 대화 렌더러 — Objective 대화와 같은 말풍선 화면(호스트 `ctx.chat.Conversation`). */
export function commodoreConversationRenderer(): ComponentType<AgentConversationProps> | null {
  return installed?.chat.Conversation ?? null;
}

/** 사령관의 질문 카드 — 지휘관·구성원 그룹 대화의 결정 카드와 같은 컴포넌트(호스트 `ctx.chat.DecisionCard`). 설치 전이면 null. */
export function commodoreDecisionCardRenderer(): ComponentType<AgentDecisionCardProps> | null {
  return installed?.chat.DecisionCard ?? null;
}

/** 컴포저 위쪽 호스트 요약 줄(호스트 `ctx.chat.ComposerTopEntries`). 설치 전이거나 구버전 호스트면 null. */
export function commodoreComposerTopEntriesRenderer(): ComponentType | null {
  return installed?.chat.ComposerTopEntries ?? null;
}

const EMPTY_VIEW_SNAPSHOT: TheaterCommodore = EMPTY;

export function readCommodore(commodoreId: string | null): TheaterCommodore {
  return commodoreId ? theaters.get(commodoreId) ?? EMPTY_VIEW_SNAPSHOT : EMPTY_VIEW_SNAPSHOT;
}

export function useCommodore(commodoreId: string | null): TheaterCommodore {
  return useSyncExternalStore(subscribeCommodore, () => readCommodore(commodoreId), () => readCommodore(commodoreId));
}

/**
 * fleet-memory — 사령관만 쓰고 사람은 읽기만 하는 기억. 칸을 처음 열 때 읽고, 그 뒤로는 `memory` 사건과 재연결 때 다시 읽는다.
 * 읽는 중 사건이 또 오면 늦게 시작한 읽기만 반영한다.
 */
export interface CommodoreMemoryView {
  readonly entries: readonly MemoryEntry[];
  readonly loaded: boolean;
  readonly failed: boolean;
}

const EMPTY_MEMORY: CommodoreMemoryView = { entries: [], loaded: false, failed: false };
const memories = new Map<string, CommodoreMemoryView>();
const memoryRequests = new Map<string, number>();

export function loadCommodoreMemory(commodoreId: string): Promise<void> {
  const client = api();
  if (!client || !commodoreId) return Promise.resolve();
  if (!memories.has(commodoreId)) memories.set(commodoreId, EMPTY_MEMORY);
  const ticket = (memoryRequests.get(commodoreId) ?? 0) + 1;
  memoryRequests.set(commodoreId, ticket);
  return post<{ readonly entries: readonly MemoryEntry[] }>(client, "/commodore/memory", withLanguage({ commodoreId }))
    .then((page) => ({ entries: page.entries, loaded: true, failed: false }))
    .catch(() => ({ ...(memories.get(commodoreId) ?? EMPTY_MEMORY), loaded: true, failed: true }))
    .then((next) => {
      if (memoryRequests.get(commodoreId) !== ticket || !memories.has(commodoreId)) return;
      memories.set(commodoreId, next);
      notify();
    });
}

export function readCommodoreMemory(commodoreId: string | null): CommodoreMemoryView {
  return commodoreId ? memories.get(commodoreId) ?? EMPTY_MEMORY : EMPTY_MEMORY;
}

/** 기억 칸이 서는 동안 — 처음 서면 읽기를 건다. */
export function useCommodoreMemory(commodoreId: string | null): CommodoreMemoryView {
  useEffect(() => { if (commodoreId && !memories.get(commodoreId)?.loaded) void loadCommodoreMemory(commodoreId); }, [commodoreId]);
  return useSyncExternalStore(subscribeCommodore, () => readCommodoreMemory(commodoreId), () => readCommodoreMemory(commodoreId));
}

/** 실험 기능 「자율 운영」을 읽었는가와 켜져 있는가 — Theater Inbox 섹션이 리액트 밖에서 읽는다(부수효과 없음). */
const EXPERIMENT_STATES = {
  unknown: { known: false, enabled: false },
  off: { known: true, enabled: false },
  on: { known: true, enabled: true },
} as const;
export function readCommodoreExperiment(): { readonly known: boolean; readonly enabled: boolean } {
  return !experimentsKnown ? EXPERIMENT_STATES.unknown : enabledSnapshot ? EXPERIMENT_STATES.on : EXPERIMENT_STATES.off;
}

/** 실험 기능 「자율 운영」 — 꺼져 있으면 머리 글리프·메뉴가 서지 않고, Theater Inbox 의 사령관 섹션은 안내 한 줄만 남는다. */
export function useCommodoreEnabled(): boolean {
  return useSyncExternalStore(subscribeCommodore, () => enabledSnapshot, () => enabledSnapshot);
}

/** 지도(캔버스) 영역의 가로 인셋 — 서랍이 지도를 넘지 않게 폭을 정한다. 모르는 호스트면 창 전체가 지도다. */
export function commodoreMapInsets(): { readonly left: number; readonly right: number } {
  return installed?.consoleState.getMapInsets?.() ?? { left: 0, right: 0 };
}

export function subscribeCommodoreMapInsets(listener: () => void): () => void {
  return installed?.consoleState.subscribeMapInsets?.(listener) ?? (() => undefined);
}

/** Theater 의 원래 이름 — 사령관 별칭이 있어도 바뀌지 않는다(사이드바는 별칭 아래 줄에 이 이름을 둔다). */
export function commodoreTheaterLabel(theaterId: string): string {
  return installed?.consoleState.getTheaters().find((theater) => theater.id === theaterId)?.label ?? "";
}

/** 사람이 지정한 사령관 별칭 — 없거나 지웠으면 null 이다. 구버전 호스트는 싣지 않으므로 늘 null 이다. */
export function commodoreAlias(theaterId: string): string | null {
  const owner = ownerOfContext(theaterId);
  return owner ? commodoreOwnerAlias(owner) : null;
}
/** 별칭은 UUID 소유 상태다. 아직 상태를 읽지 않았으면 서버의 같은 UUID identity 투영을 사용한다. */
export function commodoreOwnerAlias(commodoreId: string): string | null {
  const view = theaters.get(commodoreId)?.view;
  return view ? view.state.alias ?? null : installed?.consoleState.getTheaters().find((theater) => theater.commodore?.id === commodoreId)?.commodore?.alias ?? null;
}

/* ── 폰 사령관 화면 ──────────────────────────────────────────────────── */

export const COMMODORE_ENTRY_ID = "commodore";

/** Theater Inbox 의 사령관 섹션 id(플러그인 로컬) — 정준 id 의 접두는 호스트가 붙인다. 섹션과 사이드바 줄이 같이 쓴다. */
export const COMMODORE_INBOX_SECTION_ID = "commodore";

/** 폰 사령관 화면의 고른 구역 — 다시 들어와도 유지한다(S-54 CM-2a). 데스크톱 Theater Inbox 에서 넘어올 때·Theater 시트 행도 여기에 구역을 남긴다. */
let mobileTab: CommodoreMobileTab = "log";

export function setCommodoreMobileTab(tab: CommodoreMobileTab): void {
  if (mobileTab === tab) return;
  mobileTab = tab;
  notify();
}

export function useCommodoreMobileTab(): CommodoreMobileTab {
  return useSyncExternalStore(subscribeCommodore, () => mobileTab, () => mobileTab);
}

let mobilePanelSequence = 0;
let mobilePanelRequest: string | null = null;

/** 데스크톱 전환 요청을 실은 페인만 한 번 받는다 — 다른 바로가기·딥링크에는 묵은 요청을 적용하지 않는다. */
export function useCommodoreMobilePanelRequest(request: string | undefined, onOpen: () => void): void {
  useEffect(() => {
    if (!request || request !== mobilePanelRequest) return;
    mobilePanelRequest = null;
    onOpen();
  }, [request, onOpen]);
}

/** 폰 사령관 화면을 고른 구역으로 연다 — 모바일 호스트는 목적지로 선언된 엔트리의 `rail.open`을 화면으로 연다. */
export function openCommodoreMobile(tab: CommodoreMobileTab, theaterId: string | null, panel = false): void {
  setCommodoreMobileTab(tab);
  mobilePanelRequest = panel ? String(++mobilePanelSequence) : null;
  installed?.rail.open(COMMODORE_ENTRY_ID, {
    ...(theaterId ? { theaterId } : {}),
    ...(mobilePanelRequest ? { commodorePanel: mobilePanelRequest } : {}),
  });
}

/* ── 사람의 행위 ─────────────────────────────────────────────────────── */

async function write(commodoreId: string, path: string, body: Record<string, unknown>): Promise<void> {
  const client = api();
  if (!client || !commodoreId) throw new Error("not_installed");
  const view = await post<CommodoreStateView>(client, path, withLanguage({ commodoreId, ...body }));
  if (view && typeof view === "object" && "state" in view) setTheater(commodoreId, { view });
}

export const saveCommodoreDirective = (theaterId: string, text: string) => write(theaterId, "/commodore/directive", { text });
export const addCommodoreIntel = (theaterId: string, text: string) => write(theaterId, "/commodore/intel/add", { text });
export const removeCommodoreIntel = (theaterId: string, intelId: string) => write(theaterId, "/commodore/intel/remove", { intelId });
export const editCommodoreIntel = (theaterId: string, intelId: string, text: string) => write(theaterId, "/commodore/intel/edit", { intelId, text });

/** 정보 항목 한 건의 자리 편집 — 고쳐 쓰는 글, 저장 중 여부, 마지막 저장 실패 코드(그 편집기 곁에 보인다). */
export interface CommodoreIntelEdit {
  readonly draft: string;
  readonly saving: boolean;
  readonly error?: string | undefined;
}

/** 정보 목록의 「수정」 단추 표지 — 편집을 닫으면 포커스가 이 단추로 돌아온다. */
export const INTEL_EDIT_ATTRIBUTE = "data-intel-edit";

/**
 * 정보 목록의 자리 편집 — 데스크톱 패널·Theater Inbox·폰 화면이 같이 쓴다. 편집은 항목마다 따로라 한 항목을 저장하는 동안
 * 다른 항목을 고쳐도 서로 덮지 않는다. 저장이 끝나면 그 편집만 닫히고, 실패하면 쓰던 글과 실패 코드를 그 편집에 둔 채 열려 있다.
 * 다른 곳에서 지운 항목의 편집은 버린다. 본문이 그대로면 요청 없이 닫는다. 저장·취소로 닫히면 그 항목의 「수정」 단추로
 * 포커스를 돌려준다 — 그새 사람이 다른 곳에 포커스를 두었으면 건드리지 않는다. `listRef` 는 목록 요소에 붙인다.
 */
export function useCommodoreIntelEdits(theaterId: string, intel: readonly { readonly id: string; readonly text: string }[], handlers: { readonly onClear: () => void }) {
  const [edits, setEdits] = useState<Readonly<Record<string, CommodoreIntelEdit>>>({});
  const latest = useRef({ edits, intel, handlers });
  latest.current = { edits, intel, handlers };
  const list = useRef<HTMLElement | null>(null);
  const refocus = useRef<string | null>(null);
  const [listRef] = useState(() => (element: HTMLElement | null) => { list.current = element; });
  useEffect(() => { setEdits((current) => (Object.keys(current).length ? {} : current)); }, [theaterId]);
  useLayoutEffect(() => {
    const intelId = refocus.current;
    if (!intelId || edits[intelId]) return;
    refocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    list.current?.querySelector<HTMLElement>(`[${INTEL_EDIT_ATTRIBUTE}="${CSS.escape(intelId)}"]`)?.focus();
  }, [edits]);
  const known = new Set(intel.map((item) => item.id));
  const live = Object.fromEntries(Object.entries(edits).filter(([id]) => known.has(id))) as Readonly<Record<string, CommodoreIntelEdit>>;
  const close = (intelId: string) => {
    if (!(intelId in latest.current.edits)) return;
    refocus.current = intelId;
    setEdits((current) => {
      if (!(intelId in current)) return current;
      const { [intelId]: _closed, ...rest } = current;
      return rest;
    });
  };
  const patch = (intelId: string, next: Partial<CommodoreIntelEdit>) => setEdits((current) => (current[intelId] ? { ...current, [intelId]: { ...current[intelId]!, ...next } } : current));
  return {
    edits: live,
    listRef,
    open(intelId: string) {
      const item = latest.current.intel.find((entry) => entry.id === intelId);
      if (!item) return;
      setEdits((current) => (current[intelId] ? current : { ...current, [intelId]: { draft: item.text, saving: false } }));
    },
    change: (intelId: string, draft: string) => patch(intelId, { draft, error: undefined }),
    cancel: close,
    save(intelId: string) {
      const edit = latest.current.edits[intelId];
      const item = latest.current.intel.find((entry) => entry.id === intelId);
      if (!edit || !item || edit.saving) return;
      const text = edit.draft.trim();
      if (!text) return;
      if (text === item.text) { close(intelId); return; }
      latest.current.handlers.onClear();
      patch(intelId, { saving: true, error: undefined });
      void editCommodoreIntel(theaterId, intelId, text)
        .then(() => close(intelId))
        .catch((error: unknown) => patch(intelId, { saving: false, error: error instanceof Error ? error.message : "failed" }));
    },
  };
}
export const setCommodoreCoordinates = (theaterId: string, coordinates: { readonly model: string; readonly effort: string } | null) =>
  write(theaterId, "/commodore/coordinates", coordinates ? { model: coordinates.model, effort: coordinates.effort } : { model: null, effort: null });
/** 사령관이 만드는 목표의 지휘관 모델·강도 — null 은 보드 기본값으로 되돌린다. */
export const setCommodoreCommander = (theaterId: string, commander: { readonly model: string; readonly effort?: string } | null) =>
  write(theaterId, "/commodore/commander", commander ? { model: commander.model, effort: commander.effort ?? null } : { model: null });
/** 순찰 간격(분) — null 은 기본으로 되돌린다. */
export const setCommodorePatrol = (theaterId: string, minutes: CommodorePatrolMinutes) => write(theaterId, "/commodore/patrol", { minutes });
export const setCommodoreStopAt = (theaterId: string, stopAt: number | null) => write(theaterId, "/commodore/stop-at", { stopAt });
export const retryCommodore = (theaterId: string) => write(theaterId, "/commodore/retry", {});
export const clearCommodore = (theaterId: string) => write(theaterId, "/commodore/clear", { confirm: true });

/** 이미 끝났거나 사라진 질문의 거절 — 화면이 낡았다는 뜻이라 상태를 한 번 다시 읽는다. */
const STALE_ASK_CODES: ReadonlySet<string> = new Set(["ask_withdrawn", "ask_already_answered", "unknown_ask"]);

/**
 * 사령관의 질문에 답한다 — 모든 질문의 답을 한 번에. 결과 상태로 화면을 바로 고치고(질문이 끝나 카드가 내려간다), 거절은 코드를 던진다.
 * 질문이 이미 끝났다는 거절이면 그 보내기 한 번에 상태를 한 번 다시 읽어 카드·줄을 걷는다(다시 읽기는 거절을 되풀이하지 않는다).
 */
export async function answerCommodoreAsk(theaterId: string, askId: string, answers: readonly { readonly questionId: string; readonly selectedOptionIds: readonly string[]; readonly text: string }[]): Promise<void> {
  try {
    await write(theaterId, "/commodore/ask/answer", { askId, answers });
  } catch (error) {
    if (error instanceof Error && STALE_ASK_CODES.has(error.message)) void loadCommodore(theaterId, true).catch(() => undefined);
    throw error;
  }
}

export function uploadCommodoreAttachment(file: Blob): Promise<{ readonly id: string }> {
  if (!installed) return Promise.reject(new Error("not_installed"));
  return uploadComposerAttachment(file, (path, init) => installed!.api.fetch(path, init));
}
export function discardCommodoreAttachment(id: string): Promise<void> {
  if (!installed) return Promise.reject(new Error("not_installed"));
  return discardComposerAttachment(id, (path, init) => installed!.api.fetch(path, init));
}

/** `references` — 본문 속 지휘관 참조의 목표 id(본문의 표식 글자 순서). 서버가 짝·Theater·실재를 검증한다. */
export async function messageCommodore(commodoreId: string, text: string, attachmentIds?: readonly string[], references?: readonly string[]): Promise<void> {
  const client = api();
  if (!client || !commodoreId) throw new Error("not_installed");
  const result = await post<{ readonly entry?: CommodoreTranscriptEntry }>(client, "/commodore/message", withLanguage({ commodoreId, text, ...(attachmentIds?.length ? { attachmentIds } : {}), ...(references?.length ? { references } : {}) }));
  const entry = result?.entry;
  const current = theaters.get(commodoreId);
  if (entry && current?.transcriptLoaded && !current.entries.some((candidate) => candidate.seq === entry.seq)) {
    setTheater(commodoreId, { entries: [...current.entries, entry].slice(-MAX_HELD_ENTRIES) });
  }
}

/* ── 보드에서 세는 것 ────────────────────────────────────────────────── */

const NO_ASKS: readonly CommodoreAsk[] = [];
const openAskMemo = new Map<string, { readonly source: readonly CommodoreAsk[] | undefined; readonly open: readonly CommodoreAsk[] }>();
/**
 * 사령관이 사람에게 물어 아직 답을 기다리는 질문 — 물은 순서. 「내 결정」 줄·레일 배지·확인 필요·사령관 얼굴 배지·폰 칩 배지·질문 카드가
 * 모두 이 하나를 읽는다. 읽지 않은 Theater 는 없다. 같은 상태면 같은 배열을 돌려준다(스냅샷).
 */
export function openAsks(commodoreId: string | null): readonly CommodoreAsk[] {
  if (!commodoreId) return NO_ASKS;
  const source = theaters.get(commodoreId)?.view?.state.asks;
  const hit = openAskMemo.get(commodoreId);
  if (hit && hit.source === source) return hit.open;
  const open = source?.some((ask) => !ask.settled) ? source.filter((ask) => !ask.settled) : NO_ASKS;
  openAskMemo.set(commodoreId, { source, open });
  return open;
}

/** 서 있는 질문이 있는 화면 문맥 — 사이드바가 Theater 마다 질문 줄을 세울 때 읽는다. 정체성은 UUID다. */
export function openAskTheaters(): readonly string[] {
  const asking = new Set([...theaters.keys()].filter((commodoreId) => openAsks(commodoreId).length > 0));
  return [...contextOwners.entries()].filter(([, commodoreId]) => asking.has(commodoreId)).map(([theaterId]) => theaterId);
}

/* ── 폰 화면이 읽는 콘솔 사실 ───────────────────────────────────────── */

/** 실험 기능 켜짐을 아는가 — 전역 설정을 읽기 전이면 「꺼짐」 화면 대신 불러오는 중으로 둔다. */
export function useCommodoreExperimentKnown(): boolean {
  return useSyncExternalStore(subscribeCommodore, () => experimentsKnown, () => experimentsKnown);
}

function readOnline(): boolean {
  return (installed?.consoleState.getConnection?.() ?? "live") === "live";
}

/** 콘솔 이벤트 스트림이 살아 있는가 — 끊기면 폰 사령관 화면의 입력·토글·저장을 잠근다(채팅과 같음). */
export function useCommodoreOnline(): boolean {
  return useSyncExternalStore((listener) => installed?.consoleState.subscribe(listener) ?? (() => undefined), readOnline, readOnline);
}

/**
 * 사령관·지휘관 좌표의 선택지 — Console의 모델 로스터. 사령관 세션은 `agent`(Agent SDK, ULTRACODE 없음), 사령관이 만드는
 * 목표의 지휘관은 `launch`(Agent CLI) 대상이다. Settings › AI Gateway에서 모델을 켜고 끄면(다른 탭·기기 포함) 다시 그린다.
 * 마운트가 로스터 읽기를 시작하고(렌더 밖), 아직이면 null이다.
 */
export function useCommodoreRoster(target: ModelRosterTarget): ModelRoster | null {
  return useModelRoster(installed?.models, target);
}

/** Theater 의 표시 이름을 React 로 — Theater 목록이 늦게 읽혀도 따라온다. */
export function useCommodoreTheaterLabel(theaterId: string): string {
  return useSyncExternalStore((listener) => installed?.consoleState.subscribe(listener) ?? (() => undefined), () => commodoreTheaterLabel(theaterId), () => commodoreTheaterLabel(theaterId));
}
