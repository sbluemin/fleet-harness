import type { CommodoreRoutine } from "./contracts/types.js";

/** 지역 달력은 날짜를 더해 DST를 따르고, 간격은 생성/수정 시점의 고정 위상을 잇는다. 지난 반복은 재생하지 않는다. */
export function nextRoutineAt(routine: CommodoreRoutine, after: number): number | null {
  if (!routine.enabled) return null;
  const schedule = routine.schedule;
  if (schedule.kind === "once") return Math.max(after, schedule.at);
  if (schedule.kind === "every") {
    const interval = schedule.minutes * 60_000;
    const anchor = routine.updatedAt;
    return anchor + Math.max(1, Math.floor((after - anchor) / interval) + 1) * interval;
  }
  const [hour, minute] = schedule.time.split(":").map(Number);
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = new Date(after);
    date.setDate(date.getDate() + offset);
    date.setHours(hour!, minute!, 0, 0);
    if (schedule.days.includes(date.getDay()) && date.getTime() > after) return date.getTime();
  }
  return null;
}
