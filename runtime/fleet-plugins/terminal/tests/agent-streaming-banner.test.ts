import { describe, expect, it, vi } from "vitest";

import { pruneOrphanStreamingOperations } from "../client/agent/connection.js";
import { deriveTrackPhase, describeToolTarget, formatElapsedDuration, formatTokenEstimate, estimateJobTokens, getDockTailText, isDockTrackLive, isTrackError, isTrackLive, mergeDockJobs, mergeJobIds, pruneRetainedJobs, resolveDockRowStatusLabel, resolveJobSignature, resolveCarrierCaptain, retainCompletedJobs, selectJobsByIds } from "../client/agent/helpers.js";
import { applyEvent, createEmptyJob, isTerminalJobStatus } from "../client/agent/reduce.js";
import type { JobView } from "../client/agent/types.js";
import type { OperationNode } from "@fleet-console/sdk/operations";

type PruneOptions = Parameters<typeof pruneOrphanStreamingOperations>[1];

function makeStreamJob(jobId: string, status = "active"): JobView {
  return {
    jobId,
    tenantId: "tenant-1",
    status,
    updatedAt: 1_000,
    trackOrder: [],
    tracks: {},
    lastEventId: 1,
    recentEvents: [],
  };
}

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

describe("isTrackLive (도크와 Details 라이브 신호)", () => {
  it("conn 상태를 라이브로 분류하고 queued는 제외한다", () => {
    expect(isTrackLive("conn")).toBe(true);
    expect(isTrackLive("queued")).toBe(false);
  });
});

describe("isTrackError (에러 신호 매칭)", () => {
  it('트랙 SSoT "err"와 잡 레벨 "error"를 모두 에러로 분류한다', () => {
    expect(isTrackError("err")).toBe(true);
    expect(isTrackError("error")).toBe(true);
    expect(isTrackError("done")).toBe(false);
    expect(isTrackError("aborted")).toBe(false);
  });
});

describe("resolveDockRowStatusLabel (잔존 도크 행 라벨)", () => {
  it("혼합 결과 taskforce 잔존 시 성공 트랙은 done, 실패 트랙만 error로 표기한다", () => {
    expect(resolveDockRowStatusLabel("done", "error")).toBe("done");
    expect(resolveDockRowStatusLabel("err", "error")).toBe("error");
    expect(resolveDockRowStatusLabel("aborted", "error")).toBe("aborted");
  });

  it("종결 잡 안의 미종결 트랙만 잡 상태로 폴백하고, 진행 중에는 트랙 상태를 그대로 쓴다", () => {
    expect(resolveDockRowStatusLabel("stream", "error")).toBe("error");
    expect(resolveDockRowStatusLabel("stream", "active")).toBe("stream");
  });
});

