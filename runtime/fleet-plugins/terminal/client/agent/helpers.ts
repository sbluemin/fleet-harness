import type { JobView } from "./types.js";

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
  for (const trackId of job.trackOrder) {
    const track = job.tracks[trackId];
    if (!track) continue;
    const cli = track.displayCli;
    if (cli && BACKEND_CLIS.has(cli)) return cli as "claude" | "codex" | "opencode-go" | "cursor";
  }
  return undefined;
}

export function resolveCarrierCaptain(carrierId: string | undefined): string | undefined {
  if (!carrierId) return undefined;
  return CAPTAIN_IDS.has(carrierId) ? carrierId : undefined;
}
