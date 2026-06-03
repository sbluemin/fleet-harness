import type {
  CarrierJobKind,
  CarrierJobStatus,
  TrackKind,
} from "@dotobokuri/fleet-carriers";

export type ColStatus = "wait" | "conn" | "stream" | "done" | "err";

export type ColBlock =
  | { readonly text: string; readonly type: "thought" }
  | { readonly text: string; readonly type: "text" }
  | { readonly detailChars?: number; readonly status: string; readonly title: string; readonly toolCallId?: string; readonly type: "tool" };

export interface PanelRunViewModelSource {
  readonly displayedTokenCount?: number;
  readonly blocks?: readonly ColBlock[];
  readonly runId?: string;
  readonly status?: ColStatus;
}

export interface ColumnTrack {
  readonly displayCli: string;
  readonly displayName: string;
  readonly finishedAt?: number;
  readonly kind: TrackKind;
  readonly runId?: string;
  readonly startedAt?: number;
  readonly status: ColStatus;
  readonly streamKey: string;
  readonly subtitle?: string;
  readonly trackId: string;
}

export interface PanelJob {
  readonly activeJobToolCallId?: string;
  readonly finishedAt?: number;
  readonly jobId: string;
  readonly kind: CarrierJobKind;
  readonly label: string;
  readonly ownerCarrierId: string;
  readonly startedAt: number;
  readonly status: "active" | CarrierJobStatus;
  readonly tracks: readonly ColumnTrack[];
}

export interface PanelTrackViewModel {
  readonly blocks: ColBlock[];
  readonly displayCli: string;
  readonly displayName: string;
  readonly finishedAt?: number;
  readonly isComplete: boolean;
  readonly kind: ColumnTrack["kind"];
  readonly runId?: string;
  readonly startedAt?: number;
  readonly status: ColStatus;
  readonly streamKey: string;
  readonly subtitle?: string;
  readonly displayedTokenCount: number;
  readonly estimatedTokenCount: number;
  readonly trackId: string;
}

export interface PanelJobViewModel {
  readonly activeJobToolCallId?: string;
  readonly finishedAt?: number;
  readonly jobId: string;
  readonly kind: PanelJob["kind"];
  readonly label: string;
  readonly ownerCarrierId: string;
  readonly startedAt: number;
  readonly status: PanelJob["status"];
  readonly tracks: PanelTrackViewModel[];
}

export interface CarrierJobGroupViewModel {
  readonly carrierId: string;
  readonly displayName: string;
  readonly jobs: PanelJobViewModel[];
  readonly startedAt: number;
  readonly status: PanelJob["status"];
}

export interface BuildPanelViewModelOptions {
  readonly maxTrackBlocks?: number;
}

const DEFAULT_MAX_TRACK_BLOCKS = 5;

export function buildPanelViewModel(
  jobs: readonly PanelJob[],
  runs: ReadonlyMap<string, PanelRunViewModelSource>,
  options: BuildPanelViewModelOptions = {},
): PanelJobViewModel[] {
  const maxTrackBlocks = options.maxTrackBlocks ?? DEFAULT_MAX_TRACK_BLOCKS;
  return jobs.map((job) => ({
    activeJobToolCallId: job.activeJobToolCallId,
    finishedAt: job.finishedAt,
    jobId: job.jobId,
    kind: job.kind,
    label: job.label,
    ownerCarrierId: job.ownerCarrierId,
    startedAt: job.startedAt,
    status: job.status,
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
    blocks: blockTail,
    displayCli: track.displayCli,
    displayName: track.displayName,
    displayedTokenCount: run?.displayedTokenCount ?? stats.estimatedTokenCount,
    estimatedTokenCount: stats.estimatedTokenCount,
    finishedAt: track.finishedAt,
    isComplete: status === "done" || status === "err",
    kind: track.kind,
    runId: run?.runId ?? track.runId,
    startedAt: track.startedAt,
    status,
    streamKey: track.streamKey,
    subtitle: track.subtitle,
    trackId: track.trackId,
  };
}

export function buildCarrierJobGroups(
  jobs: readonly PanelJobViewModel[],
  carrierOrder: readonly string[],
  resolveDisplayName: (carrierId: string) => string,
): CarrierJobGroupViewModel[] {
  const groups = new Map<string, {
    carrierId: string;
    displayName: string;
    jobs: PanelJobViewModel[];
    startedAt: number;
    status: PanelJob["status"];
  }>();
  for (const job of jobs) {
    const group = groups.get(job.ownerCarrierId) ?? {
      carrierId: job.ownerCarrierId,
      displayName: resolveDisplayName(job.ownerCarrierId),
      jobs: [],
      startedAt: job.startedAt,
      status: job.status,
    };
    group.jobs.push(job);
    group.startedAt = Math.min(group.startedAt, job.startedAt);
    group.status = group.status === "active" || job.status === "active" ? "active" : job.status;
    groups.set(job.ownerCarrierId, group);
  }

  for (const group of groups.values()) {
    group.jobs.sort((a, b) => a.startedAt - b.startedAt);
  }

  const orderRank = new Map(carrierOrder.map((carrierId, index) => [carrierId, index] as const));
  return Array.from(groups.values()).sort((a, b) => {
    const rankA = orderRank.get(a.carrierId);
    const rankB = orderRank.get(b.carrierId);
    if (rankA !== undefined && rankB !== undefined && rankA !== rankB) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return a.startedAt - b.startedAt;
  });
}

function resolveRun(
  track: ColumnTrack,
  runs: ReadonlyMap<string, PanelRunViewModelSource>,
): PanelRunViewModelSource | undefined {
  if (track.runId) {
    const byRunId = runs.get(track.runId);
    if (byRunId) return byRunId;
  }
  return runs.get(track.streamKey) ?? runs.get(track.trackId);
}

function collectBlockStats(blocks: readonly ColBlock[]): { readonly estimatedTokenCount: number } {
  let charCount = 0;
  for (const block of blocks) {
    if (block.type === "tool") {
      charCount += block.title.length;
      if (block.status) charCount += block.status.length;
      charCount += block.detailChars ?? 0;
      continue;
    }
    charCount += block.text.length;
  }
  const estimatedTokenCount = charCount === 0 ? 0 : Math.max(1, Math.round(charCount / 4));
  return { estimatedTokenCount };
}
