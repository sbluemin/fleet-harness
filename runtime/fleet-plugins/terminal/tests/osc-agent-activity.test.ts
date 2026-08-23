import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyOscAgentActivity, createOscAgentActivityTracker } from "../server/agent-api/osc-agent-activity.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("OSC Agent activity classification", () => {
  it("keeps Claude not-working independent from the working title body", () => {
    expect(classifyOscAgentActivity("claude", "⠐ Write sentences for numbers 1 to 120")).toBe("working");
    expect(classifyOscAgentActivity("claude", "✳ Claude Code")).toBe("not-working");
    expect(classifyOscAgentActivity("claude", "✳ 1부터 200까지 숫자별 문장 작성")).toBe("not-working");
    expect(classifyOscAgentActivity("claude", "project")).toBe("unknown");
  });



  it("treats child braille as conservatively working and provider-specific star titles without cross-provider inference", () => {
    expect(classifyOscAgentActivity("claude", "⠐ child-title")).toBe("working");
    expect(classifyOscAgentActivity("claude", "✳ child-title")).toBe("not-working");
  });

  // Claude Code v2.1.228은 작업 중 스피너를 브라유가 아니라 원형 4프레임으로 그린다. 두 계열 모두
  // 같은 뜻(호스트 턴 진행 중)이므로 함께 인식해야 한다 — 하나만 알면 턴 내내 not-working으로 굳어
  // 입력 대기가 풀리지 않는다.
  it("reads the circle spinner frames as working alongside braille", () => {
    for (const title of ["◐ Claude Code", "◑ Claude Code", "◒ 서브에이전트로 1부터 30까지 세기", "◓ project"]) {
      expect(classifyOscAgentActivity("claude", title)).toBe("working");
    }
    expect(classifyOscAgentActivity("claude", "○ project")).toBe("unknown");
  });
});

describe("OSC Agent activity debounce", () => {
  it("commits working immediately and not-working only after 400ms", () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const tracker = createOscAgentActivityTracker({
      cliId: "claude",
      cwdBasename: "project",
      onActivity: (activity) => emitted.push(activity),
    });

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
    const tracker = createOscAgentActivityTracker({
      cliId: "claude",
      cwdBasename: "project",
      onActivity: (activity) => emitted.push(activity),
    });

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

  // 실측 파형: 턴이 도는 동안 CLI는 기본 타이틀(✳)과 스피너 프레임을 100ms 이내로 번갈아 쓴다.
  // 스피너 계열을 못 읽으면 이 파형이 통째로 not-working으로 굳어 패널이 유휴/입력 대기에 갇힌다.
  it("stays working while the CLI alternates the base title with circle spinner frames", () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const tracker = createOscAgentActivityTracker({
      cliId: "claude",
      cwdBasename: "project",
      onActivity: (activity) => emitted.push(activity),
    });

    for (let frame = 0; frame < 6; frame += 1) {
      tracker.observeTitle("✳ Claude Code");
      vi.advanceTimersByTime(90);
      tracker.observeTitle(frame % 2 === 0 ? "◐ Claude Code" : "◑ Claude Code");
      vi.advanceTimersByTime(90);
    }

    expect(emitted).not.toContain("not-working");
    vi.advanceTimersByTime(400);
    expect(emitted).not.toContain("not-working");
    tracker.observeTitle("✳ Claude Code");
    vi.advanceTimersByTime(400);
    expect(emitted[emitted.length - 1]).toBe("not-working");
  });






});
