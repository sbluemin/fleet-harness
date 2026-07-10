export type WaveProgressState = "complete" | "in-progress" | "not-started";

// dispatch 준비도는 자유 텍스트 start condition을 해석하지 않는다 — "wave 선언 순서 + 체크박스 완료"만으로 산출하는 결정론 근사다.
export type LaneDispatchState = "complete" | "ready" | "blocked" | "none";

export interface TaskCountLike {
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

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

export function isWaveSettled(wave: TaskCountLike): boolean {
  // 선언된 태스크가 없는 wave는 게이트할 작업이 없는 것으로 간주한다(공허 충족).
  return wave.tasksTotal === 0 || wave.tasksDone >= wave.tasksTotal;
}

export function getLaneDispatchState(
  waves: readonly TaskCountLike[],
  waveIndex: number,
  lane: TaskCountLike,
): LaneDispatchState {
  if (lane.tasksTotal <= 0) return "none";
  if (lane.tasksDone >= lane.tasksTotal) return "complete";
  return waves.slice(0, waveIndex).every(isWaveSettled) ? "ready" : "blocked";
}
