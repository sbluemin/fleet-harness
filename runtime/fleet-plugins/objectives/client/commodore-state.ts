import { useEffect, useSyncExternalStore } from "react";

import type { ModelRoster, ModelRosterTarget } from "@fleet-console/sdk/models";
import type { ClientApiCapability, PluginInstallContext } from "@fleet-console/sdk/plugin";
import { useModelRoster } from "@fleet-console/sdk/plugin/browser";

import type { CommodoreStateView } from "../server/commodore/routes.js";
import type { CommodoreEvent, CommodoreTranscriptEntry } from "../server/commodore/types.js";
import type { Objective } from "../server/types.js";
import { post } from "./objectives-state.js";

/**
 * 사령관(Commodore)의 브라우저 쪽 상태 — Theater 마다 서버의 `commodore/state` 한 건과 「사령관 기록」 한 쪽.
 *
 * 진실은 서버다: 화면은 응답이 아니라 `objectives:commodore` 사건으로 갱신되고, 스트림이 다시 붙으면 읽은 Theater 를
 * 다시 읽는다. 실험 기능 「자율 운영」이 꺼져 있으면 사령관 줄·메뉴·서랍이 서지 않으므로 아무것도 읽지 않는다.
 */

export const COMMODORE_CHANNEL = "objectives:commodore";

export type CommodoreTab = "log" | "directive" | "intel" | "settings";

interface TheaterCommodore {
  readonly view: CommodoreStateView | null;
  readonly entries: readonly CommodoreTranscriptEntry[];
  readonly hasMore: boolean;
  /** 기록을 한 번이라도 읽었는가 — 서랍이 처음 열릴 때만 읽는다. */
  readonly transcriptLoaded: boolean;
}

const EMPTY: TheaterCommodore = { view: null, entries: [], hasMore: false, transcriptLoaded: false };
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
 * 사람이 읽는 Console 언어 — 사령관 줄·서랍이 그릴 때 알려 주고, 모든 commodore/* 요청 본문에 실린다. 서버는 Theater 마다
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

let drawer: { readonly theaterId: string; readonly tab: CommodoreTab; readonly openedAt: number } | null = null;

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
 * `peek` 는 사람이 이 Theater 의 사령관 줄에 머무는 중이다.
 */
export function commodoreBoardOf(theaterId: string): { readonly active: boolean; readonly stalled: readonly string[]; readonly enabled: boolean; readonly autonomy: boolean; readonly peek: boolean } {
  if (!enabledSnapshot) return DISABLED_BOARD;
  const view = theaters.get(theaterId)?.view;
  const peek = peekTheater === theaterId;
  if (!view?.active) return { active: false, stalled: [], enabled: true, autonomy: view?.state.autonomy === true, peek };
  return { active: true, stalled: view.run.stalled ?? [], enabled: true, autonomy: true, peek };
}
const DISABLED_BOARD = { active: false, stalled: [] as readonly string[], enabled: false, autonomy: false, peek: false };

/** 사람이 머무는 사령관 줄의 Theater — 그동안 사이드바의 사령관 표식이 함께 밝아진다. */
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
  theaters.set(theaterId, { ...(theaters.get(theaterId) ?? EMPTY), ...patch });
  notify();
}

function readEnabled(): boolean {
  return installed?.experiments.read()?.commodore === true;
}

function readExperimentsKnown(): boolean {
  return (installed?.experiments.read() ?? null) !== null;
}

/**
 * 모바일 드로어 「사령관」 목적지의 보임 — 실험 기능 「자율 운영」이 켜져 있을 때만 선다(Theater 가 아직 안 읽힌 부팅 직후에도 판정은 같다).
 * 전역 설정을 아직 읽지 못한 부팅 직후에는 둔다: 이때 false 를 돌려주면 사령관 화면을 보던 새로고침이 홈으로 튕긴다.
 * 드로어는 부팅 직후 닫혀 있으므로 줄이 잠깐 서는 일은 보이지 않는다.
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
    const current = theaters.get(event.theaterId);
    if (event.op === "transcript") {
      // 아직 서랍을 연 적 없는 Theater 의 기록은 붙들지 않는다 — 열 때 한 쪽을 읽는다.
      if (!current?.transcriptLoaded) return;
      if (current.entries.some((entry) => entry.seq === event.entry.seq)) return;
      setTheater(event.theaterId, { entries: [...current.entries, event.entry].slice(-MAX_HELD_ENTRIES) });
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
    if (!next) drawer = null;
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
    drawer = null;
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
  const page = await post<{ readonly entries: readonly CommodoreTranscriptEntry[]; readonly hasMore: boolean }>(client, "/commodore/transcript", withLanguage({ theaterId, limit: TRANSCRIPT_PAGE, ...(before !== undefined ? { before } : {}) })).catch(() => null);
  if (!page) return;
  const latest = theaters.get(theaterId) ?? EMPTY;
  if (options.older && !options.reset) {
    const known = new Set(latest.entries.map((entry) => entry.seq));
    setTheater(theaterId, { entries: [...page.entries.filter((entry) => !known.has(entry.seq)), ...latest.entries], hasMore: page.hasMore, transcriptLoaded: true });
    return;
  }
  // 읽는 사이에 사건으로 들어온 줄은 쪽의 뒤에 이어 붙인다.
  const tail = latest.transcriptLoaded ? latest.entries.filter((entry) => entry.seq > (page.entries.at(-1)?.seq ?? -1)) : [];
  setTheater(theaterId, { entries: [...page.entries, ...tail], hasMore: page.hasMore, transcriptLoaded: true });
}

const EMPTY_VIEW_SNAPSHOT: TheaterCommodore = EMPTY;

export function readCommodore(theaterId: string): TheaterCommodore {
  return theaters.get(theaterId) ?? EMPTY_VIEW_SNAPSHOT;
}

export function useCommodore(theaterId: string): TheaterCommodore {
  return useSyncExternalStore(subscribeCommodore, () => readCommodore(theaterId), () => readCommodore(theaterId));
}

/** 실험 기능 「자율 운영」 — 꺼져 있으면 사령관 줄·메뉴·서랍이 서지 않는다. */
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

