import { describe, expect, it, vi } from "vitest";

import { createTerminalStatusDetailReporter, extractMeaningfulStatusDetail } from "../client/shared/status-detail.js";

describe("terminal status detail", () => {
  it.each([
    ["┌────────────┐", null],
    ["⠋", null],
    ["100%", null],
    ["ok", null],
    ["Building client bundle", "Building client bundle"],
  ])("filters terminal tail %j", (input, expected) => {
    expect(extractMeaningfulStatusDetail(input)).toBe(expected);
  });

  it("trails transcript output and reports only the latest meaningful line", () => {
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const report = vi.fn();
    const reporter = createTerminalStatusDetailReporter({
      report,
      setTimer: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => {
        const index = timers.indexOf(timer as unknown as typeof timers[number]);
        if (index >= 0) timers.splice(index, 1);
      },
    });

    reporter.push("First meaningful line");
    expect(report).not.toHaveBeenCalled();
    expect(timers.at(-1)?.delay).toBe(500);

    reporter.push("\rSecond meaningful line");
    expect(timers).toHaveLength(1);
    timers[0]!.callback();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith("Second meaningful line");

    reporter.dispose();
  });
});
