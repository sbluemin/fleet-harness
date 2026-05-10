/**
 * panel/state.ts — 에이전트 패널 모듈-레벨 상태 + 스트리밍 이벤트 소비
 *
 * 패널 모듈 내부에서만 사용합니다.
 * fleet-core의 스트리밍 이벤트를 받아 Pi가 렌더링 상태를 직접 소유합니다.
 */

import type { ExtensionAPI } from "@sbluemin/fleet-coding-agent";
import { admiral } from "@sbluemin/fleet-core";
import type {
  CarrierJobStreamEvent,
  CarrierCategory,
  TrackMeta,
  TrackStatus,
} from "@sbluemin/fleet-core";
import type { ServiceSnapshot } from "@sbluemin/fleet-unified-agent";
import { DEFAULT_BODY_H, ANIM_INTERVAL_MS } from "../fleet-core-facades.js";
import { getActiveBackgroundJobCount } from "../fleet-core-facades.js";
import { CARRIER_RESULT_CUSTOM_TYPE, type CarrierResultMessageDetails } from "../jobs.js";
import { getDeliverAs } from "../settings.js";
import { getRegisteredCarrierConfig, getRegisteredOrder, isSquadronCarrierEnabled } from "../tools.js";
import {
  coalesceTextBlock,
  coalesceThoughtBlock,
  upsertToolBlock,
} from "./stream-reducers.js";
import { syncCurrentWidget } from "./widget-sync.js";
import type { AgentCol, ColBlock, ColStatus, ColumnTrack, PanelJob } from "./types.js";

export type { AgentCol } from "./types.js";
export type { ServiceSnapshot } from "@sbluemin/fleet-unified-agent";

export interface FooterModelInfo {
  model: string;
  effort?: string;
}

export interface PanelRun {
  runId: string;
  cli: string;
  blocks: ColBlock[];
  status: ColStatus;
  sessionId?: string;
  error?: string;
  requestPreview?: string;
  text: string;
  thinking: string;
  toolCalls: { title: string; status: string }[];
  toCollectedData(): CollectedPanelStreamData;
}

export interface CollectedPanelStreamData {
  text: string;
  thinking: string;
  toolCalls: { title: string; status: string }[];
  blocks: ColBlock[];
  lastStatus: string;
}

export interface AgentPanelState {
  cols: AgentCol[];
  panelJobs: Map<string, PanelJob>;
  runs: Map<string, PanelRun>;
  expanded: boolean;
  streaming: boolean;
  frame: number;
  animTimer: ReturnType<typeof setInterval> | null;
  bottomHint: string;
  /** 캐리어별(carrierId) 모델 설정 */
  modelConfig: Record<string, FooterModelInfo>;
  serviceSnapshots: ServiceSnapshot[];
  serviceLastUpdatedAt: number | null;
  serviceLoading: boolean;
  toggleCallbacks: Array<(expanded: boolean) => void>;
  bodyH: number;
  /** Carrier Job HUD 가상 포커스 활성 여부 */
  jobBarMode: boolean;
  /** Carrier Job HUD 포커스된 캐리어 인덱스 (-1 = 비활성) */
  jobBarCursor: number;
  /** Carrier Job HUD 확장된 carrierId */
  jobBarExpandedJobId: string | null;
}

export const PANEL_JOB_RETENTION = 8;
export const PANEL_BRIDGE_HINT = " alt+j/k · alt+p ";

const { getSessionIdFor } = admiral.agent.connections;
const CATEGORY_ORDER: CarrierCategory[] = ["strategy", "planning", "operations"];
const CATEGORY_RANK = new Map<CarrierCategory | "uncategorized", number>(
  [...CATEGORY_ORDER.map((c, i) => [c, i] as const), ["uncategorized", CATEGORY_ORDER.length] as const],
);

let panelState: AgentPanelState | null = null;
let carrierResultPi: ExtensionAPI | null = null;