/* ── 서랍 ─────────────────────────────────────────────────────────────── */

export function openCommodoreDrawer(theaterId: string, tab: CommodoreTab = "log"): void {
  if (!enabledSnapshot) return;
  drawer = { theaterId, tab, openedAt: Date.now() };
  void loadCommodore(theaterId);
  if (!(theaters.get(theaterId)?.transcriptLoaded)) void loadTranscript(theaterId);
  notify();
}

export const COMMODORE_ENTRY_ID = "commodore";

/** 폰 사령관 화면의 고른 구역 — 다시 들어와도 유지한다(S-54 CM-2a). 서랍을 열려던 길·Theater 시트 행도 여기에 구역을 남긴다. */
let mobileTab: CommodoreTab = "log";

export function setCommodoreMobileTab(tab: CommodoreTab): void {
  if (mobileTab === tab) return;
  mobileTab = tab;
  notify();
}

export function useCommodoreMobileTab(): CommodoreTab {
  return useSyncExternalStore(subscribeCommodore, () => mobileTab, () => mobileTab);
}

/** 폰 사령관 화면을 고른 구역으로 연다 — 모바일 호스트는 목적지로 선언된 엔트리의 `rail.open`을 화면으로 연다. */
export function openCommodoreMobile(tab: CommodoreTab): void {
  setCommodoreMobileTab(tab);
  installed?.rail.open(COMMODORE_ENTRY_ID);
}

/**
 * 폰 배치에서 서랍이 열려 있으면 — 상주 시트는 폰에서 서지 않는다 — 서랍을 닫고 같은 구역으로 드로어 목적지 「사령관」 화면을 연다.
 */
export function routeCommodoreDrawerToMobile(): void {
  if (!drawer) return;
  const tab = drawer.tab;
  drawer = null;
  notify();
  openCommodoreMobile(tab);
}

export function setCommodoreTab(tab: CommodoreTab): void {
  if (!drawer || drawer.tab === tab) return;
  drawer = { ...drawer, tab };
  notify();
}

export function closeCommodoreDrawer(): void {
  if (!drawer) return;
  drawer = null;
  notify();
}

export function toggleCommodoreDrawer(theaterId: string): void {
  if (drawer?.theaterId === theaterId) closeCommodoreDrawer();
  else openCommodoreDrawer(theaterId, "log");
}

export function useCommodoreDrawer(): typeof drawer {
  return useSyncExternalStore(subscribeCommodore, () => drawer, () => drawer);
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
export const retryCommodore = (theaterId: string) => write(theaterId, "/commodore/retry", {});

export async function messageCommodore(theaterId: string, text: string): Promise<void> {
  const client = api();
  if (!client) throw new Error("not_installed");
  const result = await post<{ readonly entry?: CommodoreTranscriptEntry }>(client, "/commodore/message", withLanguage({ theaterId, text }));
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

/** 사람(또는 사령관)의 손을 기다리는 목표 — 출범 전·기준 제안·결정 요청·검토 대기·후속 후보 중 하나라도. */
export function isWaitingObjective(objective: Objective): boolean {
  if (objective.removed || objective.done) return false;
  return !objective.commenced
    || objective.criteriaProposals.length > 0
    || objective.decisionRequest !== null
    || objective.awaitingReview
    || objective.followups.some((followup) => followup.state === "open");
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

/** 실험 기능 「자율 운영」 — 리액트 밖(호스트가 구독으로 읽는 공급원)에서 쓰는 지금 값. */
export function isCommodoreEnabled(): boolean {
  return enabledSnapshot;
}

/** Theater 의 표시 이름을 React 로 — Theater 목록이 늦게 읽혀도 따라온다. */
export function useCommodoreTheaterLabel(theaterId: string): string {
  return useSyncExternalStore((listener) => installed?.consoleState.subscribe(listener) ?? (() => undefined), () => commodoreTheaterLabel(theaterId), () => commodoreTheaterLabel(theaterId));
}
