import type { JobView, ObservedEvent, SnapshotJob, TrackToolCall, TrackView } from "./types.js";

interface TrackMetaPayload {
  readonly trackId?: string;
  readonly displayName?: string;
  readonly displayCli?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly subtitle?: string;
  readonly kind?: string;
  readonly startedAt?: number;
}

const JOB_RECENT_EVENT_LIMIT = 120;
const ACTIVE_JOB_STATUS = "active";
const TERMINAL_JOB_STATUSES = new Set(["done", "error", "aborted"]);

/** 잡 스냅샷(이벤트 배열)을 단일 JobView로 리듀스한다. */
export function reduceSnapshotJob(tenantId: string, snapshot: SnapshotJob): JobView {
  let job = createEmptyJob(tenantId, snapshot.jobId, snapshot.updatedAt);
  for (const event of snapshot.events) {
    job = applyEvent(job, event);
  }
  if (TERMINAL_JOB_STATUSES.has(snapshot.status) && !TERMINAL_JOB_STATUSES.has(job.status)) {
    // 이벤트 보존 한도 때문에 finalize 이벤트가 잘려나간 잡은 스냅샷 상태를 신뢰한다.
    job = { ...job, status: snapshot.status };
  }
  return job;
}

/** 단일 관측 이벤트를 JobView에 불변 적용한다. 이미 반영된 이벤트(id 역행)는 무시한다. */
export function applyEvent(job: JobView, observed: ObservedEvent): JobView {
  if (observed.id <= job.lastEventId) return job;
  const payload = observed.event;
  const base: JobView = {
    ...job,
    updatedAt: observed.at,
    lastEventId: observed.id,
    recentEvents: appendRecentEvent(job.recentEvents, observed),
  };
  switch (observed.type) {
    case "job:registered":
      return applyJobRegistered(base, payload);
    case "job:finalized":
      return {
        ...base,
        status: readString(payload.status) ?? "done",
        finishedAt: readNumber(payload.finishedAt) ?? observed.at,
        summary: readString(payload.summary),
        error: readString(payload.error),
      };
    case "track:begin":
      return mutateTrack(base, payload, (track) => ({
        ...track,
        startedAt: readNumber(payload.startedAt) ?? observed.at,
        requestPreview: readString(payload.requestPreview),
      }));
    case "track:status":
      return mutateTrack(base, payload, (track) => ({
        ...track,
        status: readString(payload.status) ?? track.status,
      }));
    case "track:text":
      return mutateTrack(base, payload, (track) => ({
        ...track,
        status: "stream",
        text: track.text + (readString(payload.text) ?? ""),
        sentTextLength: track.sentTextLength + (readNumber(payload.textLength) ?? readString(payload.text)?.length ?? 0),
      }));
    case "track:thought":
      return mutateTrack(base, payload, (track) => ({
        ...track,
        thought: track.thought + (readString(payload.text) ?? ""),
        sentThoughtLength: track.sentThoughtLength + (readNumber(payload.textLength) ?? readString(payload.text)?.length ?? 0),
      }));
    case "track:tool":
      return mutateTrack(base, payload, (track) => ({
        ...track,
        status: "stream",
        tools: upsertTool(track.tools, payload),
      }));
    case "track:finalized":
      return mutateTrack(base, payload, (track) => {
        const body = adoptFinalBody(track.text, track.sentTextLength, readString(payload.fallbackText), readNumber(payload.fallbackTextLength));
        const thought = adoptFinalBody(track.thought, track.sentThoughtLength, readString(payload.fallbackThought), readNumber(payload.fallbackThoughtLength));
        return {
          ...track,
          status: readString(payload.status) ?? "done",
          finishedAt: readNumber(payload.finishedAt) ?? observed.at,
          error: readString(payload.error),
          text: body.text,
          sentTextLength: body.sentLength,
          thought: thought.text,
          sentThoughtLength: thought.sentLength,
        };
      });
    default:
      return base;
  }
}

export function createEmptyJob(tenantId: string, jobId: string, at: number): JobView {
  return {
    jobId,
    tenantId,
    status: ACTIVE_JOB_STATUS,
    updatedAt: at,
    trackOrder: [],
    tracks: {},
    lastEventId: 0,
    recentEvents: [],
  };
}

