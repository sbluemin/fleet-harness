import type {
  CarrierJobStreamEvent,
  CarrierRuntime,
  TrackMeta,
  TrackStatus,
} from "@sbluemin/fleet-carriers";
import {
  ANIM_INTERVAL_MS,
  DEFAULT_BODY_H,
} from "../admiral/constants.js";
import {
  getActiveBackgroundJobCount,
  getRegisteredOrder,
} from "@sbluemin/fleet-carriers";
import { getSessionIdFor as getAgentSessionIdFor } from "@sbluemin/fleet-infra/agent";

import type { ColBlock, ColStatus, ColumnTrack, PanelJob, PanelRunViewModelSource } from "./job-bar-view-model.js";

export interface FooterModelInfo {
  readonly effort?: string;
  readonly model: string;
}

export interface AgentCol {
  blocks: ColBlock[];
  cli: string;
  error?: string;
  scroll: number;
  sessionId?: string;
  status: ColStatus;
  text: string;
  thinking: string;
  toolCalls: Array<{ status: string; title: string }>;
}

export interface CollectedPanelStreamData {
  readonly blocks: ColBlock[];
  readonly lastStatus: string;
  readonly text: string;
  readonly thinking: string;
  readonly toolCalls: Array<{ readonly status: string; readonly title: string }>;
}

export interface PanelRun extends PanelRunViewModelSource {
  blocks: ColBlock[];
  cli: string;
  error?: string;
  requestPreview?: string;
  runId: string;
  sessionId?: string;
  status: ColStatus;
  text: string;
  thinking: string;
  toolCalls: Array<{ status: string; title: string }>;
  toCollectedData(): CollectedPanelStreamData;
}

export interface AgentPanelState {
  animTimer: ReturnType<typeof setInterval> | null;
  bodyH: number;
  cols: AgentCol[];
  expanded: boolean;
  frame: number;
  modelConfig: Record<string, FooterModelInfo>;
  panelJobs: Map<string, MutablePanelJob>;
  runs: Map<string, PanelRun>;
  serviceLastUpdatedAt: number | null;
  serviceLoading: boolean;
  serviceSnapshots: unknown[];
  streaming: boolean;
  toggleCallbacks: Array<(expanded: boolean) => void>;
}

export interface JobBarStateOptions {
  readonly carrierRuntime: CarrierRuntime;
  readonly onCarrierResultReminder?: (text: string) => void;
  readonly onRenderRequest?: () => void;
}

export interface JobBarState {
  readonly carrierRuntime: CarrierRuntime;
  dispose(): void;
  ensurePanelAnimTimer(): void;
  getActiveJobs(): PanelJob[];
  getGrandFleetStreamStoreState(): {
    runs: Map<string, Pick<PanelRun, "error" | "requestPreview" | "status">>;
  };
  getJobById(jobId: string): PanelJob | undefined;
  getPanelJobs(): Map<string, MutablePanelJob>;
  getPanelRuns(): Map<string, PanelRun>;
  getRegisteredCarrierCols(): AgentCol[];
  getState(): AgentPanelState;
  handleCarrierJobStreamEvent(event: CarrierJobStreamEvent): void;
  isRuntimeBound(): boolean;
  makeFooterCols(): AgentCol[];
  schedulePanelRender(animate: boolean): void;
  syncColsWithRegisteredOrder(): void;
}

type MutableColumnTrack = {
  -readonly [K in keyof ColumnTrack]: ColumnTrack[K];
};

type MutablePanelJob = Omit<PanelJob, "tracks"> & {
  activeJobToolCallId?: string;
  finishedAt?: number;
  status: PanelJob["status"];
  tracks: MutableColumnTrack[];
};

type JobBarStateBindings = {
  onCarrierResultReminder: (text: string) => void;
  onRenderRequest: () => void;
};

export const PANEL_JOB_RETENTION = 8;

