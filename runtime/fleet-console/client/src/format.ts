export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
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
