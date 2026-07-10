import { isTerminalJobStatus } from "./reduce.js";
import type { JobView, TrackView } from "./types.js";

export interface RetainedJob {
  readonly jobId: string;
  readonly expiresAt: number;
}

export interface DockTail {
  readonly text: string;
  readonly thinking: boolean;
}

const CAPTAIN_IDS = new Set(["nimitz", "kirov", "genesis", "ohio", "sentinel", "vanguard", "tempest", "chronicle"]);
const BACKEND_CLIS = new Set(["claude", "codex", "opencode-go", "cursor"]);

export function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function formatTokenEstimate(tokenCount: number): string {
  if (tokenCount <= 0) return "";
  if (tokenCount < 1000) return `~${tokenCount} tokens`;
  const scaled = tokenCount / 1000;
  const rounded = scaled.toFixed(1).replace(/\.0$/, "");
  return `~${rounded}k tokens`;
}

export function estimateJobTokens(job: JobView): number {
  return job.trackOrder.reduce((sum, trackId) => {
    const track = job.tracks[trackId];
    if (!track) return sum;
    // 보존된 text/thought는 백엔드 retention clamp로 잘린 tail일 수 있으므로,
    // 리듀서가 유지하는 실제 방출 길이(sentTextLength/sentThoughtLength)로 추정한다.
    return sum + Math.round((track.sentTextLength + track.sentThoughtLength) / 4);
  }, 0);
}

export function resolveJobSignature(job: JobView): "claude" | "codex" | "opencode-go" | "cursor" | "taskforce" | undefined {
  if (job.kind === "taskforce") return "taskforce";
  const cli = job.signatureCli;
  return cli && BACKEND_CLIS.has(cli) ? cli as "claude" | "codex" | "opencode-go" | "cursor" : undefined;
}

export function resolveCarrierCaptain(carrierId: string | undefined): string | undefined {
  if (!carrierId) return undefined;
  return CAPTAIN_IDS.has(carrierId) ? carrierId : undefined;
}

export function isTrackLive(status: string): boolean {
  return status === "conn" || status === "stream" || status === "live" || status === "running" || status === "active";
}

export function isTrackError(status: string): boolean {
  // 트랙 SSoT는 "err"(core-agent TrackStatus·toTrackFinalStatus); 잡 레벨 종결 상태의 "error"도 수용한다.
  return status === "err" || status === "error";
}

export function isDockTrackLive(jobStatus: string, trackStatus: string): boolean {
  // 종결 잡(잔존 표시 포함)의 트랙은 track:finalized가 누락돼 stale 라이브 상태로 남아도
  // 라이브로 취급하지 않는다 — 완료/에러 잡이 잔존 중 라이브 캐럿·aurora 신호를 얻는 것 방지.
  return !isTerminalJobStatus(jobStatus) && isTrackLive(trackStatus);
}

export function resolveDockRowStatusLabel(trackStatus: string, jobStatus: string): string {
  // 행 라벨은 트랙별 결과 우선 — 혼합 결과 taskforce가 잔존할 때 성공 트랙이 잡 레벨 "error"로
  // 오표기되지 않게 한다. 종결 잡 안에 미종결로 남은 트랙만 잡 상태로 폴백한다.
  if (isTrackError(trackStatus)) return "error";
  if (trackStatus === "done" || trackStatus === "aborted") return trackStatus;
  return isTerminalJobStatus(jobStatus) ? jobStatus : trackStatus;
}

export function mergeJobIds(jobIds: readonly string[], additionalJobIds: readonly string[]): readonly string[] {
  const known = new Set(jobIds);
  const additions = additionalJobIds.filter((jobId) => {
    if (known.has(jobId)) return false;
    known.add(jobId);
    return true;
  });
  return additions.length === 0 ? jobIds : [...jobIds, ...additions];
}

export function retainCompletedJobs(retainedJobs: readonly RetainedJob[], completedJobIds: readonly string[], expiresAt: number): readonly RetainedJob[] {
  const existing = new Map(retainedJobs.map((job) => [job.jobId, job]));
  let changed = false;
  for (const jobId of completedJobIds) {
    const current = existing.get(jobId);
    if (current?.expiresAt === expiresAt) continue;
    existing.set(jobId, { jobId, expiresAt });
    changed = true;
  }
  return changed ? [...existing.values()] : retainedJobs;
}

export function pruneRetainedJobs(retainedJobs: readonly RetainedJob[], availableJobs: readonly JobView[], now: number): readonly RetainedJob[] {
  const availableIds = new Set(availableJobs.map((job) => job.jobId));
  const next = retainedJobs.filter((job) => job.expiresAt > now && availableIds.has(job.jobId));
  return next.length === retainedJobs.length ? retainedJobs : next;
}

export function selectJobsByIds(jobs: readonly JobView[], jobIds: readonly string[]): readonly JobView[] {
  const byId = new Map(jobs.map((job) => [job.jobId, job]));
  return jobIds.flatMap((jobId) => {
    const job = byId.get(jobId);
    return job ? [job] : [];
  });
}

export function getDockTailText(dockJobs: readonly JobView[]): DockTail {
  // 모든 트랙을 트랙별 lastEventId(전역 단조 증가) 최신순으로 정렬해 접힘 테일을 고른다.
  // 라이브 트랙(잡 비종결 게이트 포함)이 하나라도 있으면 라이브 풀만 대표로 삼고,
  // 풀은 최신순으로 순회하며 트랙별로 output 라인 → thinking 상태 순으로 판정한다 —
  // 가장 최근 활동이 thinking-only 트랙이면 더 오래된 트랙의 output이 아니라
  // thinking 상태를 표시해 실제 이벤트 순서를 따른다(추론 원문은 노출하지 않음).
  const entries = dockJobs
    .flatMap((job) => job.trackOrder.map((trackId) => ({ job, track: job.tracks[trackId] })))
    .filter((entry): entry is { readonly job: JobView; readonly track: TrackView } => Boolean(entry.track))
    .sort((a, b) => b.track.lastEventId - a.track.lastEventId);
  const liveEntries = entries.filter(({ job, track }) => isDockTrackLive(job.status, track.status));
  const pool = liveEntries.length > 0 ? liveEntries : entries;
  for (const { job, track } of pool) {
    if (track.latestLine) return { text: track.latestLine, thinking: false };
    if (isDockTrackLive(job.status, track.status) && track.thought) return { text: "", thinking: true };
  }
  return { text: "", thinking: false };
}

export function mergeDockJobs(activeJobs: readonly JobView[], allJobs: readonly JobView[], retainedJobs: readonly RetainedJob[]): readonly JobView[] {
  const activeIds = new Set(activeJobs.map((job) => job.jobId));
  const retained = selectJobsByIds(allJobs, retainedJobs.map((job) => job.jobId)).filter((job) => !activeIds.has(job.jobId));
  return retained.length === 0 ? activeJobs : [...activeJobs, ...retained];
}
