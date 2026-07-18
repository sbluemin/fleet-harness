import { describe, expect, it } from "vitest";

import { applyEvent, createEmptyJob, reduceSnapshotJob } from "../client/agent/reduce.js";

import type { ObservedEvent } from "../client/agent/types.js";

function makeEvent(id: number, type: string, event: Record<string, unknown>, jobId = "job-1"): ObservedEvent {
  return { id, tenantId: "tenant-1", jobId, type, at: 1_000 + id, event: { type, jobId, ...event } };
}

describe("agent reducer streaming invariants", () => {
  it("applies text and thought frames as deltas while latestLine remains output-only", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(1, "track:text", { trackId: "t1", text: "hello" }));
    job = applyEvent(job, makeEvent(2, "track:text", { trackId: "t1", text: " world" }));
    const latestOutputLine = job.tracks.t1?.latestLine;
    job = applyEvent(job, makeEvent(3, "track:thought", { trackId: "t1", text: "think" }));
    job = applyEvent(job, makeEvent(4, "track:thought", { trackId: "t1", text: " twice" }));

    expect(job.tracks.t1?.text).toBe("hello world");
    expect(job.tracks.t1?.thought).toBe("think twice");
    expect(job.tracks.t1?.latestLine).toBe(latestOutputLine);
  });

  it("does not create latestLine from thought-only deltas but updates it for text", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(1, "track:thought", { trackId: "t1", text: "private reasoning" }));
    expect(job.tracks.t1?.latestLine).toBeUndefined();

    job = applyEvent(job, makeEvent(2, "track:text", { trackId: "t1", text: "public output" }));
    expect(job.tracks.t1?.latestLine).toBe("public output");
  });

  it("ignores non-advancing observed ids across resync overlap", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(7, "track:text", { trackId: "t1", text: "once" }));
    const replayed = applyEvent(job, makeEvent(7, "track:text", { trackId: "t1", text: " replay" }));
    const older = applyEvent(job, makeEvent(6, "track:text", { trackId: "t1", text: " older" }));

    expect(replayed).toBe(job);
    expect(older).toBe(job);
    expect(job.tracks.t1?.text).toBe("once");
  });

  it("rebuilds snapshots through the same applyEvent reducer as live SSE", () => {
    const events = [
      makeEvent(1, "job:registered", { label: "Sweep", tracks: [{ trackId: "t1", displayName: "Codex" }] }),
      makeEvent(2, "track:text", { trackId: "t1", text: "a" }),
      makeEvent(3, "track:text", { trackId: "t1", text: "b" }),
      makeEvent(4, "track:finalized", { trackId: "t1", status: "done" }),
      makeEvent(5, "job:finalized", { status: "done", summary: "ok" }),
    ] as const;
    const snapshotJob = reduceSnapshotJob("tenant-1", { jobId: "job-1", status: "done", updatedAt: 1_005, events });
    const liveJob = events.reduce((job, event) => applyEvent(job, event), createEmptyJob("tenant-1", "job-1", 1_000));

    expect(snapshotJob).toEqual(liveJob);
  });

  it("preserves the first valid job request across live and replay Task Force track begins", () => {
    const request = {
      blocks: [{ tag: "objective", hint: "Goal", required: true, present: true, body: "  /tmp/a\nsk-live\n<script>literal</script>  " }],
      additional: "<unknown>&outside",
    };
    const events = [
      makeEvent(1, "track:begin", { trackId: "carrier-a", request }),
      makeEvent(2, "track:begin", { trackId: "carrier-b", request: { blocks: [], additional: "must not replace" } }),
      makeEvent(3, "track:text", { trackId: "carrier-a", text: "Activity remains a delta" }),
    ] as const;
    const replay = reduceSnapshotJob("tenant-1", { jobId: "job-1", status: "active", updatedAt: 1_003, events });
    const live = events.reduce((job, event) => applyEvent(job, event), createEmptyJob("tenant-1", "job-1", 1_000));

    expect(replay).toEqual(live);
    expect(live.request).toEqual(request);
    expect(live.tracks["carrier-a"]?.text).toBe("Activity remains a delta");
    expect(live.tracks["carrier-a"]?.sentTextLength).toBe("Activity remains a delta".length);
  });

  it("seeds a valid snapshot request before replay and rejects malformed legacy snapshot data", () => {
    const request = {
      blocks: [{ tag: "objective", hint: "Goal", required: true, present: true, body: " exact <unknown> & <script>literal</script> " }],
      additional: "outside",
    };
    const snapshot = { jobId: "job-1", status: "active", updatedAt: 1_002, request, events: [
      makeEvent(2, "track:text", { trackId: "carrier-b", text: "Activity remains a delta" }),
    ] } as const;
    expect(reduceSnapshotJob("tenant-1", snapshot).request).toEqual(request);

    const malformed = { ...snapshot, request: { blocks: [null], additional: "outside" } } as unknown as typeof snapshot;
    expect(reduceSnapshotJob("tenant-1", malformed).request).toBeUndefined();
  });

  it("ignores malformed or legacy request payloads without adding request token usage", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(1, "track:begin", { trackId: "t1" }));
    job = applyEvent(job, makeEvent(2, "track:begin", { trackId: "t2", request: { blocks: [null], additional: "bad" } }));
    job = applyEvent(job, makeEvent(3, "track:begin", { trackId: "t3", request: { blocks: [], additional: "valid second" } }));

    expect(job.request).toEqual({ blocks: [], additional: "valid second" });
    expect(job.tracks.t1?.sentTextLength).toBe(0);
    expect(job.tracks.t2?.sentTextLength).toBe(0);
    expect(job.tracks.t1?.sentThoughtLength).toBe(0);
  });

  it("tracks sentTextLength separately from retained text", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(1, "track:text", { trackId: "t1", text: "tail", textLength: 12_000 }));

    expect(job.tracks.t1?.text).toBe("tail");
    expect(job.tracks.t1?.sentTextLength).toBe(12_000);
  });

  it("keeps longer streamed text instead of shorter final fallback", () => {
    let job = createEmptyJob("tenant-1", "job-1", 1_000);
    job = applyEvent(job, makeEvent(1, "track:text", { trackId: "t1", text: "full streamed body" }));
    job = applyEvent(job, makeEvent(2, "track:finalized", { trackId: "t1", status: "done", fallbackText: "short" }));

    expect(job.tracks.t1?.text).toBe("full streamed body");
  });
});