describe("getDockTailText (접힘 스트립 테일)", () => {
  function makeTailJob(
    jobId: string,
    jobStatus: string,
    tracks: readonly { id: string; status: string; lastEventId: number; latestLine?: string; thought?: string }[]
  ): JobView {
    return {
      jobId,
      tenantId: "tenant-1",
      status: jobStatus,
      updatedAt: 1_000,
      trackOrder: tracks.map((t) => t.id),
      tracks: Object.fromEntries(tracks.map((t) => [t.id, {
        trackId: t.id,
        displayName: t.id,
        status: t.status,
        lastEventId: t.lastEventId,
        latestLine: t.latestLine,
        text: t.latestLine ?? "",
        thought: t.thought ?? "",
        sentTextLength: 0,
        sentThoughtLength: 0,
        tools: [],
      }])),
      lastEventId: Math.max(0, ...tracks.map((t) => t.lastEventId)),
      recentEvents: [],
    };
  }

  it("잔존 종결 잡의 stale output이 라이브 thinking 트랙을 가리지 않는다", () => {
    const retained = makeTailJob("done-1", "done", [{ id: "a", status: "done", lastEventId: 10, latestLine: "finished output" }]);
    const live = makeTailJob("live-1", "active", [{ id: "b", status: "stream", lastEventId: 20, thought: "reasoning" }]);
    expect(getDockTailText([retained, live])).toEqual({ text: "", thinking: true });
  });

  it("라이브 트랙이 있으면 잔존 트랙의 이벤트가 더 최신이어도 라이브 output을 테일로 쓴다", () => {
    const live = makeTailJob("live-1", "active", [{ id: "b", status: "stream", lastEventId: 20, latestLine: "live output", thought: "r" }]);
    const retained = makeTailJob("done-1", "done", [{ id: "a", status: "done", lastEventId: 30, latestLine: "finished output" }]);
    expect(getDockTailText([live, retained])).toEqual({ text: "live output", thinking: false });
  });

  it("라이브 트랙이 없으면 잔존 종결 output으로 폴백한다", () => {
    const retained = makeTailJob("done-1", "done", [{ id: "a", status: "done", lastEventId: 10, latestLine: "finished output" }]);
    expect(getDockTailText([retained])).toEqual({ text: "finished output", thinking: false });
  });

  it("라이브 풀 안에서도 최신 활동이 thinking-only 트랙이면 오래된 output 대신 thinking을 표시한다", () => {
    const live = makeTailJob("live-1", "active", [
      { id: "a", status: "stream", lastEventId: 10, latestLine: "older output" },
      { id: "b", status: "stream", lastEventId: 20, thought: "fresh reasoning" },
    ]);
    expect(getDockTailText([live])).toEqual({ text: "", thinking: true });
    // 반대로 output 트랙이 최신이면 그 라인이 테일이다.
    const flipped = makeTailJob("live-2", "active", [
      { id: "a", status: "stream", lastEventId: 30, latestLine: "newest output" },
      { id: "b", status: "stream", lastEventId: 20, thought: "old reasoning" },
    ]);
    expect(getDockTailText([flipped])).toEqual({ text: "newest output", thinking: false });
  });

  it("종결 잡의 stale 라이브 트랙은 라이브 풀에 들어가지 않는다", () => {
    // job:finalized가 트랙 상태를 바꾸지 않아 stream으로 남은 트랙 — 라이브로 취급 금지.
    const staleRetained = makeTailJob("err-1", "error", [{ id: "a", status: "stream", lastEventId: 30, latestLine: "partial output" }]);
    const live = makeTailJob("live-1", "active", [{ id: "b", status: "stream", lastEventId: 20, thought: "reasoning" }]);
    expect(getDockTailText([staleRetained, live])).toEqual({ text: "", thinking: true });
    expect(getDockTailText([staleRetained])).toEqual({ text: "partial output", thinking: false });
  });
});

describe("isDockTrackLive (잡 종결 게이트 라이브 판정)", () => {
  it("비종결 잡의 라이브 트랙만 라이브로 판정한다", () => {
    expect(isDockTrackLive("active", "stream")).toBe(true);
    expect(isDockTrackLive("done", "stream")).toBe(false);
    expect(isDockTrackLive("error", "active")).toBe(false);
    expect(isDockTrackLive("active", "done")).toBe(false);
  });
});

describe("deriveTrackPhase (phase 카드 상태)", () => {
  function makeTrack(overrides: Partial<JobView["tracks"][string]> = {}): JobView["tracks"][string] {
    return {
      trackId: "track-1",
      displayName: "Carrier",
      status: "stream",
      lastEventId: 1,
      text: "",
      thought: "",
      sentTextLength: 0,
      sentThoughtLength: 0,
      tools: [],
      ...overrides,
    };
  }

  it.each([
    ["error", "active", { label: "Error", tone: "error" }],
    ["stream", "error", { label: "Error", tone: "error" }],
    ["aborted", "active", { label: "Aborted", tone: "error" }],
    ["stream", "aborted", { label: "Aborted", tone: "error" }],
    ["done", "active", { label: "Done", tone: "done" }],
    ["stream", "done", { label: "Done", tone: "done" }],
  ] as const)("track=%s job=%s의 종결 phase를 도출한다", (trackStatus, jobStatus, expected) => {
    expect(deriveTrackPhase(makeTrack({ status: trackStatus }), jobStatus)).toEqual(expected);
  });

  it("혼합 결과에서는 resolveDockRowStatusLabel 계약과 같이 트랙 종결 상태를 job 오류보다 우선한다", () => {
    const track = makeTrack({ status: "done" });
    expect(resolveDockRowStatusLabel(track.status, "error")).toBe("done");
    expect(deriveTrackPhase(track, "error")).toEqual({ label: "Done", tone: "done" });
  });

  it("err 트랙은 error tone이고 종결 job의 stale stream 트랙은 job 상태로 폴백한다", () => {
    const errorPhase = deriveTrackPhase(makeTrack({ status: "err" }), "active");
    const staleTrackPhase = deriveTrackPhase(makeTrack({ status: "stream" }), "done");
    expect(errorPhase).toEqual({ label: "Error", tone: "error" });
    expect(errorPhase.tone === "live").toBe(false);
    expect(staleTrackPhase).toEqual({ label: "Done", tone: "done" });
    expect(staleTrackPhase.tone === "live").toBe(false);
  });

  it("마지막 미종결 도구를 출력보다 우선하고 이름이 없으면 tool로 폴백한다", () => {
    expect(deriveTrackPhase(makeTrack({
      text: "partial output",
      thought: "hidden reasoning",
      tools: [
        { id: "done", name: "read", status: "done" },
        { id: "live", status: "running" },
      ],
    }), "active")).toEqual({ label: "Using tool", tone: "live" });
  });

  it("완료된 마지막 도구는 건너뛰고 Writing을 Reasoning보다 우선한다", () => {
    expect(deriveTrackPhase(makeTrack({
      text: "partial output",
      thought: "hidden reasoning",
      tools: [{ id: "done", name: "read", status: "done" }],
    }), "active")).toEqual({ label: "Writing", tone: "live" });
  });

  it("output 없이 thought가 있으면 Reasoning, 둘 다 없으면 Working이다", () => {
    expect(deriveTrackPhase(makeTrack({ thought: "hidden reasoning" }), "active")).toEqual({ label: "Reasoning", tone: "live" });
    expect(deriveTrackPhase(makeTrack(), "active")).toEqual({ label: "Working", tone: "live" });
  });

  it("종결 상태가 라이브 activity보다 항상 우선한다", () => {
    expect(deriveTrackPhase(makeTrack({
      status: "done",
      text: "output",
      tools: [{ id: "live", name: "write", status: "running" }],
    }), "active")).toEqual({ label: "Done", tone: "done" });
    expect(deriveTrackPhase(makeTrack({ status: "done" }), "error")).toEqual({ label: "Done", tone: "done" });
  });
});

