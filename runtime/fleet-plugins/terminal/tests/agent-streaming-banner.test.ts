import { describe, expect, it, vi } from "vitest";

import { pruneOrphanStreamingOperations } from "../client/agent/connection.js";
import { formatElapsedDuration, formatTokenEstimate, estimateJobTokens } from "../client/agent/helpers.js";
import { isTerminalJobStatus } from "../client/agent/reduce.js";
import type { JobView } from "../client/agent/types.js";
import type { OperationNode } from "@fleet-console/sdk/operations";

type PruneOptions = Parameters<typeof pruneOrphanStreamingOperations>[1];

// ── orphan prune 검증 ──────────────────────────────────────────────────────────

describe("pruneOrphanStreamingOperations (connection resync)", () => {
  function makeOp(overrides: Partial<OperationNode>): OperationNode {
    return {
      id: "op-1",
      theaterId: "theater-1",
      type: "agent",
      pluginId: "terminal",
      title: "Test",
      payload: {},
      geometry: null,
      ts: { createdAt: 1_000, updatedAt: 1_000 },
      ...overrides,
    };
  }

  // prune은 options.operations.remove만 사용하므로 그 부분만 스텁한다.
  function makeOptions(remove: (id: string) => Promise<void>): PruneOptions {
    return { operations: { remove } } as unknown as PruneOptions;
  }

  it("agent.streaming orphan에 대해 operations.remove를 호출한다", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const ops = [
      makeOp({ id: "orphan-1", type: "agent.streaming", pluginId: "terminal" }),
      makeOp({ id: "orphan-2", type: "agent.streaming", pluginId: "terminal" }),
    ];

    pruneOrphanStreamingOperations(ops, makeOptions(remove));
    await Promise.resolve();

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("orphan-1");
    expect(remove).toHaveBeenCalledWith("orphan-2");
  });

  it("agent/shell op과 다른 plugin의 agent.streaming op은 건드리지 않는다", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const ops = [
      makeOp({ id: "agent-op", type: "agent", pluginId: "terminal" }),
      makeOp({ id: "shell-op", type: "shell", pluginId: "terminal" }),
      makeOp({ id: "foreign-op", type: "agent.streaming", pluginId: "other" }),
    ];

    pruneOrphanStreamingOperations(ops, makeOptions(remove));
    await Promise.resolve();

    expect(remove).not.toHaveBeenCalled();
  });

  it("remove 실패는 조용히 무시한다(예외 비전파)", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("network error"));
    const ops = [makeOp({ id: "orphan-1", type: "agent.streaming", pluginId: "terminal" })];

    expect(() => pruneOrphanStreamingOperations(ops, makeOptions(remove))).not.toThrow();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledWith("orphan-1");
  });
});

// ── 활성 job 필터 로직 ────────────────────────────────────────────────────────

describe("isTerminalJobStatus (도크 활성 job 필터)", () => {
  it("종료 상태(done/error/aborted)는 terminal로 분류한다", () => {
    expect(isTerminalJobStatus("done")).toBe(true);
    expect(isTerminalJobStatus("error")).toBe(true);
    expect(isTerminalJobStatus("aborted")).toBe(true);
  });

  it("진행 중 상태는 terminal이 아니다 — 도크에 표시된다", () => {
    expect(isTerminalJobStatus("active")).toBe(false);
    expect(isTerminalJobStatus("running")).toBe(false);
    expect(isTerminalJobStatus("live")).toBe(false);
  });

  it("활성 job이 없으면 primaryJob은 null — 도크 미렌더", () => {
    const jobs = [{ status: "done" }, { status: "error" }, { status: "aborted" }];
    const activeJobs = jobs.filter((job) => !isTerminalJobStatus(job.status));
    const primaryJob = activeJobs[0] ?? null;
    expect(primaryJob).toBeNull();
  });

  it("활성 job이 있으면 primaryJob은 첫 번째 활성 job — 도크 렌더", () => {
    const jobs = [{ status: "done" }, { status: "active" }, { status: "active" }];
    const activeJobs = jobs.filter((job) => !isTerminalJobStatus(job.status));
    const primaryJob = activeJobs[0] ?? null;
    expect(primaryJob).toEqual({ status: "active" });
    expect(activeJobs).toHaveLength(2);
  });
});

