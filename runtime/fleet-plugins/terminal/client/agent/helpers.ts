import type { JobView } from "./types.js";

export interface RetainedJob {
  readonly jobId: string;
  readonly expiresAt: number;
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

export function mergeDockJobs(activeJobs: readonly JobView[], allJobs: readonly JobView[], retainedJobs: readonly RetainedJob[]): readonly JobView[] {
  const activeIds = new Set(activeJobs.map((job) => job.jobId));
  const retained = selectJobsByIds(allJobs, retainedJobs.map((job) => job.jobId)).filter((job) => !activeIds.has(job.jobId));
  return retained.length === 0 ? activeJobs : [...activeJobs, ...retained];
}
