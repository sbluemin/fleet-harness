import { describe, expect, it } from "vitest";

import { formatRelativeTime, getLaneDispatchState, getProgressPercent, getWaveProgressState, isWaveSettled } from "../core/client/src/rail/plans-helpers.js";

const NOW = Date.UTC(2026, 6, 10, 0, 0, 0);

describe("formatRelativeTime", () => {
  it("formats recent, minute, hour, and day-relative timestamps", () => {
    expect(formatRelativeTime("2026-07-09T23:59:31.000Z", NOW)).toBe("just now");
    expect(formatRelativeTime("2026-07-09T23:55:00.000Z", NOW)).toBe("5m ago");
    expect(formatRelativeTime("2026-07-09T21:00:00.000Z", NOW)).toBe("3h ago");
    expect(formatRelativeTime("2026-07-07T00:00:00.000Z", NOW)).toBe("3d ago");
  });

  it("does not show future timestamps as negative elapsed time", () => {
    expect(formatRelativeTime("2026-07-10T00:05:00.000Z", NOW)).toBe("just now");
  });

  it("returns a neutral label for an invalid timestamp", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBe("Unknown");
  });
});

describe("getProgressPercent", () => {
  it("omits progress when no tasks exist", () => {
    expect(getProgressPercent(0, 0)).toBeNull();
  });

  it("rounds and clamps task progress", () => {
    expect(getProgressPercent(1, 3)).toBe(33);
    expect(getProgressPercent(-2, 4)).toBe(0);
    expect(getProgressPercent(8, 4)).toBe(100);
  });
});

describe("getWaveProgressState", () => {
  it("classifies complete, in-progress, and not-started waves", () => {
    expect(getWaveProgressState(3, 3)).toBe("complete");
    expect(getWaveProgressState(1, 3)).toBe("in-progress");
    expect(getWaveProgressState(0, 3)).toBe("not-started");
  });
});

describe("getLaneDispatchState", () => {
  const wave = (tasksDone: number, tasksTotal: number) => ({ tasksDone, tasksTotal });

  it("treats a wave without declared tasks as vacuously settled", () => {
    expect(isWaveSettled(wave(0, 0))).toBe(true);
    expect(isWaveSettled(wave(1, 2))).toBe(false);
  });

  it("marks a finished lane complete regardless of predecessors", () => {
    expect(getLaneDispatchState([wave(0, 3), wave(0, 2)], 1, wave(2, 2))).toBe("complete");
  });

  it("marks a lane ready only when every earlier wave is settled", () => {
    expect(getLaneDispatchState([wave(3, 3), wave(0, 2)], 1, wave(0, 2))).toBe("ready");
    expect(getLaneDispatchState([wave(1, 3), wave(0, 2)], 1, wave(0, 2))).toBe("blocked");
  });

  it("keeps first-wave lanes ready and taskless lanes unmarked", () => {
    expect(getLaneDispatchState([wave(0, 2)], 0, wave(0, 2))).toBe("ready");
    expect(getLaneDispatchState([wave(0, 2)], 0, wave(0, 0))).toBe("none");
  });
});
