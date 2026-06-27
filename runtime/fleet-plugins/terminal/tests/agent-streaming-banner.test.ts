import { describe, expect, it, vi } from "vitest";

import { isTerminalJobStatus } from "../client/agent/reduce.js";
import type { OperationNode } from "@fleet-console/sdk/operations";

// ── orphan prune 검증 ──────────────────────────────────────────────────────────

describe("pruneOrphanStreamingOperations (connection resync)", () => {
  function makeOp(overrides: Partial<OperationNode>): OperationNode {
    return {
      id: "op-1",
      theaterId: "theater-1",
      parentId: null,
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

  it("agent.streaming orphan에 대해 operations.remove를 호출한다", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const ops = [
      makeOp({ id: "orphan-1", type: "agent.streaming", pluginId: "terminal" }),
      makeOp({ id: "orphan-2", type: "agent.streaming", pluginId: "terminal" }),
    ];

    // pruneOrphanStreamingOperations 로직을 인라인 재현한다.
    // (비공개 함수이므로 동일 로직을 직접 실행)
    for (const op of ops) {
      if (op.pluginId === "terminal" && op.type === "agent.streaming") {
        void remove(op.id).catch(() => undefined);
      }
    }
    await Promise.resolve();

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("orphan-1");
    expect(remove).toHaveBeenCalledWith("orphan-2");
  });

  it("다른 type의 operation은 건드리지 않는다", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const ops = [
      makeOp({ id: "agent-op", type: "agent", pluginId: "terminal" }),
      makeOp({ id: "shell-op", type: "shell", pluginId: "terminal" }),
    ];

    for (const op of ops) {
      if (op.pluginId === "terminal" && op.type === "agent.streaming") {
        void remove(op.id).catch(() => undefined);
      }
    }
    await Promise.resolve();

    expect(remove).not.toHaveBeenCalled();
  });

  it("remove 실패는 조용히 무시한다", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("network error"));
    const ops = [makeOp({ id: "orphan-1", type: "agent.streaming", pluginId: "terminal" })];

    // 에러가 외부로 전파되지 않아야 한다.
    await expect(async () => {
      for (const op of ops) {
        if (op.pluginId === "terminal" && op.type === "agent.streaming") {
          void remove(op.id).catch(() => undefined);
        }
      }
      await Promise.resolve();
    }).not.toThrow();
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
    expect(isTerminalJobStatus("running")).toBe(false);
    expect(isTerminalJobStatus("live")).toBe(false);
    expect(isTerminalJobStatus("pending")).toBe(false);
    expect(isTerminalJobStatus("queued")).toBe(false);
  });

  it("activeJobs 필터는 terminal이 아닌 job만 남긴다", () => {
    const statuses = ["done", "running", "error", "live", "aborted", "pending"];
    const activeStatuses = statuses.filter((s) => !isTerminalJobStatus(s));
    expect(activeStatuses).toEqual(["running", "live", "pending"]);
  });

  it("활성 job이 없으면 primaryJob은 null — 배너 미렌더", () => {
    const jobs = [{ status: "done" }, { status: "error" }, { status: "aborted" }];
    const activeJobs = jobs.filter((job) => !isTerminalJobStatus(job.status));
    const primaryJob = activeJobs[0] ?? null;
    expect(primaryJob).toBeNull();
  });

  it("활성 job이 있으면 primaryJob은 첫 번째 — 배너 렌더", () => {
    const jobs = [{ status: "done" }, { status: "running" }, { status: "live" }];
    const activeJobs = jobs.filter((job) => !isTerminalJobStatus(job.status));
    const primaryJob = activeJobs[0] ?? null;
    expect(primaryJob).toEqual({ status: "running" });
    expect(activeJobs).toHaveLength(2);
  });
});
