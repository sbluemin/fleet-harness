import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyOscAgentActivity, createOscAgentActivityTracker } from "../server/agent-api/osc-agent-activity.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("OSC Agent activity classification", () => {
  it("keeps Claude not-working independent from the working title body", () => {
    expect(classifyOscAgentActivity("claude", "⠐ Write sentences for numbers 1 to 120")).toBe("working");
    expect(classifyOscAgentActivity("claude-kimi", "✳ Claude Code")).toBe("not-working");
    expect(classifyOscAgentActivity("claude", "✳ 1부터 200까지 숫자별 문장 작성")).toBe("not-working");
    expect(classifyOscAgentActivity("claude", "project")).toBe("unknown");
  });

  it("commits a bare Codex title only when it exactly matches the working body baseline", () => {
    expect(classifyOscAgentActivity("codex", "⠏ codexlab")).toBe("working");
    expect(classifyOscAgentActivity("codex", "codexlab")).toBe("unknown");
    expect(classifyOscAgentActivity("codex", "codexlab", "codexlab")).toBe("not-working");
    expect(classifyOscAgentActivity("codex", "child-title", "codexlab")).toBe("unknown");
    expect(classifyOscAgentActivity("codex", " codexlab", "codexlab")).toBe("unknown");
    expect(classifyOscAgentActivity("codex", "\x1bcodexlab", "codexlab")).toBe("unknown");
  });

  it("treats child braille as conservatively working and provider-specific star titles without cross-provider inference", () => {
    expect(classifyOscAgentActivity("codex", "⠐ child-title", "codexlab")).toBe("working");
    expect(classifyOscAgentActivity("codex", "✳ child-title", "codexlab")).toBe("unknown");
    expect(classifyOscAgentActivity("claude", "⠐ child-title")).toBe("working");
    expect(classifyOscAgentActivity("claude", "✳ child-title")).toBe("not-working");
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

  it("cancels pending not-working when working returns and preserves not-working duplicate suppression", () => {
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

    expect(emitted).toEqual(["working", "working", "working"]);
    tracker.observeTitle("✳ project");
    vi.advanceTimersByTime(400);
    tracker.observeTitle("✳ project");
    vi.advanceTimersByTime(400);
    expect(emitted).toEqual(["working", "working", "working", "not-working"]);
  });

  it("rejects a child OSC body while committing a matching Codex baseline after 400ms", () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const tracker = createOscAgentActivityTracker({ cliId: "codex", onActivity: (activity) => emitted.push(activity) });

    tracker.observeTitle("⠏ codexlab");
    tracker.observeTitle("child-title");
    vi.advanceTimersByTime(450);
    expect(emitted).toEqual(["working"]);

    tracker.observeTitle("codexlab");
    vi.advanceTimersByTime(400);
    expect(emitted).toEqual(["working", "not-working"]);
  });

  it.each(["tracker removal", "PTY exit", "resume"])("reset used by %s clears the Codex baseline and pending debounce", () => {
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