describe("describeToolTarget (도구 대상 요약)", () => {
  it("승인된 키 우선순위에서 첫 string 값을 선택한다", () => {
    expect(describeToolTarget({ pattern: "later", command: "pnpm test", path: "src/index.ts", file_path: "src/main.ts" })).toBe("src/main.ts");
    expect(describeToolTarget({ path: 42, file: "fallback.ts" })).toBe("fallback.ts");
  });

  it("대상을 60자로 절단한다", () => {
    expect(describeToolTarget({ query: "q".repeat(75) })).toBe("q".repeat(60));
  });

  it("object가 아니거나 string 대상 키가 없으면 null이다", () => {
    expect(describeToolTarget(null)).toBeNull();
    expect(describeToolTarget(["file.ts"])).toBeNull();
    expect(describeToolTarget({ path: false, other: "ignored" })).toBeNull();
  });
});

describe("Carrier Stream job retention helpers", () => {
  it("모달 job 집합은 기존 순서를 보존하며 새 활성 job을 합친다", () => {
    expect(mergeJobIds(["completed-1"], ["active-1", "completed-1", "active-2"])).toEqual([
      "completed-1",
      "active-1",
      "active-2",
    ]);
  });

  it("도크 잔존은 만료되거나 스냅숏에서 사라진 job을 제거한다", () => {
    const jobs = [makeStreamJob("done-1", "done")];
    const retained = retainCompletedJobs([], ["done-1", "gone-1"], 5_000);

    expect(pruneRetainedJobs(retained, jobs, 4_999)).toEqual([{ jobId: "done-1", expiresAt: 5_000 }]);
    expect(pruneRetainedJobs(retained, jobs, 5_000)).toEqual([]);
  });

  it("도크는 활성 job을 우선하고 잔존 완료 job을 뒤에 합친다", () => {
    const active = makeStreamJob("active-1");
    const completed = makeStreamJob("done-1", "done");
    const retained = retainCompletedJobs([], ["done-1"], 5_000);

    expect(selectJobsByIds([active, completed], ["done-1"])).toEqual([completed]);
    expect(mergeDockJobs([active], [active, completed], retained)).toEqual([active, completed]);
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

  it("방출 길이(sentTextLength+sentThoughtLength) 합산 /4 반올림", () => {
    const job = makeJob({
      trackOrder: ["t1"],
      tracks: {
        t1: {
          trackId: "t1",
          displayName: "T1",
          status: "stream",
          text: "a".repeat(400),
          thought: "b".repeat(400),
          sentTextLength: 400,
          sentThoughtLength: 400,
          lastEventId: 0,
          tools: [],
        },
      },
    });
    // (400 + 400) / 4 = 200
    expect(estimateJobTokens(job)).toBe(200);
  });

  it("retention clamp: 보존 text가 잘려도 방출 길이로 추정한다", () => {
    const job = makeJob({
      trackOrder: ["t1"],
      tracks: {
        t1: {
          trackId: "t1",
          displayName: "T1",
          status: "stream",
          // 보존 text는 clamp되어 20자만 남았지만 실제 방출은 4000자
          text: "a".repeat(20),
          thought: "",
          sentTextLength: 4000,
          sentThoughtLength: 0,
          lastEventId: 0,
          tools: [],
        },
      },
    });
    // text.length(20)/4=5가 아니라 sentTextLength(4000)/4=1000
    expect(estimateJobTokens(job)).toBe(1000);
  });

  it("복수 트랙은 모든 트랙 합산", () => {
    const job = makeJob({
      trackOrder: ["t1", "t2"],
      tracks: {
        t1: {
          trackId: "t1",
          displayName: "T1",
          status: "stream",
          text: "",
          thought: "",
          sentTextLength: 100,
          sentThoughtLength: 0,
          lastEventId: 0,
          tools: [],
        },
        t2: {
          trackId: "t2",
          displayName: "T2",
          status: "active",
          text: "",
          thought: "",
          sentTextLength: 300,
          sentThoughtLength: 100,
          lastEventId: 0,
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
          text: "",
          thought: "",
          sentTextLength: 400,
          sentThoughtLength: 0,
          lastEventId: 0,
          tools: [],
        },
        // t2는 trackOrder에 없음
        t2: {
          trackId: "t2",
          displayName: "T2",
          status: "active",
          text: "",
          thought: "",
          sentTextLength: 9999,
          sentThoughtLength: 0,
          lastEventId: 0,
          tools: [],
        },
      },
    });
    expect(estimateJobTokens(job)).toBe(100);
  });
});

// ── resolveJobSignature 유닛 테스트 ───────────────────────────────────────────

describe("resolveJobSignature (CLI 시그니처 해석)", () => {
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

  it("kind=taskforce → taskforce (signatureCli 무관)", () => {
    expect(resolveJobSignature(makeJob({ kind: "taskforce" }))).toBe("taskforce");
  });

  it.each([["claude"], ["codex"], ["opencode-go"], ["cursor"]] as const)(
    "signatureCli=%s → %s",
    (cli) => {
      expect(resolveJobSignature(makeJob({ signatureCli: cli }))).toBe(cli);
    }
  );

  it("signatureCli가 알 수 없는 값 → undefined", () => {
    expect(resolveJobSignature(makeJob({ signatureCli: "unknown-cli" }))).toBeUndefined();
  });

  it("signatureCli 없음 → undefined", () => {
    expect(resolveJobSignature(makeJob({}))).toBeUndefined();
  });
});

// ── resolveCarrierCaptain 유닛 테스트 ────────────────────────────────────────

describe("resolveCarrierCaptain (캡틴 해석)", () => {
  it.each([["nimitz"], ["kirov"], ["genesis"], ["ohio"], ["sentinel"], ["vanguard"], ["tempest"], ["chronicle"]] as const)(
    "로스터 캡틴 %s → %s",
    (id) => {
      expect(resolveCarrierCaptain(id)).toBe(id);
    }
  );

  it("로스터 외 id → undefined", () => {
    expect(resolveCarrierCaptain("unknown-carrier")).toBeUndefined();
  });

  it("undefined → undefined", () => {
    expect(resolveCarrierCaptain(undefined)).toBeUndefined();
  });
});

// ── applyEvent 트랙 lastEventId 스탬프(접힘 테일 트랙 recency 근거) ─────────────

describe("applyEvent (트랙 lastEventId 스탬프)", () => {
  it("track 이벤트는 해당 트랙에 observed.id를 기록하고 최신 이벤트로 갱신한다", () => {
    let job = createEmptyJob("t1", "j1", 1000);
    job = applyEvent(job, { id: 5, tenantId: "t1", type: "track:text", at: 1001, event: { trackId: "a", text: "hi" } });
    expect(job.tracks.a?.lastEventId).toBe(5);
    job = applyEvent(job, { id: 9, tenantId: "t1", type: "track:text", at: 1002, event: { trackId: "a", text: "!" } });
    expect(job.tracks.a?.lastEventId).toBe(9);
  });

  it("서로 다른 트랙은 각자의 최신 이벤트 id를 갖는다", () => {
    let job = createEmptyJob("t1", "j1", 1000);
    job = applyEvent(job, { id: 3, tenantId: "t1", type: "track:text", at: 1001, event: { trackId: "a", text: "a1" } });
    job = applyEvent(job, { id: 7, tenantId: "t1", type: "track:text", at: 1002, event: { trackId: "b", text: "b1" } });
    expect(job.tracks.a?.lastEventId).toBe(3);
    expect(job.tracks.b?.lastEventId).toBe(7);
  });

});
