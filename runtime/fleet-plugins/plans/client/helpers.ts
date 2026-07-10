export type WaveProgressState = "complete" | "in-progress" | "not-started";

export function formatRelativeTime(updatedAt: string, now = Date.now()): string {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "Unknown";

  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (elapsedSeconds < 60) return "just now";

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

export function getProgressPercent(tasksDone: number, tasksTotal: number): number | null {
  if (!Number.isFinite(tasksTotal) || tasksTotal <= 0) return null;
  if (!Number.isFinite(tasksDone)) return 0;
  return Math.round(Math.min(1, Math.max(0, tasksDone / tasksTotal)) * 100);
}

export function getWaveProgressState(tasksDone: number, tasksTotal: number): WaveProgressState {
  if (tasksTotal > 0 && tasksDone >= tasksTotal) return "complete";
  if (tasksDone > 0) return "in-progress";
  return "not-started";
}