function sortByCategory(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    const catA = getRegisteredCarrierConfig(a)?.carrierMetadata?.category ?? "uncategorized";
    const catB = getRegisteredCarrierConfig(b)?.carrierMetadata?.category ?? "uncategorized";
    const rankA = CATEGORY_RANK.get(catA) ?? CATEGORY_ORDER.length;
    const rankB = CATEGORY_RANK.get(catB) ?? CATEGORY_ORDER.length;
    if (rankA !== rankB) return rankA - rankB;
    const slotA = getRegisteredCarrierConfig(a)?.slot ?? 0;
    const slotB = getRegisteredCarrierConfig(b)?.slot ?? 0;
    return slotA - slotB;
  });
}

export function bindCarrierJobStreamPi(pi: ExtensionAPI | null): void {
  carrierResultPi = pi;
}

/**
 * 동적으로 등록된 carrier 순서를 반환합니다.
 * index.ts가 registerCarriers()를 먼저 호출한 뒤 panel/runtime 초기화를 진행하므로
 * 기본 경로에서는 여기서 빈 registeredOrder를 보지 않습니다.
 */
export function getDefaultClis(): readonly string[] {
  return sortByCategory(getRegisteredOrder().filter((id: string) => !isSquadronCarrierEnabled(id)));
}

export function getState(): AgentPanelState {
  let s = panelState;
  if (!s) {
    s = {
      cols: makeCols(),
      panelJobs: new Map(),
      runs: new Map(),
      expanded: false,
      streaming: false,
      frame: 0,
      animTimer: null,
      bottomHint: PANEL_BRIDGE_HINT,
      modelConfig: {},
      serviceSnapshots: [],
      serviceLastUpdatedAt: null,
      serviceLoading: false,
      toggleCallbacks: [],
      bodyH: DEFAULT_BODY_H,
      jobBarMode: false,
      jobBarCursor: -1,
      jobBarExpandedJobId: null,
    };
    panelState = s;
  }

  if (s.cols.length === 0 && getDefaultClis().length > 0) {
    s.cols = makeCols();
  }

  return s;
}

export function resetPanelStateForTest(): void {
  if (panelState?.animTimer) {
    clearInterval(panelState.animTimer);
  }
  panelState = null;
}

export function makeCols(clis?: readonly string[]): AgentCol[] {
  const targets = clis ?? getDefaultClis();

  return targets.map((cli) => ({
    cli,
    sessionId: getSessionIdFor(cli),
    text: "",
    blocks: [],
    thinking: "",
    toolCalls: [],
    status: "wait" as const,
    scroll: 0,
  }));
}

export function getPanelJobs(): Map<string, PanelJob> {
  return getState().panelJobs;
}

export function getPanelRuns(): Map<string, PanelRun> {
  return getState().runs;
}