export function createJobBarState(options: JobBarStateOptions): JobBarState {
  let stateValue: AgentPanelState | null = null;
  const bindings: JobBarStateBindings = {
    onCarrierResultReminder: options.onCarrierResultReminder ?? noop,
    onRenderRequest: options.onRenderRequest ?? noop,
  };

  return {
    carrierRuntime: options.carrierRuntime,
    dispose: disposeJobBarState,
    ensurePanelAnimTimer,
    getActiveJobs,
    getGrandFleetStreamStoreState,
    getJobById,
    getPanelJobs,
    getPanelRuns,
    getRegisteredCarrierCols,
    getState,
    handleCarrierJobStreamEvent,
    isRuntimeBound,
    makeFooterCols,
    schedulePanelRender,
    syncColsWithRegisteredOrder,
  };

function getState(): AgentPanelState {
  let state = stateValue;
  if (!state) {
    state = {
      animTimer: null,
      bodyH: DEFAULT_BODY_H,
      cols: makeCols(),
      expanded: false,
      frame: 0,
      modelConfig: {},
      panelJobs: new Map(),
      runs: new Map(),
      serviceLastUpdatedAt: null,
      serviceLoading: false,
      serviceSnapshots: [],
      streaming: false,
      toggleCallbacks: [],
    };
    stateValue = state;
  }

  if (state.cols.length === 0 && getDefaultClis().length > 0) {
    state.cols = makeCols();
  }

  return state;
}

function disposeJobBarState(): void {
  if (stateValue?.animTimer) {
    clearInterval(stateValue.animTimer);
    stateValue.animTimer = null;
  }
}

function isRuntimeBound(): boolean {
  return true;
}

function getDefaultClis(): readonly string[] {
  return [...getRegisteredOrder(options.carrierRuntime.registry)];
}

function makeCols(clis?: readonly string[]): AgentCol[] {
  const targets = clis ?? getDefaultClis();
  return targets.map((cli) => ({
    blocks: [],
    cli,
    scroll: 0,
    sessionId: getSessionIdFor(cli),
    status: "wait" as const,
    text: "",
    thinking: "",
    toolCalls: [],
  }));
}

function getPanelJobs(): Map<string, MutablePanelJob> {
  return getState().panelJobs;
}

function getPanelRuns(): Map<string, PanelRun> {
  return getState().runs;
}

function getActiveJobs(): PanelJob[] {
  return Array.from(getPanelJobs().values())
    .filter((job) => job.status === "active")
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(toReadonlyPanelJob);
}

function getJobById(jobId: string): PanelJob | undefined {
  const job = getPanelJobs().get(jobId);
  return job ? toReadonlyPanelJob(job) : undefined;
}

function getRegisteredCarrierCols(): AgentCol[] {
  return getState().cols;
}

function findColIndex(carrierId: string): number {
  return getState().cols.findIndex((col) => col.cli === carrierId);
}

function syncColsWithRegisteredOrder(): void {
  const state = getState();
  const existing = new Map(state.cols.map((col) => [col.cli, col] as const));
  const orderedIds = getDefaultClis();

  state.cols = orderedIds.map((cli) => {
    const col = existing.get(cli);
    const sessionId = getSessionIdFor(cli);
    if (col) {
      col.sessionId = sessionId ?? col.sessionId;
      return col;
    }

    return {
      blocks: [],
      cli,
      error: undefined,
      scroll: 0,
      sessionId,
      status: "wait" as const,
      text: "",
      thinking: "",
      toolCalls: [],
    };
  });
}

function makeFooterCols(): AgentCol[] {
  const state = getState();
  const activeCols = new Map(state.cols.map((col) => [col.cli, col] as const));

  return [...getRegisteredOrder(options.carrierRuntime.registry)].map((cli) => {
    const activeCol = activeCols.get(cli);
    if (activeCol) return activeCol;

    return {
      blocks: [],
      cli,
      error: undefined,
      scroll: 0,
      sessionId: getSessionIdFor(cli),
      status: "wait" as const,
      text: "",
      thinking: "",
      toolCalls: [],
    };
  });
}

function handleCarrierJobStreamEvent(event: CarrierJobStreamEvent): void {
  switch (event.type) {
    case "job:registered":
      registerStreamJob(event);
      schedulePanelRender(true);
      return;
    case "job:finalized":
      finalizeStreamJob(event);
      schedulePanelRender(false);
      dispatchCarrierResultSystemReminder(event);
      return;
    case "track:begin":
      beginTrack(event);
      schedulePanelRender(true);
      return;
    case "track:status":
      updateTrackStatus(event.jobId, event.trackId, event.status);
      schedulePanelRender(isActiveTrackStatus(event.status));
      return;
    case "track:runId":
      updateTrackRunId(event.jobId, event.trackId, event.runId);
      schedulePanelRender(true);
      return;
    case "track:text":
      updateRunBlocks(event.jobId, event.trackId, (run) => {
        coalesceTextBlock(run.blocks, event.text);
        run.status = "stream";
      });
      schedulePanelRender(true);
      return;
    case "track:thought":
      updateRunBlocks(event.jobId, event.trackId, (run) => {
        coalesceThoughtBlock(run.blocks, event.text);
        run.status = "stream";
      });
      schedulePanelRender(true);
      return;
    case "track:tool":
      updateRunBlocks(event.jobId, event.trackId, (run) => {
        upsertToolBlock(run.blocks, event.toolCallId, event.title, event.status);
        if (run.status === "wait" || run.status === "conn") run.status = "stream";
      });
      schedulePanelRender(true);
      return;
    case "track:finalized":
      finalizeTrack(event);
      schedulePanelRender(false);
      return;
  }
}

function getGrandFleetStreamStoreState(): {
  runs: Map<string, Pick<PanelRun, "error" | "requestPreview" | "status">>;
} {
  const runs = new Map<string, Pick<PanelRun, "error" | "requestPreview" | "status">>();

  for (const job of getPanelJobs().values()) {
    for (const track of job.tracks) {
      const run = resolveRunForTrack(track);
      if (!run) continue;
      runs.set(run.runId, {
        error: run.error,
        requestPreview: run.requestPreview,
        status: run.status,
      });
    }
  }

  return { runs };
}

function schedulePanelRender(animate: boolean): void {
  if (animate) ensurePanelAnimTimer();
  getJobBarStateBindings().onRenderRequest();
  if (!animate) stopPanelAnimTimerIfIdle();
}

function ensurePanelAnimTimer(): void {
  const state = getState();
  if (state.animTimer) return;
  state.animTimer = setInterval(() => {
    state.frame++;
    getJobBarStateBindings().onRenderRequest();
    stopPanelAnimTimerIfIdle();
  }, ANIM_INTERVAL_MS);
}

function dispatchCarrierResultSystemReminder(event: Extract<CarrierJobStreamEvent, { type: "job:finalized" }>): void {
  if (typeof event.systemReminder !== "string" || event.systemReminder.trim().length === 0) return;
  getJobBarStateBindings().onCarrierResultReminder(event.systemReminder);
}

function registerStreamJob(event: Extract<CarrierJobStreamEvent, { type: "job:registered" }>): void {
  const state = getState();
  const job: MutablePanelJob = {
    activeJobToolCallId: event.activeJobToolCallId,
    jobId: event.jobId,
    kind: event.kind,
    label: event.label,
    ownerCarrierId: event.ownerCarrierId,
    startedAt: event.startedAt,
    status: "active",
    tracks: event.tracks.map(toColumnTrack),
  };
  state.panelJobs.set(job.jobId, job);
  for (const track of job.tracks) {
    const run = ensureRun(canonicalRunKey(track), track.displayCli, "wait");
    run.sessionId = getSessionIdFor(track.displayCli) ?? run.sessionId;
    syncCarrierActivityStatus(track.displayCli);
  }
  state.streaming = true;
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
  const run = ensureRun(canonicalRunKey(track), track.displayCli, "conn");
  run.requestPreview = event.requestPreview ?? run.requestPreview;
  track.status = "conn";
  syncCarrierActivityStatus(track.displayCli);
}

function updateTrackStatus(jobId: string, trackId: string, status: TrackStatus): void {
  const track = getTrack(jobId, trackId);
  if (!track) return;
  track.status = toColStatus(status);
  const run = resolveRunForTrack(track);
  if (run) {
    run.status = track.status;
    syncCarrierActivityStatus(track.displayCli);
  }
}

function updateTrackRunId(jobId: string, trackId: string, runId: string): void {
  const track = getTrack(jobId, trackId);
  if (!track) return;
  const previousKey = canonicalRunKey(track);
  const previousRun = resolveRunForTrack(track);
  track.runId = runId;
  const run = previousRun ?? ensureRun(runId, track.displayCli, "conn");
  run.runId = runId;
  run.cli = track.displayCli;
  if (run.status === "wait") run.status = "conn";
  getPanelRuns().set(runId, run);
  if (previousKey !== runId && getPanelRuns().get(previousKey) === run) {
    getPanelRuns().delete(previousKey);
  }
  syncCarrierActivityStatus(track.displayCli);
}

function updateRunBlocks(jobId: string, trackId: string, update: (run: PanelRun) => void): void {
  const track = getTrack(jobId, trackId);
  if (!track) return;
  const run = resolveRunForTrack(track) ?? ensureRun(canonicalRunKey(track), track.displayCli, "stream");
  update(run);
  refreshRunDerivedFields(run);
  syncCarrierActivityStatus(track.displayCli);
}

function finalizeTrack(event: Extract<CarrierJobStreamEvent, { type: "track:finalized" }>): void {
  const track = getTrack(event.jobId, event.trackId);
  if (!track) return;
  const run = resolveRunForTrack(track) ?? ensureRun(canonicalRunKey(track), track.displayCli, toColStatus(event.status));
  track.status = toColStatus(event.status);
  run.status = track.status;
  if (event.sessionId !== undefined) run.sessionId = event.sessionId;
  if (event.error !== undefined) run.error = event.error;
  prependFallbackBlocks(run, event.fallbackText, event.fallbackThought);
  refreshRunDerivedFields(run);
  syncCarrierActivityStatus(track.displayCli);
  getState().streaming = hasActiveStreamingTrack();
}

function toColumnTrack(input: TrackMeta): MutableColumnTrack {
  return {
    displayCli: input.displayCli,
    displayName: input.displayName,
    kind: input.kind,
    runId: input.runId,
    status: "wait",
    streamKey: input.streamKey,
    subtitle: input.subtitle,
    trackId: input.trackId,
  };
}

function getTrack(jobId: string, trackId: string): MutableColumnTrack | undefined {
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
    blocks: [],
    cli,
    runId,
    status,
    text: "",
    thinking: "",
    toolCalls: [],
    toCollectedData() {
      return {
        blocks: this.blocks.map((block) => ({ ...block })),
        lastStatus: this.status,
        text: this.text,
        thinking: this.thinking,
        toolCalls: this.toolCalls.map((toolCall) => ({ ...toolCall })),
      };
    },
  };
}

