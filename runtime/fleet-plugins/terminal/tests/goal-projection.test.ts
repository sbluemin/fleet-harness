import { describe, expect, it } from "vitest";

import {
  parseGoalMarkers,
  projectSessionGoal,
  type GoalMarker,
  type GoalProjectionInput,
} from "../server/agent-api/goal-projection.js";

describe("agent goal projection", () => {
  it("parses only valid goal status attachment lines", () => {
    expect(parseGoalMarkers([
      "not json",
      JSON.stringify({ type: "message", attachment: { type: "goal_status", met: false, condition: "ignored" } }),
      JSON.stringify({ type: "attachment", attachment: { type: "other", met: false, condition: "ignored" } }),
      JSON.stringify({ type: "attachment", attachment: { type: "goal_status", condition: "missing met" } }),
      JSON.stringify({ type: "attachment", attachment: { type: "goal_status", met: false, condition: 42 } }),
      JSON.stringify({ type: "attachment", attachment: { type: "goal_status", met: false, sentinel: true, condition: "ship it" } }),
      JSON.stringify({ type: "attachment", attachment: { type: "goal_status", met: true, condition: "ship it", iterations: 2, durationMs: 300, tokens: 400, unknown: "ignored" } }),
      JSON.stringify({ type: "attachment", attachment: { type: "goal_status", met: false, condition: "typed fields", sentinel: "yes", failed: 1, iterations: Number.POSITIVE_INFINITY, durationMs: Number.NaN, tokens: "400" } }),
    ])).toEqual([
      { met: false, sentinel: true, condition: "ship it" },
      { met: true, condition: "ship it", iterations: 2, durationMs: 300, tokens: 400 },
      { met: false, condition: "typed fields" },
    ]);
  });

  it("returns null when no sentinel marker exists", () => {
    expect(projectSessionGoal(makeInput([
      { met: false, condition: "ship it" },
    ]))).toBeNull();
  });

  it("uses only markers after the last sentinel and projects a met goal", () => {
    expect(projectSessionGoal(makeInput([
      { met: false, sentinel: true, condition: "old goal" },
      { met: false, condition: "old goal" },
      { met: false, sentinel: true, condition: "current goal" },
      { met: false, condition: "current goal" },
      { met: false, condition: "current goal" },
      { met: true, condition: "current goal", iterations: 3, durationMs: 300, tokens: 400 },
    ]))).toEqual({
      state: "met",
      live: true,
      checksUsed: 2,
      checkLimit: 8,
      totalChecks: 3,
      durationMs: 300,
      tokens: 400,
    });
  });

  it("projects a failed terminal marker as impossible", () => {
    expect(projectSessionGoal(makeInput([
      { met: false, sentinel: true, condition: "ship it" },
      { met: false, failed: true, condition: "ship it", iterations: 1, durationMs: 200, tokens: 300 },
    ]))).toEqual({
      state: "impossible",
      live: true,
      checksUsed: 0,
      checkLimit: 8,
      totalChecks: 1,
      durationMs: 200,
      tokens: 300,
    });
  });

  it("omits total checks when a terminal marker has non-finite iterations", () => {
    const projection = projectSessionGoal(makeInput([
      { met: false, sentinel: true, condition: "ship it" },
      { met: true, condition: "ship it", iterations: Number.POSITIVE_INFINITY },
    ]));

    expect(projection).toMatchObject({ state: "met", checksUsed: 0 });
    expect(projection).not.toHaveProperty("totalChecks");
  });

  it("projects an exhausted idle goal as capped", () => {
    expect(projectSessionGoal(makeInput([
      { met: false, sentinel: true, condition: "ship it" },
      { met: false, condition: "ship it" },
      { met: false, condition: "ship it" },
    ], { checkLimit: 2 }))).toMatchObject({ state: "capped", checksUsed: 2, live: true });
  });

  it("projects a goal from a stopped session as unknown and not live", () => {
    expect(projectSessionGoal(makeInput([
      { met: false, sentinel: true, condition: "ship it" },
      { met: false, condition: "ship it" },
    ], { checkLimit: 1, sessionLive: false }))).toMatchObject({ state: "unknown", checksUsed: 1, live: false });
  });

  it("projects background work before running or cap states", () => {
    expect(projectSessionGoal(makeInput([
      { met: false, sentinel: true, condition: "ship it" },
      { met: false, condition: "ship it" },
    ], { backgroundPending: true, turnRunning: true, checkLimit: 1 }))).toMatchObject({ state: "deferred", checksUsed: 1, live: true });
  });

  it("projects a running goal as active before the cap state", () => {
    expect(projectSessionGoal(makeInput([
      { met: false, sentinel: true, condition: "ship it" },
      { met: false, condition: "ship it" },
    ], { turnRunning: true, checkLimit: 1 }))).toMatchObject({ state: "active", checksUsed: 1, live: true });
  });

  it("projects an unfinished idle goal below the cap as unknown", () => {
    expect(projectSessionGoal(makeInput([
      { met: false, sentinel: true, condition: "ship it" },
    ]))).toMatchObject({ state: "unknown", checksUsed: 0, live: true });
  });

  // 트랜스크립트 본문(reason)은 브라우저 DTO에 실을 수 없다 — 파싱 단계에서 버려야
  // 이후 어떤 투영도 그 문장을 다시 실을 수 없다.
  it("never carries transcript reason text into the parsed marker or the projection", () => {
    const markers = parseGoalMarkers([
      JSON.stringify({ type: "attachment", attachment: { type: "goal_status", met: false, sentinel: true, condition: "ship it" } }),
      JSON.stringify({ type: "attachment", attachment: { type: "goal_status", met: true, condition: "ship it", reason: "secret transcript text" } }),
    ]);

    expect(JSON.stringify(markers)).not.toContain("secret transcript text");
    expect(JSON.stringify(projectSessionGoal(makeInput(markers)))).not.toContain("secret transcript text");
  });
});

function makeInput(
  markers: readonly GoalMarker[],
  overrides: Partial<Omit<GoalProjectionInput, "markers">> = {},
): GoalProjectionInput {
  return {
    markers,
    checkLimit: 8,
    turnRunning: false,
    backgroundPending: false,
    sessionLive: true,
    ...overrides,
  };
}