export function isTerminalJobStatus(status: string): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

function applyJobRegistered(job: JobView, payload: Record<string, unknown>): JobView {
  const tracksMeta = Array.isArray(payload.tracks) ? payload.tracks as TrackMetaPayload[] : [];
  let trackOrder = job.trackOrder;
  let tracks = job.tracks;
  for (const meta of tracksMeta) {
    if (!meta.trackId) continue;
    const existing = tracks[meta.trackId];
    const merged: TrackView = {
      ...(existing ?? createEmptyTrack(meta.trackId)),
      displayName: meta.displayName ?? existing?.displayName ?? meta.trackId,
      displayCli: meta.displayCli ?? existing?.displayCli,
      model: meta.model ?? existing?.model,
      effort: meta.effort ?? existing?.effort,
      subtitle: meta.subtitle ?? existing?.subtitle,
      kind: meta.kind ?? existing?.kind,
      startedAt: meta.startedAt ?? existing?.startedAt,
    };
    if (!existing) trackOrder = [...trackOrder, meta.trackId];
    tracks = { ...tracks, [meta.trackId]: merged };
  }
  return {
    ...job,
    label: readString(payload.label) ?? job.label,
    ownerCarrierId: readString(payload.ownerCarrierId) ?? job.ownerCarrierId,
    kind: readString(payload.kind) ?? job.kind,
    startedAt: readNumber(payload.startedAt) ?? job.startedAt,
    trackOrder,
    tracks,
  };
}

function mutateTrack(job: JobView, payload: Record<string, unknown>, mutate: (track: TrackView) => TrackView): JobView {
  const trackId = readString(payload.trackId);
  if (!trackId) return job;
  const existing = job.tracks[trackId];
  const next = mutate(existing ?? createEmptyTrack(trackId));
  return {
    ...job,
    trackOrder: existing ? job.trackOrder : [...job.trackOrder, trackId],
    tracks: { ...job.tracks, [trackId]: next },
  };
}

function createEmptyTrack(trackId: string): TrackView {
  return {
    trackId,
    displayName: trackId,
    status: "queued",
    text: "",
    thought: "",
    sentTextLength: 0,
    sentThoughtLength: 0,
    tools: [],
  };
}

/**
 * 종료 시 본문을 확정한다. 잡 이벤트 보존 한도로 델타 prefix가 잘린 스냅샷에서는
 * 누적 꼬리 조각보다 head-complete한 fallback 본문이 더 완전하므로 긴 쪽을 채택하고,
 * 게이트웨이가 보고한 원본 전체 길이를 보존해 클램프가 운영자에게 보이게 한다.
 */
function adoptFinalBody(
  accumulated: string,
  accumulatedSentLength: number,
  fallback: string | undefined,
  fallbackOriginalLength: number | undefined,
): { readonly text: string; readonly sentLength: number } {
  const fallbackLength = fallbackOriginalLength ?? fallback?.length ?? 0;
  if (fallback !== undefined && fallbackLength > accumulated.length) {
    return { text: fallback, sentLength: Math.max(fallbackLength, accumulatedSentLength) };
  }
  return { text: accumulated, sentLength: Math.max(accumulatedSentLength, fallbackLength) };
}

function upsertTool(tools: readonly TrackToolCall[], payload: Record<string, unknown>): readonly TrackToolCall[] {
  const title = readString(payload.title) ?? "tool";
  const status = readString(payload.status) ?? "";
  const callId = readString(payload.toolCallId);
  const key = callId ?? `${title}#${tools.length}`;
  if (callId) {
    const index = tools.findIndex((tool) => tool.key === callId);
    if (index >= 0) {
      const next = [...tools];
      next[index] = { key: callId, title, status };
      return next;
    }
  }
  return [...tools, { key, title, status }];
}

function appendRecentEvent(events: readonly ObservedEvent[], event: ObservedEvent): readonly ObservedEvent[] {
  const next = [...events, event];
  return next.length > JOB_RECENT_EVENT_LIMIT ? next.slice(-JOB_RECENT_EVENT_LIMIT) : next;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
