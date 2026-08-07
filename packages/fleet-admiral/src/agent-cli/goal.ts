import {
  DEFAULT_GOAL_CHECK_LIMIT,
  MAX_GOAL_CHECK_LIMIT,
  MIN_GOAL_CHECK_LIMIT,
} from "./types.js";

export function clampGoalCheckLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_GOAL_CHECK_LIMIT;
  return Math.min(MAX_GOAL_CHECK_LIMIT, Math.max(MIN_GOAL_CHECK_LIMIT, Math.trunc(value as number)));
}
