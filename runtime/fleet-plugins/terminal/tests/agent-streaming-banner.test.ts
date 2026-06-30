import { describe, expect, it, vi } from "vitest";

import { pruneOrphanStreamingOperations } from "../client/agent/connection.js";
import { isTerminalJobStatus } from "../client/agent/reduce.js";
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
      state: {},
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

describe("isTerminalJobStatus (배너 활성 job 필터)", () => {
  it("종료 상태(done/error/aborted)는 terminal로 분류한다", () => {
    expect(isTerminalJobStatus("done")).toBe(true);
    expect(isTerminalJobStatus("error")).toBe(true);
    expect(isTerminalJobStatus("aborted")).toBe(true);
  });

  it("진행 중 상태는 terminal이 아니다 — 배너에 표시된다", () => {
    expect(isTerminalJobStatus("active")).toBe(false);
    expect(isTerminalJobStatus("running")).toBe(false);
    expect(isTerminalJobStatus("live")).toBe(false);
  });

  it("활성 job이 없으면 primaryJob은 null — 배너 미렌더", () => {
    const jobs = [{ status: "done" }, { status: "error" }, { status: "aborted" }];
    const activeJobs = jobs.filter((job) => !isTerminalJobStatus(job.status));
    const primaryJob = activeJobs[0] ?? null;
    expect(primaryJob).toBeNull();
  });

  it("활성 job이 있으면 primaryJob은 첫 번째 활성 job — 배너 렌더", () => {
    const jobs = [{ status: "done" }, { status: "active" }, { status: "active" }];
    const activeJobs = jobs.filter((job) => !isTerminalJobStatus(job.status));
    const primaryJob = activeJobs[0] ?? null;
    expect(primaryJob).toEqual({ status: "active" });
    expect(activeJobs).toHaveLength(2);
  });
});
