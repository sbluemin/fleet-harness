import { useEffect, useSyncExternalStore, type ComponentType } from "react";
import { uploadComposerAttachment, discardComposerAttachment } from "@fleet-console/sdk/composer";

import type { AgentChatTranscriptProps, AgentConversationProps } from "@fleet-console/sdk/components/agent-chat-transcript";
import type { ModelRoster, ModelRosterTarget } from "@fleet-console/sdk/models";
import type { ClientApiCapability, PluginInstallContext } from "@fleet-console/sdk/plugin";
import { useModelRoster } from "@fleet-console/sdk/plugin/browser";

import type { CommodoreStateView } from "../server/commodore/routes.js";
import type { CommodoreAsk, CommodoreEvent, CommodoreLiveEvent, CommodoreTranscriptEntry } from "../server/commodore/types.js";
import { livePersonHold, reasonAwaits } from "../server/board-state.js";
import { PERSON_HOLD_TARGETS, type Objective, type ObjectivePersonHold } from "../server/types.js";
import { post } from "./objectives-state.js";

/**
 * 사령관(Commodore)의 브라우저 쪽 상태 — Theater 마다 서버의 `commodore/state` 한 건과 「사령관 기록」 한 쪽.
 *
 * 진실은 서버다: 화면은 응답이 아니라 `objectives:commodore` 사건으로 갱신되고, 스트림이 다시 붙으면 읽은 Theater 를
 * 다시 읽는다. 실험 기능 「자율 운영」이 꺼져 있으면 머리 글리프·메뉴·서랍이 서지 않으므로 아무것도 읽지 않는다.
 */

export const COMMODORE_CHANNEL = "objectives:commodore";

export type CommodoreTab = "log" | "directive" | "intel" | "settings";
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
  if (entry.kind === "message") return live;
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

let installed: PluginInstallContext | null = null;
const theaters = new Map<string, TheaterCommodore>();
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

/** 마지막으로 알려진 사람의 언어 — 리액트 밖에서 읽히는 Quick Launch '@' 행이 문구를 고른다. */
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

/**
 * 사이드바 줄이 읽는 사령관의 지금 — 자율 운영이 실제로 돌고 있는가(실험 기능 + 글리프), 그리고 감독자가 정체로 본 목표.
 * 읽지 않은 Theater 는 돌지 않는 것으로 다룬다. `enabled` 는 실험 기능(꺼지면 사령관 표식이 서지 않는다), `autonomy` 는 글리프,
 * `peek` 는 사람이 이 Theater 머리의 사령관 글리프에 머무는 중이다.
 */
export function commodoreBoardOf(theaterId: string): { readonly active: boolean; readonly stalled: readonly string[]; readonly enabled: boolean; readonly autonomy: boolean; readonly peek: boolean } {
  if (!enabledSnapshot) return DISABLED_BOARD;
  const view = theaters.get(theaterId)?.view;
  const peek = peekTheater === theaterId;
  if (!view?.active) return { active: false, stalled: [], enabled: true, autonomy: view?.state.autonomy === true, peek };
  return { active: true, stalled: view.run.stalled ?? [], enabled: true, autonomy: true, peek };
}
const DISABLED_BOARD = { active: false, stalled: [] as readonly string[], enabled: false, autonomy: false, peek: false };

/** 사람이 사령관 글리프에 머무는 Theater — 그동안 사이드바의 사령관 표식이 함께 밝아진다. */
let peekTheater: string | null = null;

export function setCommodorePeek(theaterId: string | null): void {
  if (peekTheater === theaterId) return;
  peekTheater = theaterId;
  notify();
}

/** 보드 화면용 — 줄 계산과 같은 값을 React 로. 읽지 않은 Theater 면 읽기를 건다. */
export function useCommodoreBoard(theaterId: string): { readonly active: boolean; readonly stalled: readonly string[] } {
  const enabled = useCommodoreEnabled();
  const board = useSyncExternalStore(subscribeCommodore, () => boardSnapshot(theaterId), () => boardSnapshot(theaterId));
  useEffect(() => { if (enabled && theaterId) void loadCommodore(theaterId); }, [enabled, theaterId]);
  return board;
}

