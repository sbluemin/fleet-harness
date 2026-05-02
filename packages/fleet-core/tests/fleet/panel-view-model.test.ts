import { describe, expect, it } from "vitest";

import {
  buildPanelViewModel,
  type PanelJob,
  type PanelRunViewModelSource,
} from "../../src/admiral/_shared/view-model.js";

describe("buildPanelViewModel", () => {
  it("렌더러가 사용할 run 상태와 통계를 plain data로 생성한다", () => {
    const runId = "run-genesis-1";
    const runs = new Map<string, PanelRunViewModelSource>([
      [runId, {
        runId,
        status: "done",
        blocks: [
          { type: "tool", title: "read", status: "done" },
          { type: "text", text: "first\nsecond\n" },
        ],
      }],
    ]);

    const jobs: PanelJob[] = [{
      jobId: "job-1",
      kind: "sortie",
      ownerCarrierId: "genesis",
      label: "Genesis",
      startedAt: 1,
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
    }];

    const [job] = buildPanelViewModel(jobs, runs);
    expect(job!.tracks[0]).toMatchObject({
      trackId: "genesis",
      runId,
      status: "done",
      toolCallCount: 1,
      textLineCount: 2,
      isComplete: true,
    });
    expect(job!.tracks[0]!.blocks).toHaveLength(2);
  });
});
