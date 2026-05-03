import { describe, expect, it } from "vitest";

import type { ColBlock } from "../../src/agent/ui/panel/types.js";
import type { PanelRun } from "../../src/agent/ui/panel/state.js";
import type { PanelJob } from "../../src/agent/ui/panel/types.js";
import { renderPanelFull } from "../../src/shell/render/panel-renderer.js";

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
      null,
      10,
    ).join("\n");

    expect(rendered).not.toContain("line1");
    expect(rendered).not.toContain("line2");
    expect(rendered).toContain("line3");
    expect(rendered).toContain("line7");
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