function resolveRunForTrack(track: MutableColumnTrack): PanelRun | undefined {
  if (track.runId) return getPanelRuns().get(track.runId);
  return (
    getPanelRuns().get(track.streamKey) ??
    getPanelRuns().get(track.trackId)
  );
}

function canonicalRunKey(track: MutableColumnTrack): string {
  return track.runId ?? track.streamKey ?? track.trackId;
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
    .map((block) => ({ status: block.status, title: block.title }));
}

function prependFallbackBlocks(run: PanelRun, fallbackText?: string, fallbackThought?: string): void {
  if (fallbackText && !run.text.trim()) {
    run.blocks.unshift({ text: fallbackText, type: "text" });
  }
  if (fallbackThought && !run.thinking.trim()) {
    run.blocks.unshift({ text: fallbackThought, type: "thought" });
  }
}

function syncCarrierActivityStatus(carrierId: string): void {
  const colIndex = findColIndex(carrierId);
  if (colIndex < 0) return;
  const col = getState().cols[colIndex];
  if (!col) return;
  const carrierTracks = Array.from(getPanelJobs().values())
    .flatMap((job) => job.tracks)
    .filter((track) => track.displayCli === carrierId);
  const status = resolveAggregateCarrierStatus(carrierTracks);
  const sessionId = getSessionIdFor(carrierId) ?? col.sessionId;
  Object.assign(col, {
    blocks: [],
    error: status === "err" ? resolveAggregateCarrierError(carrierTracks) : undefined,
    sessionId,
    status,
    text: "",
    thinking: "",
    toolCalls: [],
  });
}

