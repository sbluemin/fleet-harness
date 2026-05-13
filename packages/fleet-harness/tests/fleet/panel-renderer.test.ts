import { describe, expect, it } from "vitest";

import type { ColBlock } from "../../src/panel/types.js";
import type { PanelRun } from "../../src/panel/state.js";
import type { PanelJob } from "../../src/panel/types.js";
import { computeResponsiveLayout } from "../../src/hud/layout.js";
import { getPreset } from "../../src/hud/theme.js";
import { renderPanelFull } from "../../src/panel/panel-render.js";

describe("renderPanelFull", () => {
  it("긴 단일 text block도 최근 5줄 tail로 제한한다", () => {
    const runId = "run-1";
    const runs = new Map<string, PanelRun>([
      [runId, buildRun(runId, [{ type: "text", text: "line1\nline2\nline3\nline4\nline5\nline6\nline7\n" }])],
    ]);

    const rendered = renderPanelFull(
      100,
      [buildJob(runId)],
      runs,
      0,
      "",
      "",
      10,
    ).join("\n");

    expect(rendered).not.toContain("line1");
    expect(rendered).not.toContain("line2");
    expect(rendered).toContain("line3");
    expect(rendered).toContain("line7");
  });

  it("does not render extension status roster values in the footer secondary row", () => {
    const layout = computeResponsiveLayout(
      {
        model: undefined,
        thinkingLevel: "off",
        sessionId: undefined,
        usageStats: { input: 0, output: 0, cost: 0 },
        usingSubscription: false,
        sessionStartTime: Date.now(),
        git: { branch: null, staged: 0, unstaged: 0, untracked: 0 },
        extensionStatuses: new Map([["carrier", " ○ Genesis"]]),
        options: {},
        theme: { fg: (_token: string, text: string) => text } as any,
        colors: {},
      },
      getPreset("sbluemin"),
      80,
    );

    expect(getPreset("sbluemin").secondarySegments).not.toContain(["extension", "statuses"].join("_"));
    expect(layout.secondaryContent).not.toContain("Genesis");
  });
});

function buildJob(runId: string): PanelJob {
  return {
    jobId: "job-1",
    kind: "sortie",
    ownerCarrierId: "genesis",
    label: "Genesis",
    startedAt: Date.now(),
    status: "active",
    tracks: [{
      trackId: "genesis",
      streamKey: "genesis",
      displayCli: "genesis",
      runId,
      displayName: "Genesis",
      kind: "carrier",
      status: "wait",
    }],
  };
}

function buildRun(runId: string, blocks: ColBlock[]): PanelRun {
  return {
    runId,
    cli: "genesis",
    blocks,
    status: "stream",
    text: "",
    thinking: "",
    toolCalls: [],
    toCollectedData() {
      return {
        text: "",
        thinking: "",
        toolCalls: [],
        blocks,
        lastStatus: "stream",
      };
    },
  };
}
