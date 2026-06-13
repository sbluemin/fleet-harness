import { describe, expect, it } from "vitest";

import { createGatewayObservabilityStore } from "../src/observability-store.js";

describe("gateway observability store", () => {
  it("keeps job snapshots after tenant event truncation", () => {
    let now = 1;
    const store = createGatewayObservabilityStore({ now: () => now++ });

    store.append("tenant", { type: "job:registered", jobId: "job-1", tracks: [] });
    // noise는 잡 수 한도(200)에 걸리지 않도록 소수 잡에 분산시킨다 — 검증 대상은 이벤트 잘림이다.
    for (let index = 0; index < 1_005; index += 1) {
      store.append("tenant", { type: "track:status", jobId: `noise-${index % 50}`, trackId: "track", status: "streaming" });
    }

    const jobs = store.listJobs("tenant");
    expect(store.listEvents("tenant")).toHaveLength(1_000);
    expect(store.getTruncation("tenant")).toMatchObject({ droppedCount: 6, droppedBeforeId: 7 });
    expect(jobs.some((job) => job.jobId === "job-1")).toBe(true);
  });

  it("caps each job snapshot to the latest 200 events", () => {
    let now = 1;
    const store = createGatewayObservabilityStore({ now: () => now++ });

    for (let index = 0; index < 201; index += 1) {
      store.append("tenant", { type: "track:status", jobId: "job-1", trackId: "track", status: `step-${index}` });
    }

    const [job] = store.listJobs("tenant");
    expect(job.events).toHaveLength(200);
    expect(job.events[0].id).toBe(2);
    expect(job.events.at(-1)?.id).toBe(201);
  });

  it("prunes finalized job snapshots to the latest 100 while keeping active jobs", () => {
    let now = 1;
    const store = createGatewayObservabilityStore({ now: () => now++ });

    store.append("tenant", { type: "job:registered", jobId: "active-job", tracks: [] });
    for (let index = 0; index < 105; index += 1) {
      const jobId = `done-${index}`;
      store.append("tenant", { type: "job:registered", jobId, tracks: [] });
      store.append("tenant", { type: "job:finalized", jobId, status: "done", summary: "complete" });
    }

    const jobIds = store.listJobs("tenant").map((job) => job.jobId);
    expect(jobIds).toContain("active-job");
    expect(jobIds).toContain("done-104");
    expect(jobIds).not.toContain("done-0");
    expect(jobIds.filter((jobId) => jobId.startsWith("done-"))).toHaveLength(100);
  });

  it("retains text-bearing event payloads with original length metadata", () => {
    const store = createGatewayObservabilityStore({ now: () => 1 });

    store.append("tenant", { type: "track:text", jobId: "job", trackId: "track", text: "carrier output" });
    store.append("tenant", { type: "track:thought", jobId: "job", trackId: "track", text: "carrier thought" });
    store.append("tenant", {
      type: "track:finalized",
      jobId: "job",
      trackId: "track",
      status: "done",
      fallbackText: "fallback",
      fallbackThought: "thinking",
    });

    const [job] = store.listJobs("tenant");
    expect(job.events[0].event).toMatchObject({ type: "track:text", text: "carrier output", textLength: 14 });
    expect(job.events[1].event).toMatchObject({ type: "track:thought", text: "carrier thought", textLength: 15 });
    expect(job.events[2].event).toMatchObject({
      type: "track:finalized",
      fallbackText: "fallback",
      fallbackTextLength: 8,
      fallbackThought: "thinking",
      fallbackThoughtLength: 8,
    });
  });

  it("clamps retained text to the per-event cap while reporting original length", () => {
    const store = createGatewayObservabilityStore({ now: () => 1 });
    const longText = "a".repeat(10_000);

    store.append("tenant", { type: "track:text", jobId: "job", trackId: "track", text: longText });
    store.append("tenant", {
      type: "track:finalized",
      jobId: "job",
      trackId: "track",
      status: "done",
      fallbackText: longText,
      fallbackThought: longText,
    });

    const [job] = store.listJobs("tenant");
    const textEvent = job.events[0].event as Record<string, unknown>;
    const finalizedEvent = job.events[1].event as Record<string, unknown>;
    expect((textEvent.text as string).length).toBe(8_192);
    expect(textEvent.textLength).toBe(10_000);
    expect((finalizedEvent.fallbackText as string).length).toBe(8_192);
    expect(finalizedEvent.fallbackTextLength).toBe(10_000);
    expect((finalizedEvent.fallbackThought as string).length).toBe(8_192);
    expect(finalizedEvent.fallbackThoughtLength).toBe(10_000);
  });

  it("prunes the oldest jobs past the per-tenant job cap even when finalize events never arrive", () => {
    let tick = 0;
    const store = createGatewayObservabilityStore({ now: () => ++tick });
    for (let i = 0; i < 230; i += 1) {
      store.append("tenant", { type: "track:text", jobId: `job-${i}`, trackId: "track", text: "x" });
    }

    const jobs = store.listJobs("tenant");
    expect(jobs).toHaveLength(200);
    expect(jobs.some((job) => job.jobId === "job-0")).toBe(false);
    expect(jobs.some((job) => job.jobId === "job-229")).toBe(true);
  });

  it("removes a released tenant's observability state", () => {
    const store = createGatewayObservabilityStore({ now: () => 1 });
    store.append("tenant", { type: "track:text", jobId: "job", trackId: "track", text: "x" });

    store.removeTenant("tenant");

    expect(store.listEvents("tenant")).toHaveLength(0);
    expect(store.listJobs("tenant")).toHaveLength(0);
    expect(store.getTruncation("tenant")).toEqual({ droppedCount: 0 });
  });
});