const boardSnapshots = new Map<string, { readonly key: string; readonly value: { readonly active: boolean; readonly stalled: readonly string[] } }>();
function boardSnapshot(theaterId: string): { readonly active: boolean; readonly stalled: readonly string[] } {
  const { active, stalled } = commodoreBoardOf(theaterId);
  const value = { active, stalled };
  const key = `${value.active}:${value.stalled.join(",")}`;
  const cached = boardSnapshots.get(theaterId);
  if (cached?.key === key) return cached.value;
  boardSnapshots.set(theaterId, { key, value });
  return value;
}

function setTheater(theaterId: string, patch: Partial<TheaterCommodore>): void {
  const current = theaters.get(theaterId) ?? EMPTY;
  if (patch.view && (patch.view.state.transcriptClearedThrough ?? 0) < current.clearedThrough) return;
  const clearedThrough = Math.max(current.clearedThrough, patch.clearedThrough ?? 0, patch.view?.state.transcriptClearedThrough ?? 0);
  const cleared = clearedThrough > current.clearedThrough;
  const next = { ...current, ...patch, clearedThrough };
  if (cleared) { next.entries = []; next.live = []; next.hasMore = false; }
  next.entries = (patch.entries ?? next.entries).filter((entry) => entry.seq > clearedThrough);
  theaters.set(theaterId, next);
  notify();
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

/** 활성 Theater 가 바뀌었을 때만 울리는 구독자 — 사령관 사건은 `subscribeCommodore` 가 따로 알린다. */
const activeTheaterListeners = new Set<() => void>();

/** Quick Launch '@' 덱이 다시 읽을 때 — 사령관 상태가 바뀌었거나 활성 Theater 가 바뀌었다. */
export function subscribeCommodoreMentions(listener: () => void): () => void {
  const offCommodore = subscribeCommodore(listener);
  activeTheaterListeners.add(listener);
  return () => { offCommodore(); activeTheaterListeners.delete(listener); };
}

/** 지금 사람이 보고 있는 Theater — '@' 덱은 그 Theater 의 사령관만 행선지로 세운다. */
export function commodoreActiveTheaterId(): string | null {
  return installed?.consoleState.getActiveTheaterId() ?? null;
}

export function installCommodoreState(ctx: PluginInstallContext): () => void {
  installed = ctx;
  enabledSnapshot = readEnabled();
  experimentsKnown = readExperimentsKnown();
  // 사이드바 줄이 서지 않는 화면에서도 '@' 덱이 활성 Theater 의 사령관을 알 수 있게, 활성 Theater 는 직접 읽어 둔다.
  let activeTheater = ctx.consoleState.getActiveTheaterId();
  if (activeTheater) void loadCommodore(activeTheater);
  const offConsole = ctx.consoleState.subscribe(() => {
    const next = ctx.consoleState.getActiveTheaterId();
    if (next === activeTheater) return;
    activeTheater = next;
    if (next) void loadCommodore(next);
    for (const listener of [...activeTheaterListeners]) listener();
  });
  const offEvents = ctx.consoleEvents.subscribe(COMMODORE_CHANNEL, (payload) => {
    const event = payload as CommodoreEvent | null;
    if (!event || typeof event.theaterId !== "string") return;
    if (event.op === "state" && event.change === "clear") setTheater(event.theaterId, { clearedThrough: event.state.transcriptClearedThrough ?? 0 });
    const current = theaters.get(event.theaterId);
    if (event.op === "transcript") {
      // 아직 서랍을 연 적 없는 Theater 의 기록은 붙들지 않는다 — 열 때 한 쪽을 읽는다.
      if (!current?.transcriptLoaded) return;
      if (current.entries.some((entry) => entry.seq === event.entry.seq)) return;
      setTheater(event.theaterId, { entries: [...current.entries, event.entry].slice(-MAX_HELD_ENTRIES), live: settleLive(current.live, event.entry) });
      return;
    }
    if (event.op === "live") {
      // 기록을 열지 않은 Theater 의 흐름은 버린다 — 그릴 화면이 없고, 열 때는 확정 줄을 읽는다.
      if (!current?.transcriptLoaded) return;
      setTheater(event.theaterId, { live: appendLive(current.live, event.live) });
      return;
    }
    if (!current?.view) {
      void loadCommodore(event.theaterId, true);
      return;
    }
    if (event.op === "state") {
      const autonomy = event.state.autonomy;
      setTheater(event.theaterId, { view: { ...current.view, state: event.state, active: current.view.enabled && autonomy } });
      return;
    }
    if (event.op === "run") setTheater(event.theaterId, { view: { ...current.view, run: event.run } });
  });
  // 단절 중의 사건은 다시 오지 않는다 — 읽어 둔 Theater 를 처음부터 다시 읽는다.
  const offReconnect = ctx.consoleEvents.onReconnect?.(() => {
    for (const [theaterId, current] of theaters) {
      if (current.view) void loadCommodore(theaterId, true);
      if (current.transcriptLoaded) void loadTranscript(theaterId, { reset: true });
    }
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
    if (next && activeTheater) void loadCommodore(activeTheater);
    notify();
  });
  return () => {
    offConsole();
    offEvents();
    offReconnect?.();
    offExperiments();
    if (installed === ctx) installed = null;
    theaters.clear();
    loading.clear();
    notify();
  };
}

function api(): ClientApiCapability | null {
  return installed?.api ?? null;
}

export function loadCommodore(theaterId: string, force = false): Promise<void> {
  const client = api();
  if (!client || !enabledSnapshot) return Promise.resolve();
  if (!force && theaters.get(theaterId)?.view) return Promise.resolve();
  const inflight = loading.get(theaterId);
  if (inflight && !force) return inflight;
  const request = post<CommodoreStateView>(client, "/commodore/state", withLanguage({ theaterId }))
    .then((view) => { setTheater(theaterId, { view }); })
    .catch(() => undefined)
    .finally(() => { if (loading.get(theaterId) === request) loading.delete(theaterId); });
  loading.set(theaterId, request);
  return request;
}

export async function loadTranscript(theaterId: string, options: { readonly older?: boolean; readonly reset?: boolean } = {}): Promise<void> {
  const client = api();
  if (!client) return;
  const current = theaters.get(theaterId) ?? EMPTY;
  const before = options.older && !options.reset ? current.entries[0]?.seq : undefined;
  const page = await post<{ readonly entries: readonly CommodoreTranscriptEntry[]; readonly hasMore: boolean; readonly clearedThrough: number }>(client, "/commodore/transcript", withLanguage({ theaterId, limit: TRANSCRIPT_PAGE, ...(before !== undefined ? { before } : {}) })).catch(() => null);
  if (!page) return;
  if (page.clearedThrough < (theaters.get(theaterId)?.clearedThrough ?? 0)) return;
  setTheater(theaterId, { clearedThrough: page.clearedThrough });
  const latest = theaters.get(theaterId) ?? EMPTY;
  if (options.older && !options.reset) {
    const known = new Set(latest.entries.map((entry) => entry.seq));
    setTheater(theaterId, { entries: [...page.entries.filter((entry) => !known.has(entry.seq)), ...latest.entries], hasMore: page.hasMore, transcriptLoaded: true });
    return;
  }
  // 읽는 사이에 사건으로 들어온 줄은 쪽의 뒤에 이어 붙인다.
  const tail = latest.transcriptLoaded ? latest.entries.filter((entry) => entry.seq > (page.entries.at(-1)?.seq ?? -1)) : [];
  setTheater(theaterId, { entries: [...page.entries, ...tail], hasMore: page.hasMore, transcriptLoaded: true, ...(options.reset ? { live: [] } : {}) });
}

/** 호스트의 채팅 턴 렌더러 — Operation 채팅과 같은 컴포넌트다. 설치 전이면 null. */
export function commodoreTranscriptRenderer(): ComponentType<AgentChatTranscriptProps> | null {
  return installed?.chat.Transcript ?? null;
}

/** 대화 중심 화면의 대화 렌더러 — Operation 대화와 같은 말풍선 화면(호스트 `ctx.chat.Conversation`). */
export function commodoreConversationRenderer(): ComponentType<AgentConversationProps> | null {
  return installed?.chat.Conversation ?? null;
}

const EMPTY_VIEW_SNAPSHOT: TheaterCommodore = EMPTY;

export function readCommodore(theaterId: string): TheaterCommodore {
  return theaters.get(theaterId) ?? EMPTY_VIEW_SNAPSHOT;
}

export function useCommodore(theaterId: string): TheaterCommodore {
  return useSyncExternalStore(subscribeCommodore, () => readCommodore(theaterId), () => readCommodore(theaterId));
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

/** Theater 의 표시 이름 — 코어가 사이드바에 보이는 그대로. */
export function commodoreTheaterLabel(theaterId: string): string {
  return installed?.consoleState.getTheaters().find((theater) => theater.id === theaterId)?.label ?? "";
}

/* ── 폰 사령관 화면 ──────────────────────────────────────────────────── */

export const COMMODORE_ENTRY_ID = "commodore";

/** 목표 레일 엔트리 id — 엔트리 선언과, 그 입구를 걷는 사령관 섹션(사령관에게는 목표가 없다)이 같이 쓴다. */
export const OBJECTIVES_ENTRY_ID = "objectives";

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

/** 폰 사령관 화면을 고른 구역으로 연다 — 모바일 호스트는 목적지로 선언된 엔트리의 `rail.open`을 화면으로 연다. */
export function openCommodoreMobile(tab: CommodoreMobileTab): void {
  setCommodoreMobileTab(tab);
  installed?.rail.open(COMMODORE_ENTRY_ID);
}

/* ── 사람의 행위 ─────────────────────────────────────────────────────── */

async function write(theaterId: string, path: string, body: Record<string, unknown>): Promise<void> {
  const client = api();
  if (!client) throw new Error("not_installed");
  const view = await post<CommodoreStateView>(client, path, withLanguage({ theaterId, ...body }));
  if (view && typeof view === "object" && "state" in view) setTheater(theaterId, { view });
}

export const setCommodoreAutonomy = (theaterId: string, autonomy: boolean) => write(theaterId, "/commodore/autonomy", { autonomy });
export const saveCommodoreDirective = (theaterId: string, text: string) => write(theaterId, "/commodore/directive", { text });
export const addCommodoreIntel = (theaterId: string, text: string) => write(theaterId, "/commodore/intel/add", { text });
export const removeCommodoreIntel = (theaterId: string, intelId: string) => write(theaterId, "/commodore/intel/remove", { intelId });
export const setCommodoreCoordinates = (theaterId: string, coordinates: { readonly model: string; readonly effort: string } | null) =>
  write(theaterId, "/commodore/coordinates", coordinates ? { model: coordinates.model, effort: coordinates.effort } : { model: null, effort: null });
/** 사령관이 만드는 목표의 지휘관 모델·강도 — null 은 보드 기본값으로 되돌린다. */
export const setCommodoreCommander = (theaterId: string, commander: { readonly model: string; readonly effort?: string } | null) =>
  write(theaterId, "/commodore/commander", commander ? { model: commander.model, effort: commander.effort ?? null } : { model: null });
/** 순찰 간격(분) — null 은 기본으로 되돌린다. */
export const setCommodorePatrol = (theaterId: string, minutes: number | null) => write(theaterId, "/commodore/patrol", { minutes });
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
  return uploadComposerAttachment(file, (path, init) => installed!.api.fetch(null, path, init));
}
export function discardCommodoreAttachment(id: string): Promise<void> {
  if (!installed) return Promise.reject(new Error("not_installed"));
  return discardComposerAttachment(id, (path, init) => installed!.api.fetch(null, path, init));
}

export async function messageCommodore(theaterId: string, text: string, attachmentIds?: readonly string[]): Promise<void> {
  const client = api();
  if (!client) throw new Error("not_installed");
  const result = await post<{ readonly entry?: CommodoreTranscriptEntry }>(client, "/commodore/message", withLanguage({ theaterId, text, ...(attachmentIds?.length ? { attachmentIds } : {}) }));
  const entry = result?.entry;
  const current = theaters.get(theaterId);
  if (entry && current?.transcriptLoaded && !current.entries.some((candidate) => candidate.seq === entry.seq)) {
    setTheater(theaterId, { entries: [...current.entries, entry].slice(-MAX_HELD_ENTRIES) });
  }
}

/* ── 보드에서 세는 것 ────────────────────────────────────────────────── */

/** 지휘관이 돌고 있는 목표 — 개시했고, 끝나지 않았고, 사람의 검토·인계를 기다리지 않는다. */
export function isRunningObjective(objective: Objective): boolean {
  return !objective.removed && !objective.done && objective.commander.started && !objective.awaitingReview && !objective.awaitingHandoff;
}

const NO_ASKS: readonly CommodoreAsk[] = [];
const openAskMemo = new Map<string, { readonly source: readonly CommodoreAsk[] | undefined; readonly open: readonly CommodoreAsk[] }>();
/**
 * 사령관이 사람에게 물어 아직 답을 기다리는 질문 — 물은 순서. 「내 결정」 줄·레일 배지·확인 필요·사령관 얼굴 배지·폰 칩 배지·질문 카드가
 * 모두 이 하나를 읽는다. 읽지 않은 Theater 는 없다. 같은 상태면 같은 배열을 돌려준다(스냅샷).
 */
export function openAsks(theaterId: string | null): readonly CommodoreAsk[] {
  if (!theaterId) return NO_ASKS;
  const source = theaters.get(theaterId)?.view?.state.asks;
  const hit = openAskMemo.get(theaterId);
  if (hit && hit.source === source) return hit.open;
  const open = source?.some((ask) => !ask.settled) ? source.filter((ask) => !ask.settled) : NO_ASKS;
  openAskMemo.set(theaterId, { source, open });
  return open;
}

/** 서 있는 질문이 있는 Theater — 사이드바가 Theater 마다 질문 줄을 세울 때 읽는다(읽은 Theater 만). */
export function openAskTheaters(): readonly string[] {
  return [...theaters.keys()].filter((theaterId) => openAsks(theaterId).length > 0);
}

/**
 * 결정 요청이 누구의 차례인가 — 보드의 차례 축(`reasonAwaits`) 위에 자율 운영을 얹는다. 자율 운영이 실제로 돌지 않으면 사령관
 * 몫도 사람에게 돌아오므로 사람이다. 요청이 없거나 끝난 목표는 null. 사이드바·전환 목록·폰·레일·결정 칸이 이 하나를 읽는다.
 */
export function decisionTurn(objective: Objective, commodoreActive: boolean): "person" | "commodore" | null {
  if (objective.removed || objective.done || !objective.decisionRequest) return null;
  return !commodoreActive || reasonAwaits(objective, "decision") === "person" ? "person" : "commodore";
}

/** 사령관이 사람에게 넘겨 지금 사람이 답할 차례인 항목들 — 대상 순서(결정·기준·검토·후속)대로. */
export function livePersonHolds(objective: Objective): readonly ObjectivePersonHold[] {
  if (objective.removed) return [];
  return PERSON_HOLD_TARGETS.flatMap((target) => livePersonHold(objective, target) ?? []);
}

/**
 * 「내 결정」에 서는 시각 — 사람이 답할 결정 요청이면 그 요청 시각, 아니면 사령관이 넘긴 다른 항목(기준·검토·후속)의 가장 이른
 * 넘김 시각. 사람의 차례가 없으면 null.
 */
export function personTurnAt(objective: Objective, commodoreActive: boolean): number | null {
  if (decisionTurn(objective, commodoreActive) === "person") return objective.decisionRequest!.createdAt;
  const holds = livePersonHolds(objective);
  return holds.length ? Math.min(...holds.map((hold) => hold.at)) : null;
}

/**
 * 질문이 가리킨 목표의 제목 — 살아 있는 보드(목표 상태)를 먼저 읽어 질문이 선 뒤의 새 목표·이름 변경·제거를 바로 따른다.
 * 그 Theater 의 보드를 아직 읽지 않았으면 서버가 상태 뷰와 함께 준 제목으로 대신한다. 보드에서 사라졌으면 null.
 */
export function askObjectiveTitle(board: { readonly loaded: boolean; readonly objectives: readonly { readonly id: string; readonly title: string; readonly removed?: unknown }[] }, served: Readonly<Record<string, { readonly title: string } | null>> | undefined, objectiveId: string): string | null {
  if (!board.loaded) return served?.[objectiveId]?.title ?? null;
  const live = board.objectives.find((objective) => objective.id === objectiveId);
  return live && !live.removed ? live.title : null;
}

/**
 * 사령관이 맡아 기다리는 목표 — 사령관이 운영하고, 사람에게 넘기지 않은 대기 항목(출범 전·기준 제안·결정 요청·검토·후속)이 남았다.
 * 사람에게 넘긴 항목만 남은 목표는 사령관을 기다리지 않는다.
 */
export function isCommodoreWaiting(objective: Objective): boolean {
  if (objective.operator !== "commodore" || objective.removed || objective.done) return false;
  const kept = (target: (typeof PERSON_HOLD_TARGETS)[number]) => !livePersonHold(objective, target);
  // 출범 전 기준 제안을 사람에게 넘겼으면 개시는 사람의 답을 기다린다(criteria_pending) — 사령관의 일이 아니다.
  return (!objective.commenced && !(objective.criteriaProposals.length > 0 && !kept("criteria")))
    || (objective.criteriaProposals.length > 0 && kept("criteria"))
    || (objective.decisionRequest !== null && kept("decision"))
    || (objective.awaitingReview && kept("review"))
    || (objective.followups.some((followup) => followup.state === "open") && kept("followup"));
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
