import { describe, expect, it } from "vitest";

import { formatRelativeTime, getProgressPercent, getWaveProgressState } from "../client/helpers.js";

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
