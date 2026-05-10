import type { ColBlock, ColStatus } from "./types.js";
import type { CarrierJobKind, CarrierJobStatus, TrackKind } from "@sbluemin/fleet-core";

export interface PanelRunViewModelSource {
  runId?: string;
  status?: ColStatus;
  blocks?: readonly ColBlock[];
}

export interface ColumnTrack {
  trackId: string;
  streamKey: string;
  displayCli: string;
  runId?: string;
  displayName: string;
  subtitle?: string;
  kind: TrackKind;
  status: ColStatus;
}

export interface PanelJob {
  jobId: string;
  kind: CarrierJobKind;
  ownerCarrierId: string;
  label: string;
  startedAt: number;
  finishedAt?: number;
  status: "active" | CarrierJobStatus;
  tracks: ColumnTrack[];
  activeJobToolCallId?: string;
}

export interface PanelTrackViewModel {
  trackId: string;
  streamKey: string;
  displayCli: string;
  runId?: string;
  displayName: string;
  subtitle?: string;
  kind: ColumnTrack["kind"];
  status: ColStatus;
  blocks: ColBlock[];
  toolCallCount: number;
  textLineCount: number;
  isComplete: boolean;
}

export interface PanelJobViewModel {
  jobId: string;
  kind: PanelJob["kind"];
  ownerCarrierId: string;
  label: string;
  startedAt: number;
  finishedAt?: number;
  status: PanelJob["status"];
  tracks: PanelTrackViewModel[];
  activeJobToolCallId?: string;
}

export interface BuildPanelViewModelOptions {
  maxTrackBlocks?: number;
}

const DEFAULT_MAX_TRACK_BLOCKS = 5;

export function buildPanelViewModel(
  jobs: readonly PanelJob[],
  runs: ReadonlyMap<string, PanelRunViewModelSource>,
  options: BuildPanelViewModelOptions = {},
): PanelJobViewModel[] {
  const maxTrackBlocks = options.maxTrackBlocks ?? DEFAULT_MAX_TRACK_BLOCKS;
  return jobs.map((job) => ({
    jobId: job.jobId,
    kind: job.kind,
    ownerCarrierId: job.ownerCarrierId,
    label: job.label,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    status: job.status,
    activeJobToolCallId: job.activeJobToolCallId,
    tracks: job.tracks.map((track) => buildPanelTrackViewModel(track, runs, maxTrackBlocks)),
  }));
}

export function buildPanelTrackViewModel(
  track: ColumnTrack,
  runs: ReadonlyMap<string, PanelRunViewModelSource>,
  maxTrackBlocks = DEFAULT_MAX_TRACK_BLOCKS,
): PanelTrackViewModel {
  const run = resolveRun(track, runs);
  const blocks = run?.blocks ?? [];
  const blockTail = maxTrackBlocks > 0 ? blocks.slice(-maxTrackBlocks).map((block) => ({ ...block })) : [];
  const status = run?.status ?? track.status;
  const stats = collectBlockStats(blocks);
  return {
    trackId: track.trackId,
    streamKey: track.streamKey,
    displayCli: track.displayCli,
    runId: run?.runId ?? track.runId,
    displayName: track.displayName,
    subtitle: track.subtitle,
    kind: track.kind,
    status,
    blocks: blockTail,
    toolCallCount: stats.toolCallCount,
    textLineCount: stats.textLineCount,
    isComplete: status === "done",
  };
}

function resolveRun(
  track: ColumnTrack,
  runs: ReadonlyMap<string, PanelRunViewModelSource>,
): PanelRunViewModelSource | undefined {
  if (track.runId) {
    const byRunId = runs.get(track.runId);
    if (byRunId) return byRunId;
  }
  return runs.get(track.streamKey);
}

function collectBlockStats(blocks: readonly ColBlock[]): { toolCallCount: number; textLineCount: number } {
  let toolCallCount = 0;
  let textLineCount = 0;
  for (const block of blocks) {
    if (block.type === "tool") {
      toolCallCount++;
      continue;
    }
    textLineCount += block.text.split("\n").filter((line) => line.trim()).length;
  }
  return { toolCallCount, textLineCount };
}
