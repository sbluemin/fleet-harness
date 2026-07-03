import type { JobView } from "./types.js";

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
    return sum + Math.round((track.text.length + track.thought.length) / 4);
  }, 0);
}
