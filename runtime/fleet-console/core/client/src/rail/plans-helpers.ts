export type WaveProgressState = "complete" | "in-progress" | "not-started";

// dispatch 준비도는 자유 텍스트 start condition을 해석하지 않는다 — "wave 선언 순서 + 체크박스 완료"만으로 산출하는 결정론 근사다.
export type LaneDispatchState = "complete" | "ready" | "blocked" | "none";

export interface TaskCountLike {
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

export type PlanStatusFilter = "all" | "in-progress" | "complete";

export interface PlanListFilterLike extends TaskCountLike {
  readonly name: string;
  readonly title: string;
}

export function filterPlans<T extends PlanListFilterLike>(plans: readonly T[], query: string, status: PlanStatusFilter): readonly T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return plans.filter((plan) => {
    const matchesQuery = normalizedQuery === ""
      || plan.name.toLocaleLowerCase().includes(normalizedQuery)
      || plan.title.toLocaleLowerCase().includes(normalizedQuery);
    if (!matchesQuery) return false;
    if (status === "all") return true;
    if (plan.tasksTotal <= 0) return false;
    return status === "complete" ? plan.tasksDone >= plan.tasksTotal : plan.tasksDone < plan.tasksTotal;
  });
}

export function planListSignature(plan: PlanListFilterLike & { readonly updatedAt: string; readonly executionMode: string | null; readonly waveCount: number; readonly sizeBytes: number }): string {
  return [plan.name, plan.title, plan.executionMode ?? "", plan.waveCount, plan.tasksDone, plan.tasksTotal, plan.updatedAt, plan.sizeBytes].join("\u0000");
}

export function normalizePlanHeading(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// 파서는 lane heading에서 "Lane " 접두사를 제거해 저장하지만 렌더된 h3 텍스트에는 남아 있다 —
// 양쪽 모두 접두사를 벗겨 동일 기준으로 비교한다.
export function planLaneHeadingMatches(renderedHeading: string, laneHeading: string): boolean {
  const strip = (value: string) => normalizePlanHeading(value).replace(/^lane\s+/i, "");
  return strip(renderedHeading) === strip(laneHeading);
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
