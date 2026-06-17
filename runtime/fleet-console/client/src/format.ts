import type { JobView, SessionInfo, TrackView } from "./types.js";

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

// 세션 표시 명칭: 사용자가 지정한 라벨이 있으면 우선하고, 없으면 Theater별 순번 기반 기본 명칭을 쓴다.
export function sessionDisplayLabel(session: SessionInfo): string {
  return session.label?.trim() || `#${session.sequence} Operation`;
}

export function formatElapsed(from: number, to: number): string {
  const totalSeconds = Math.max(0, Math.round((to - from) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function shortJobId(jobId: string): string {
  return jobId.length <= 14 ? jobId : `${jobId.slice(0, 6)}…${jobId.slice(-6)}`;
}

export function compactPath(cwd: string): string {
  const segments = cwd.split("/").filter(Boolean);
  if (segments.length <= 3) return cwd;
  return `…/${segments.slice(-2).join("/")}`;
}

export function formatCarrierName(carrierId: string): string {
  if (!carrierId) return carrierId;
  return carrierId.charAt(0).toUpperCase() + carrierId.slice(1);
}

export function describeJobStatus(status: string): string {
  switch (status) {
    case "active":
      return "running";
    case "done":
      return "done";
    case "error":
      return "error";
    case "aborted":
      return "aborted";
    default:
      return status;
  }
}

export function describeTrackStatus(status: string): string {
  switch (status) {
    case "queued":
      return "queued";
    case "conn":
      return "connecting";
    case "stream":
      return "streaming";
    case "done":
      return "done";
    case "err":
      return "error";
    case "aborted":
      return "aborted";
    default:
      return status;
  }
}

// Operation 인디케이터(tenant-beacon) 클래스. 우선순위(Job 우선):
//   dormant(PTY 종료) → brass
//   활성 캐리어 Job 있음 → aurora(is-live)            [US-3 및 턴 진행 중 Job 동시 케이스 포함]
//   턴 진행 중(turnState=running) → 노랑(is-turn-running) [US-1]
//   턴 종료(turnState=ended) → 그린(is-turn-ended)        [US-2]
//   그 외(신규/턴 이력 없음) → 회색(기본)                 [US-0]
export function sessionBeaconClassName(session: SessionInfo, activeJobCount: number): string {
  if (session.status === "dormant") return "tenant-beacon is-dormant";
  if (activeJobCount > 0) return "tenant-beacon is-live";
  if (session.turnState === "running") return "tenant-beacon is-turn-running";
  if (session.turnState === "ended") return "tenant-beacon is-turn-ended";
  return "tenant-beacon";
}

export function statusTone(status: string): "live" | "ok" | "bad" | "idle" {
  switch (status) {
    case "stream":
    case "active":
    case "conn":
      return "live";
    case "done":
      return "ok";
    case "err":
    case "error":
      return "bad";
    default:
      return "idle";
  }
}

/**
 * 진행 중인 잡의 "지금 스트리밍 중인 최신 한 줄"을 도출한다. fleet-cli job bar의 inline 표시와
 * 동일하게 가장 최근 비어있지 않은 출력 라인을 반환하며, 잡이 종료(active가 아님)되면 null을 돌려
 * 호출 측이 해당 영역을 제거하도록 한다. 활성(stream/conn) 트랙을 우선 보고, 없으면 전체 트랙에서 찾는다.
 */
export function latestStreamLine(job: JobView): string | null {
  if (job.status !== "active") return null;
  const tracks = job.trackOrder
    .map((trackId) => job.tracks[trackId])
    .filter((track): track is TrackView => Boolean(track));
  const streaming = tracks.filter((track) => track.status === "stream" || track.status === "conn");
  const pool = streaming.length > 0 ? streaming : tracks;
  for (let index = pool.length - 1; index >= 0; index--) {
    const track = pool[index];
    const line = track ? trackTailLine(track) : null;
    if (line) return line;
  }
  return null;
}

function trackTailLine(track: TrackView): string | null {
  return (
    lastNonEmptyLine(track.text)
    ?? lastNonEmptyLine(track.thought)
    ?? track.tools[track.tools.length - 1]?.title
    ?? null
  );
}

function lastNonEmptyLine(text: string): string | null {
  if (!text) return null;
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const trimmed = lines[index]?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
