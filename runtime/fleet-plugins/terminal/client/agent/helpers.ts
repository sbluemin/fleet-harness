import type { JobView, TrackView } from "./types.js";

export interface TrackPhase {
  readonly label: string;
  readonly tone: "live" | "done" | "error";
}

const CAPTAIN_IDS = new Set(["nimitz", "kirov", "genesis", "ohio", "sentinel", "vanguard"]);

export function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
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

export function deriveTrackPhase(track: TrackView, jobStatus: string): TrackPhase {
  if (isTrackError(track.status)) return { label: "Error", tone: "error" };
  if (track.status === "aborted") return { label: "Aborted", tone: "error" };
  if (track.status === "done") return { label: "Done", tone: "done" };
  if (jobStatus === "error") return { label: "Error", tone: "error" };
  if (jobStatus === "aborted") return { label: "Aborted", tone: "error" };
  if (jobStatus === "done") return { label: "Done", tone: "done" };

  const lastTool = track.tools.at(-1);
  if (lastTool && resolveToolTone(lastTool.status) === "live") {
    return { label: `Using ${lastTool.name ?? "tool"}`, tone: "live" };
  }
  if (track.text.length > 0) return { label: "Writing", tone: "live" };
  if (track.thought.length > 0) return { label: "Reasoning", tone: "live" };
  return { label: "Working", tone: "live" };
}

// 도구 status 종결 판정의 단일 지점 — ACP 계열 런타임은 completed/failed를, 내부 경로는 done/error를 쓴다.
// phase 도출과 Details 칩이 같은 판정을 공유해야 "Using" 잔류/칩 톤 분열이 생기지 않는다.
export function resolveToolTone(status: string | undefined): "done" | "error" | "live" {
  if (status === "done" || status === "completed") return "done";
  if (status === "error" || status === "failed") return "error";
  return "live";
}

export function describeToolTarget(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "file", "command", "query", "url", "pattern"] as const) {
    const value = record[key];
    if (typeof value === "string") return value.slice(0, 60);
  }
  return null;
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