// ── StreamDock 순수 헬퍼 유닛 테스트 ─────────────────────────────────────────

describe("formatElapsedDuration (경과 시간 포맷)", () => {
  it("1분 미만은 Xs 형식", () => {
    expect(formatElapsedDuration(0)).toBe("0s");
    expect(formatElapsedDuration(999)).toBe("0s");
    expect(formatElapsedDuration(1000)).toBe("1s");
    expect(formatElapsedDuration(59000)).toBe("59s");
    expect(formatElapsedDuration(59999)).toBe("59s");
  });

  it("1분 이상은 Xm Ys 형식", () => {
    expect(formatElapsedDuration(60000)).toBe("1m 0s");
    expect(formatElapsedDuration(90000)).toBe("1m 30s");
    expect(formatElapsedDuration(3661000)).toBe("61m 1s");
  });

  it("음수 경과는 0s", () => {
    expect(formatElapsedDuration(-1000)).toBe("0s");
  });
});

describe("formatTokenEstimate (토큰 추정 포맷)", () => {
  it("0 이하는 빈 문자열", () => {
    expect(formatTokenEstimate(0)).toBe("");
    expect(formatTokenEstimate(-1)).toBe("");
  });

  it("1000 미만은 ~N tokens", () => {
    expect(formatTokenEstimate(1)).toBe("~1 tokens");
    expect(formatTokenEstimate(999)).toBe("~999 tokens");
  });

  it("1000 이상은 ~N.Nk tokens (끝 .0 제거)", () => {
    expect(formatTokenEstimate(1000)).toBe("~1k tokens");
    expect(formatTokenEstimate(1500)).toBe("~1.5k tokens");
    expect(formatTokenEstimate(2000)).toBe("~2k tokens");
    expect(formatTokenEstimate(1234)).toBe("~1.2k tokens");
  });
});

describe("estimateJobTokens (잡 토큰 추정)", () => {
  function makeJob(overrides: Partial<JobView>): JobView {
    return {
      jobId: "j1",
      tenantId: "t1",
      status: "active",
      updatedAt: 1000,
      trackOrder: [],
      tracks: {},
      lastEventId: 1,
      recentEvents: [],
      ...overrides,
    };
  }

  it("트랙 없으면 0", () => {
    expect(estimateJobTokens(makeJob({}))).toBe(0);
  });

  it("text+thought 길이 합산 /4 반올림", () => {
    const job = makeJob({
      trackOrder: ["t1"],
      tracks: {
        t1: {
          trackId: "t1",
          displayName: "T1",
          status: "stream",
          text: "a".repeat(400),
          thought: "b".repeat(400),
          sentTextLength: 0,
          sentThoughtLength: 0,
          tools: [],
        },
      },
    });
    // (400 + 400) / 4 = 200
    expect(estimateJobTokens(job)).toBe(200);
  });

  it("복수 트랙은 모든 트랙 합산", () => {
    const job = makeJob({
      trackOrder: ["t1", "t2"],
      tracks: {
        t1: {
          trackId: "t1",
          displayName: "T1",
          status: "stream",
          text: "a".repeat(100),
          thought: "",
          sentTextLength: 0,
          sentThoughtLength: 0,
          tools: [],
        },
        t2: {
          trackId: "t2",
          displayName: "T2",
          status: "active",
          text: "b".repeat(300),
          thought: "c".repeat(100),
          sentTextLength: 0,
          sentThoughtLength: 0,
          tools: [],
        },
      },
    });
    // t1: round(100/4) = 25, t2: round(400/4) = 100 → 125
    expect(estimateJobTokens(job)).toBe(125);
  });

  it("trackOrder에 없는 track은 무시한다", () => {
    const job = makeJob({
      trackOrder: ["t1"],
      tracks: {
        t1: {
          trackId: "t1",
          displayName: "T1",
          status: "stream",
          text: "a".repeat(400),
          thought: "",
          sentTextLength: 0,
          sentThoughtLength: 0,
          tools: [],
        },
        // t2는 trackOrder에 없음
        t2: {
          trackId: "t2",
          displayName: "T2",
          status: "active",
          text: "z".repeat(9999),
          thought: "",
          sentTextLength: 0,
          sentThoughtLength: 0,
          tools: [],
        },
      },
    });
    expect(estimateJobTokens(job)).toBe(100);
  });
});