export function getActiveJobs(): PanelJob[] {
  return Array.from(getPanelJobs().values())
    .filter((job) => job.status === "active")
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function getJobById(jobId: string): PanelJob | undefined {
  return getPanelJobs().get(jobId);
}

export function getRegisteredCarrierCols(): AgentCol[] {
  return getState().cols;
}

/** carrierId에 해당하는 cols 배열 내 인덱스를 반환합니다. 없으면 -1. */
export function findColIndex(carrierId: string): number {
  return getState().cols.findIndex((col) => col.cli === carrierId);
}

export function syncColsWithRegisteredOrder(): void {
  const s = getState();
  const existing = new Map(s.cols.map((col) => [col.cli, col] as const));
  const orderedIds = getDefaultClis();

  s.cols = orderedIds.map((cli) => {
    const col = existing.get(cli);
    const sessionId = getSessionIdFor(cli);
    if (col) {
      col.sessionId = sessionId ?? col.sessionId;
      return col;
    }

    return {
      cli,
      sessionId,
      text: "",
      blocks: [],
      thinking: "",
      toolCalls: [],
      status: "wait" as const,
      error: undefined,
      scroll: 0,
    };
  });
}

export function makeFooterCols(): AgentCol[] {
  const s = getState();
  const activeCols = new Map(s.cols.map((col) => [col.cli, col] as const));

  return sortByCategory(getRegisteredOrder()).map((cli) => {
    const activeCol = activeCols.get(cli);
    if (activeCol) return activeCol;

    return {
      cli,
      sessionId: getSessionIdFor(cli),
      text: "",
      blocks: [],
      thinking: "",
      toolCalls: [],
      status: "wait" as const,
      error: undefined,
      scroll: 0,
    };
  });
}

export function handleCarrierJobStreamEvent(event: CarrierJobStreamEvent): void {
  if (event.type === "job:registered") {
    registerStreamJob(event);
    schedulePanelRender(true);
    return;
  }

  if (event.type === "job:finalized") {
    finalizeStreamJob(event);
    schedulePanelRender(false);
    dispatchCarrierResultSystemReminder(event);
    return;
  }

  if (event.type === "track:begin") {
    beginTrack(event);
    schedulePanelRender(true);
    return;
  }

  if (event.type === "track:status") {
    updateTrackStatus(event.jobId, event.trackId, event.status);
    schedulePanelRender(isActiveTrackStatus(event.status));
    return;
  }

  if (event.type === "track:runId") {
    updateTrackRunId(event.jobId, event.trackId, event.runId);
    schedulePanelRender(true);
    return;
  }

  if (event.type === "track:text") {
    updateRunBlocks(event.jobId, event.trackId, (run) => {
      coalesceTextBlock(run.blocks, event.text);
      run.status = "stream";
    });
    schedulePanelRender(true);
    return;
  }

  if (event.type === "track:thought") {
    updateRunBlocks(event.jobId, event.trackId, (run) => {
      coalesceThoughtBlock(run.blocks, event.text);
      run.status = "stream";
    });
    schedulePanelRender(true);
    return;
  }

  if (event.type === "track:tool") {
    updateRunBlocks(event.jobId, event.trackId, (run) => {
      upsertToolBlock(run.blocks, event.toolCallId, event.title, event.status);
      if (run.status === "wait" || run.status === "conn") run.status = "stream";
    });
    schedulePanelRender(true);
    return;
  }

  finalizeTrack(event);
  schedulePanelRender(false);
}

function dispatchCarrierResultSystemReminder(event: Extract<CarrierJobStreamEvent, { type: "job:finalized" }>): void {
  if (typeof event.systemReminder !== "string" || event.systemReminder.trim().length === 0) return;
  if (!carrierResultPi) return;
  const details: CarrierResultMessageDetails = {
    jobIds: [event.jobId],
    summaries: [event.summary],
  };
  carrierResultPi.sendMessage({
    customType: CARRIER_RESULT_CUSTOM_TYPE,
    content: event.systemReminder,
    display: false,
    details,
  }, {
    triggerTurn: true,
    deliverAs: getDeliverAs(),
  });
}

export function getGrandFleetStreamStoreState(): {
  runs: Map<string, Pick<PanelRun, "error" | "requestPreview" | "status">>;
  visibleRunIdByCli: Map<string, string>;
} {
  const runs = new Map<string, Pick<PanelRun, "error" | "requestPreview" | "status">>();
  const visibleRunIdByCli = new Map<string, string>();

  for (const job of getPanelJobs().values()) {
    for (const track of job.tracks) {
      const run = resolveRunForTrack(track);
      if (!run) continue;
      runs.set(run.runId, {
        error: run.error,
        requestPreview: run.requestPreview,
        status: run.status,
      });
      visibleRunIdByCli.set(track.displayCli, run.runId);
    }
  }

  return { runs, visibleRunIdByCli };
}

function registerStreamJob(event: Extract<CarrierJobStreamEvent, { type: "job:registered" }>): void {
  const s = getState();
  const job: PanelJob = {
    jobId: event.jobId,
    kind: event.kind,
    ownerCarrierId: event.ownerCarrierId,
    label: event.label,
    startedAt: event.startedAt,
    status: "active",
    activeJobToolCallId: event.activeJobToolCallId,
    tracks: event.tracks.map(toColumnTrack),
  };
  s.panelJobs.set(job.jobId, job);
  for (const track of job.tracks) {
    const runId = track.runId ?? track.streamKey;
    const run = ensureRun(runId, track.displayCli, "wait");
    run.sessionId = getSessionIdFor(track.displayCli) ?? run.sessionId;
    s.runs.set(track.streamKey, run);
  }
  s.streaming = true;
}

function finalizeStreamJob(event: Extract<CarrierJobStreamEvent, { type: "job:finalized" }>): void {
  const job = getPanelJobs().get(event.jobId);
  if (!job) return;
  job.status = event.status;
  job.finishedAt = event.finishedAt;
  trimFinalizedJobs();
  getState().streaming = getActiveJobs().length > 0;
}

function beginTrack(event: Extract<CarrierJobStreamEvent, { type: "track:begin" }>): void {
  const track = getTrack(event.jobId, event.trackId);
  if (!track) return;
  const run = ensureRun(track.runId ?? track.streamKey, track.displayCli, "conn");
  run.requestPreview = event.requestPreview ?? run.requestPreview;
  track.status = "conn";
  syncCarrierColumn(track, run);
}

function updateTrackStatus(jobId: string, trackId: string, status: TrackStatus): void {
  const track = getTrack(jobId, trackId);
  if (!track) return;
  track.status = toColStatus(status);
  const run = resolveRunForTrack(track);
  if (run) {
    run.status = track.status;
    syncCarrierColumn(track, run);
  }
}

function updateTrackRunId(jobId: string, trackId: string, runId: string): void {
  const track = getTrack(jobId, trackId);
  if (!track) return;
  const previousRun = resolveRunForTrack(track);
  track.runId = runId;
  const run = previousRun ?? ensureRun(runId, track.displayCli, "conn");
  run.runId = runId;
  run.cli = track.displayCli;
  if (run.status === "wait") run.status = "conn";
  getPanelRuns().set(runId, run);
  getPanelRuns().set(track.streamKey, run);
  syncCarrierColumn(track, run);
}

function updateRunBlocks(jobId: string, trackId: string, update: (run: PanelRun) => void): void {
  const track = getTrack(jobId, trackId);
  if (!track) return;
  const run = resolveRunForTrack(track) ?? ensureRun(track.runId ?? track.streamKey, track.displayCli, "stream");
  update(run);
  refreshRunDerivedFields(run);
  syncCarrierColumn(track, run);
}

function finalizeTrack(event: Extract<CarrierJobStreamEvent, { type: "track:finalized" }>): void {
  const track = getTrack(event.jobId, event.trackId);
  if (!track) return;
  const run = resolveRunForTrack(track) ?? ensureRun(track.runId ?? track.streamKey, track.displayCli, toColStatus(event.status));
  track.status = toColStatus(event.status);
  run.status = track.status;
  if (event.sessionId !== undefined) run.sessionId = event.sessionId;
  if (event.error !== undefined) run.error = event.error;
  prependFallbackBlocks(run, event.fallbackText, event.fallbackThought);
  refreshRunDerivedFields(run);
  syncCarrierColumn(track, run);
  getState().streaming = hasActiveStreamingTrack();
}

function toColumnTrack(input: TrackMeta): ColumnTrack {
  return {
    trackId: input.trackId,
    streamKey: input.streamKey,
    displayCli: input.displayCli,
    runId: input.runId,
    displayName: input.displayName,
    subtitle: input.subtitle,
    kind: input.kind,
    status: "wait",
  };
}

function getTrack(jobId: string, trackId: string): ColumnTrack | undefined {
  return getPanelJobs().get(jobId)?.tracks.find((track) => track.trackId === trackId);
}

function ensureRun(runId: string, cli: string, status: ColStatus): PanelRun {
  const runs = getPanelRuns();
  const existing = runs.get(runId);
  if (existing) {
    existing.cli = cli;
    if (existing.status === "wait" || status !== "wait") existing.status = status;
    return existing;
  }
  const run = createPanelRun(runId, cli, status);
  runs.set(runId, run);
  return run;
}

function createPanelRun(runId: string, cli: string, status: ColStatus): PanelRun {
  return {
    runId,
    cli,
    blocks: [],
    status,
    text: "",
    thinking: "",
    toolCalls: [],
    toCollectedData() {
      return {
        text: this.text,
        thinking: this.thinking,
        toolCalls: this.toolCalls.map((toolCall) => ({ ...toolCall })),
        blocks: this.blocks.map((block) => ({ ...block })),
        lastStatus: this.status,
      };
    },
  };
}

function resolveRunForTrack(track: ColumnTrack): PanelRun | undefined {
  return (
    (track.runId ? getPanelRuns().get(track.runId) : undefined) ??
    getPanelRuns().get(track.streamKey) ??
    getPanelRuns().get(track.trackId)
  );
}

function refreshRunDerivedFields(run: PanelRun): void {
  run.text = run.blocks
    .filter((block): block is Extract<ColBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  run.thinking = run.blocks
    .filter((block): block is Extract<ColBlock, { type: "thought" }> => block.type === "thought")
    .map((block) => block.text)
    .join("");
  run.toolCalls = run.blocks
    .filter((block): block is Extract<ColBlock, { type: "tool" }> => block.type === "tool")
    .map((block) => ({ title: block.title, status: block.status }));
}

function prependFallbackBlocks(run: PanelRun, fallbackText?: string, fallbackThought?: string): void {
  if (fallbackText && !run.text.trim()) {
    run.blocks.unshift({ type: "text", text: fallbackText });
  }
  if (fallbackThought && !run.thinking.trim()) {
    run.blocks.unshift({ type: "thought", text: fallbackThought });
  }
}

function syncCarrierColumn(track: ColumnTrack, run: PanelRun): void {
  const colIndex = findColIndex(track.displayCli);
  if (colIndex < 0) return;
  const col = getState().cols[colIndex];
  if (!col) return;
  Object.assign(col, {
    sessionId: run.sessionId ?? col.sessionId,
    status: run.status,
    text: run.text,
    thinking: run.thinking,
    toolCalls: run.toolCalls,
    blocks: run.blocks,
    error: run.error,
  });
}

function toColStatus(status: TrackStatus): ColStatus {
  if (status === "done") return "done";
  if (status === "err" || status === "aborted") return "err";
  if (status === "stream") return "stream";
  if (status === "conn") return "conn";
  return "wait";
}

function isActiveTrackStatus(status: TrackStatus): boolean {
  return status === "conn" || status === "stream";
}

function hasActiveStreamingTrack(): boolean {
  return getActiveJobs().some((job) =>
    job.tracks.some((track) => track.status === "conn" || track.status === "stream"),
  );
}

function trimFinalizedJobs(): void {
  const jobs = getPanelJobs();
  const finalized = Array.from(jobs.values())
    .filter((job) => job.status !== "active" && job.finishedAt)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  for (const job of finalized.slice(PANEL_JOB_RETENTION)) {
    jobs.delete(job.jobId);
  }
}

function schedulePanelRender(animate: boolean): void {
  if (animate) ensurePanelAnimTimer();
  syncCurrentWidget();
  if (!animate) stopPanelAnimTimerIfIdle();
}

function ensurePanelAnimTimer(): void {
  const s = getState();
  if (s.animTimer) return;
  s.animTimer = setInterval(() => {
    s.frame++;
    syncCurrentWidget();
    stopPanelAnimTimerIfIdle();
  }, ANIM_INTERVAL_MS);
}

function stopPanelAnimTimerIfIdle(): void {
  const s = getState();
  const stillStreaming =
    s.streaming ||
    s.cols.some((col) => col.status === "conn" || col.status === "stream") ||
    getActiveJobs().length > 0;
  if (stillStreaming || getActiveBackgroundJobCount() > 0) return;
  if (!s.animTimer) return;
  clearInterval(s.animTimer);
  s.animTimer = null;
}
