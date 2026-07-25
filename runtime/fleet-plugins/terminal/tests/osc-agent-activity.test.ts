import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyOscAgentActivity, createOscAgentActivityTracker } from "../server/agent-api/osc-agent-activity.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("OSC Agent activity classification", () => {
  it("classifies Claude family spinner, not-working glyph, and unknown prefixes", () => {
    expect(classifyOscAgentActivity("claude", "⠐ project")).toBe("working");
    expect(classifyOscAgentActivity("claude-kimi", "✳ project")).toBe("not-working");
    expect(classifyOscAgentActivity("claude", "project")).toBe("unknown");
  });

  it("gates bare Codex titles on a previously recognized spinner", () => {
    expect(classifyOscAgentActivity("codex", "⠂ project", false)).toBe("working");
    expect(classifyOscAgentActivity("codex", "project", false)).toBe("unknown");
    expect(classifyOscAgentActivity("codex", "project", true)).toBe("not-working");
    expect(classifyOscAgentActivity("codex", " project", true)).toBe("unknown");
    expect(classifyOscAgentActivity("codex", "\x1bproject", true)).toBe("unknown");
  });
});

describe("OSC Agent activity debounce", () => {
  it("commits working immediately and not-working only after 400ms", () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const tracker = createOscAgentActivityTracker({ cliId: "claude", onActivity: (activity) => emitted.push(activity) });

    tracker.observeTitle("⠐ project");
    expect(emitted).toEqual(["working"]);
    tracker.observeTitle("✳ project");
    vi.advanceTimersByTime(399);
    expect(emitted).toEqual(["working"]);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(["working", "not-working"]);
  });

  it("cancels pending not-working when working returns and suppresses duplicate classifications", () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const tracker = createOscAgentActivityTracker({ cliId: "claude", onActivity: (activity) => emitted.push(activity) });

    tracker.observeTitle("⠐ one");
    tracker.observeTitle("⠂ two");
    tracker.observeTitle("✳ project");
    tracker.observeTitle("✳ project");
    vi.advanceTimersByTime(200);
    tracker.observeTitle("⠄ project");
    vi.advanceTimersByTime(400);

    expect(emitted).toEqual(["working"]);
    tracker.observeTitle("✳ project");
    vi.advanceTimersByTime(400);
    tracker.observeTitle("✳ project");
    vi.advanceTimersByTime(400);
    expect(emitted).toEqual(["working", "not-working"]);
  });

  it("resets the Codex working-history gate and pending debounce", () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const tracker = createOscAgentActivityTracker({ cliId: "codex", onActivity: (activity) => emitted.push(activity) });

    tracker.observeTitle("⠐ project");
    tracker.observeTitle("project");
    tracker.reset();
    vi.advanceTimersByTime(400);
    tracker.observeTitle("project");
    vi.advanceTimersByTime(400);

    expect(emitted).toEqual(["working"]);
  });
});