function resolveAggregateCarrierStatus(tracks: MutableColumnTrack[]): ColStatus {
  if (tracks.some((track) => track.status === "stream")) return "stream";
  if (tracks.some((track) => track.status === "conn")) return "conn";
  if (tracks.some((track) => track.status === "wait")) return "wait";
  if (tracks.some((track) => track.status === "err")) return "err";
  if (tracks.some((track) => track.status === "done")) return "done";
  return "wait";
}

function resolveAggregateCarrierError(tracks: MutableColumnTrack[]): string | undefined {
  for (const track of tracks) {
    const error = resolveRunForTrack(track)?.error;
    if (error) return error;
  }
  return undefined;
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
  return Array.from(getPanelJobs().values()).some((job) =>
    job.status === "active" && job.tracks.some((track) => track.status === "conn" || track.status === "stream"),
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

function stopPanelAnimTimerIfIdle(): void {
  const state = getState();
  const stillStreaming =
    state.streaming ||
    state.cols.some((col) => col.status === "conn" || col.status === "stream") ||
    getActiveJobs().length > 0;
  if (stillStreaming || getActiveBackgroundJobCount() > 0) return;
  if (!state.animTimer) return;
  clearInterval(state.animTimer);
  state.animTimer = null;
}

function coalesceTextBlock(blocks: ColBlock[], text: string): void {
  const last = blocks[blocks.length - 1];
  if (last?.type === "text") {
    blocks[blocks.length - 1] = { ...last, text: last.text + text };
    return;
  }
  blocks.push({ text, type: "text" });
}

function coalesceThoughtBlock(blocks: ColBlock[], text: string): void {
  const last = blocks[blocks.length - 1];
  if (last?.type === "thought") {
    blocks[blocks.length - 1] = { ...last, text: last.text + text };
    return;
  }
  blocks.push({ text, type: "thought" });
}

function upsertToolBlock(blocks: ColBlock[], toolCallId: string | undefined, title: string, status: string): void {
  const existingIndex = blocks.findIndex((block) =>
    block.type === "tool" && (toolCallId ? block.toolCallId === toolCallId : block.title === title),
  );

  if (existingIndex >= 0) {
    const existing = blocks[existingIndex];
    if (existing?.type !== "tool") return;
    blocks[existingIndex] = {
      ...existing,
      status: status || existing.status,
      title: title || existing.title,
    };
    return;
  }

  blocks.push({ status, title, toolCallId, type: "tool" });
}

function toReadonlyPanelJob(job: MutablePanelJob): PanelJob {
  return {
    activeJobToolCallId: job.activeJobToolCallId,
    finishedAt: job.finishedAt,
    jobId: job.jobId,
    kind: job.kind,
    label: job.label,
    ownerCarrierId: job.ownerCarrierId,
    startedAt: job.startedAt,
    status: job.status,
    tracks: job.tracks.map((track) => ({ ...track })),
  };
}

function getSessionIdFor(carrierId: string): string | undefined {
  return getAgentSessionIdFor(carrierId);
}

function getJobBarStateBindings(): JobBarStateBindings {
  return bindings;
}

function noop(): void {}
}
