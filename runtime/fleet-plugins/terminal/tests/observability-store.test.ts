import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { reduceSnapshotJob } from "../client/agent/reduce.js";
import { createConsoleObservabilityStore } from "../server/agent-api/observability-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent observability DTO boundary", () => {
  it("does not expose cwd, provider session, transcript, or token material in browser session DTOs", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-store-"));
    tempDirs.push(cwd);
    const store = createConsoleObservabilityStore({
      canonicalizeTheaterPath: (value) => fs.realpathSync.native(value),
      workspaceHash: () => "theater-a",
    });

    const session = store.injectDormantOperation({
      sessionId: "session-a",
      theaterId: "theater-a",
      cwd,
      cliId: "claude",
      cliLabel: "Claude",
      createdAt: 1_000,
      providerSession: {
        provider: "claude",
        sessionId: "provider-session-secret",
        transcriptPath: "/secret/transcript.jsonl",
        source: "startup",
        capturedAt: "2026-06-16T00:00:00.000Z",
      },
    });
    const serialized = JSON.stringify({ session, sessions: store.listTerminalSessions() });

    expect(session.resumeAvailable).toBe(true);
    expect(serialized).not.toContain(cwd);
    expect(serialized).not.toContain("provider-session-secret");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("providerSession");
    expect(serialized).not.toContain("token");
  });

  it("clears the in-memory provider session for a fresh start and ignores unknown sessions", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-store-"));
    tempDirs.push(cwd);
    const store = createConsoleObservabilityStore({
      canonicalizeTheaterPath: (value) => fs.realpathSync.native(value),
      workspaceHash: () => "theater-a",
    });
    store.injectDormantOperation({
      sessionId: "session-a",
      theaterId: "theater-a",
      cwd,
      cliId: "claude",
      cliLabel: "Claude",
      createdAt: 1_000,
      providerSession: {
        provider: "claude",
        sessionId: "provider-session-secret",
        transcriptPath: "/secret/transcript.jsonl",
        source: "startup",
        capturedAt: "2026-06-16T00:00:00.000Z",
      },
    });

    const cleared = store.clearTerminalSessionProviderSession("session-a");

    expect(cleared).not.toBeNull();
    expect(cleared?.resumeAvailable).toBe(false);
    expect(JSON.stringify(store.listTerminalSessions())).not.toContain("provider-session-secret");
    expect(store.clearTerminalSessionProviderSession("missing")).toBeNull();
  });

  it("sanitizes carrier stream events before observer snapshots and SSE frames", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-events-"));
    tempDirs.push(cwd);
    const store = createConsoleObservabilityStore({
      canonicalizeTheaterPath: (value) => fs.realpathSync.native(value),
      workspaceHash: () => "theater-a",
    });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd, cliId: "claude", createdAt: 1_000 });
    store.registerTerminalRuntimeSession({ sessionId: "session-a", label: "Claude", mcpToolCount: 3 });

    const liveFrames: unknown[] = [];
    store.subscribeAll((event) => liveFrames.push(event));
    store.appendTerminalRuntimeEvent("session-a", {
      type: "job:finalized",
      jobId: "job-a",
      status: "done",
      summary: "ok",
      systemReminder: "secret reminder",
      providerSession: "provider-session-secret",
      transcriptPath: "/secret/transcript.jsonl",
      ticket: "terminal-ticket-secret",
      token: "mcp-token-secret",
      prompt: "private prompt",
    }, 2_000);
    const serialized = JSON.stringify({ jobs: store.listJobs("session-a"), events: store.listEvents("session-a"), liveFrames });

    expect(serialized).toContain("job-a");
    expect(serialized).not.toContain("secret reminder");
    expect(serialized).not.toContain("provider-session-secret");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("terminal-ticket-secret");
    expect(serialized).not.toContain("mcp-token-secret");
    expect(serialized).not.toContain("private prompt");
  });

  it("preserves only declared request fields while redacting paths in snapshots and subscribed frames", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-request-"));
    tempDirs.push(cwd);
    const store = createConsoleObservabilityStore({ workspaceHash: () => "theater-a" });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd, createdAt: 1_000 });
    store.registerTerminalRuntimeSession({ sessionId: "session-a", label: "Claude", mcpToolCount: 0 });
    const liveFrames: unknown[] = [];
    store.subscribeAll((event) => liveFrames.push(event));
    const body = " \n/path/with spaces\ntoken-like=sk_live_123\n<unknown>&<script>x</script>\n";
    const observedBody = " \n[redacted path] spaces\ntoken-like=sk_live_123\n<unknown>&<script>x</script>\n";
    const additional = "outside <unknown> & <script>literal</script>";
    store.appendTerminalRuntimeEvent("session-a", {
      type: "track:begin",
      jobId: "job-a",
      trackId: "track-a",
      request: {
        blocks: [{ tag: "objective", hint: "Goal", required: true, present: true, body, providerSession: "ignored" }],
        additional,
        ticket: "ignored",
      },
      providerSession: "provider-session-secret",
      token: "mcp-token-secret",
      prompt: "private prompt",
    }, 2_000);

    const events = store.listEvents("session-a");
    const serialized = JSON.stringify({ jobs: store.listJobs("session-a"), events, liveFrames });
    expect(events[0]?.event.request).toEqual({
      blocks: [{ tag: "objective", hint: "Goal", required: true, present: true, body: observedBody }],
      additional,
    });
    expect((liveFrames[0] as { event: Record<string, unknown> }).event.request).toEqual(events[0]?.event.request);
    expect(serialized).not.toContain("provider-session-secret");
    expect(serialized).not.toContain("mcp-token-secret");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("\"ticket\"");
  });

  it("redacts filesystem paths without changing ordinary slash text or producer input", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-request-paths-"));
    tempDirs.push(cwd);
    const store = createConsoleObservabilityStore({ workspaceHash: () => "theater-a" });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd, createdAt: 1_000 });
    store.registerTerminalRuntimeSession({ sessionId: "session-a", label: "Claude", mcpToolCount: 0 });
    const liveFrames: unknown[] = [];
    store.subscribeAll((event) => liveFrames.push(event));
    const body = [
      "POSIX=/Users/alice/project/file.ts",
      "drive=C:\\Users\\Alice\\project\\file.ts",
      "forward=D:/work/project/file.ts",
      "home=~/repo/file.ts user=~alice/repo/file.ts",
      "winhome=~\\repo\\file.ts winuser=~alice\\repo\\file.ts",
      "slashunc=//server/share/private.txt",
      "angle=<file:///Users/alice/angle> <C:\\Users\\Alice\\angle> <~/angle> <~alice\\angle> <\\\\server\\share\\angle> <\\Users\\Alice\\angle> rooted=\\Users\\Alice\\repo",
      "single=\\alpha keep=~ ~alice https://example.com/~alice/repo <https://example.com/a/b> I/O HTTP/2 <unknown>literal</unknown>",
    ].join("\n");
    const secondBody = "UNC=\\\\server\\share\\folder\\file.txt file=file:///Users/alice/project/file.ts XML=<root>/etc/fleet</root>";
    const additional = "before /opt/fleet/bin after; wrapped=(/srv/app), label:/var/lib/fleet homes=~/repo ~alice/repo ~\\repo ~alice\\repo angles=<file:///opt/angle> <D:\\work\\angle> <~\\angle> rooted=\\Windows\\System32 single=\\alpha slashunc=//server/share/additional.txt remote=https://example.org/x/y file://server/share/private.txt\n";
    const requestPreview = "<objective>Inspect /Users/alice/app C:\\Users\\Alice\\app \\\\server\\share\\app //server/share/preview.txt file:///Users/alice/app ~/repo/file.ts ~alice/repo/file.ts ~\\repo\\file.ts ~alice\\repo\\file.ts angles=<file:///Users/alice/autolink> <C:\\Users\\Alice\\autolink> <~/autolink> <~alice\\autolink> <\\Users\\Alice\\autolink> single=\\alpha; keep ~ ~alice https://example.com/~alice/repo <https://example.com/a/b> I/O HTTP/2</objective>";
    const request = {
      blocks: [
        { tag: "objective", hint: "Goal", required: true, present: true, body },
        { tag: "context", hint: "Context", required: false, present: true, body: secondBody },
      ],
      additional,
    };
    const producerInput = {
      type: "track:begin",
      jobId: "job-a",
      trackId: "track-a",
      request,
      requestPreview,
    };
    const originalProducerInput = structuredClone(producerInput);

    store.appendTerminalRuntimeEvent("session-a", producerInput, 2_000);

    const observedRequest = {
      blocks: [
        {
          tag: "objective",
          hint: "Goal",
          required: true,
          present: true,
          body: [
            "POSIX=[redacted path]",
            "drive=[redacted path]",
            "forward=[redacted path]",
            "home=[redacted path] user=[redacted path]",
            "winhome=[redacted path] winuser=[redacted path]",
            "slashunc=[redacted path]",
            "angle=<[redacted path]> <[redacted path]> <[redacted path]> <[redacted path]> <[redacted path]> <[redacted path]> rooted=[redacted path]",
            "single=[redacted path] keep=~ ~alice https://example.com/~alice/repo <https://example.com/a/b> I/O HTTP/2 <unknown>literal</unknown>",
          ].join("\n"),
        },
        { tag: "context", hint: "Context", required: false, present: true, body: "UNC=[redacted path] file=[redacted path] XML=<root>[redacted path]</root>" },
      ],
      additional: "before [redacted path] after; wrapped=([redacted path]), label:[redacted path] homes=[redacted path] [redacted path] [redacted path] [redacted path] angles=<[redacted path]> <[redacted path]> <[redacted path]> rooted=[redacted path] single=[redacted path] slashunc=[redacted path] remote=https://example.org/x/y [redacted path]\n",
    };
    const events = store.listEvents("session-a");
    const jobs = store.listJobs("session-a");
    const serialized = JSON.stringify({ jobs, events, liveFrames });
    const observedPreview = "<objective>Inspect [redacted path] [redacted path] [redacted path] [redacted path] [redacted path] [redacted path] [redacted path] [redacted path] [redacted path] angles=<[redacted path]> <[redacted path]> <[redacted path]> <[redacted path]> <[redacted path]> single=[redacted path]; keep ~ ~alice https://example.com/~alice/repo <https://example.com/a/b> I/O HTTP/2</objective>";
    expect(producerInput).toEqual(originalProducerInput);
    expect(events[0]?.event.request).toEqual(observedRequest);
    expect(events[0]?.event.requestPreview).toBe(observedPreview);
    expect(jobs[0]?.request).toEqual(observedRequest);
    expect(jobs[0]?.events[0]?.event.requestPreview).toBe(observedPreview);
    expect((liveFrames[0] as { event: Record<string, unknown> }).event.request).toEqual(observedRequest);
    expect((liveFrames[0] as { event: Record<string, unknown> }).event.requestPreview).toBe(observedPreview);
    for (const rawPath of [
      "/Users/alice/project/file.ts",
      "C:\\Users\\Alice\\project\\file.ts",
      "D:/work/project/file.ts",
      "\\\\server\\share\\folder\\file.txt",
      "file:///Users/alice/project/file.ts",
      "/etc/fleet",
      "/opt/fleet/bin",
      "/srv/app",
      "/var/lib/fleet",
      "~/repo/file.ts",
      "~alice/repo/file.ts",
      "~\\repo\\file.ts",
      "~alice\\repo\\file.ts",
      "/Users/alice/angle",
      "C:\\Users\\Alice\\angle",
      "\\Users\\Alice\\repo",
      "\\alpha",
      "//server/share/private.txt",
      "//server/share/additional.txt",
      "//server/share/preview.txt",
      "file:///Users/alice/autolink",
      "file://server/share/private.txt",
    ]) expect(serialized).not.toContain(rawPath);
  });

  it("narrows malformed request DTOs without manufacturing request content", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-request-invalid-"));
    tempDirs.push(cwd);
    const store = createConsoleObservabilityStore({ workspaceHash: () => "theater-a" });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd, createdAt: 1_000 });
    store.registerTerminalRuntimeSession({ sessionId: "session-a", label: "Claude", mcpToolCount: 0 });
    store.appendTerminalRuntimeEvent("session-a", {
      type: "track:begin", jobId: "job-a", trackId: "track-a", request: { blocks: "not-an-array", additional: 4 },
    });

    const event = store.listEvents("session-a")[0];
    expect(event?.event).not.toHaveProperty("request");
  });

  it("retains the first normalized request in a job snapshot after its begin event expires", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-request-retention-"));
    tempDirs.push(cwd);
    const store = createConsoleObservabilityStore({ workspaceHash: () => "theater-a" });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd, createdAt: 1_000 });
    store.registerTerminalRuntimeSession({ sessionId: "session-a", label: "Claude", mcpToolCount: 0 });
    const request = {
      blocks: [{ tag: "objective", hint: "Goal", required: true, present: true, body: "  /tmp/fake\nsk-live\n<script>literal</script>  " }],
      additional: "<unknown>&outside",
    };
    const malformed = store.appendTerminalRuntimeEvent("session-a", {
      type: "track:begin", jobId: "job-a", trackId: "track-a", request: { blocks: [null], additional: "must not poison" },
    }, 1_999);
    expect(malformed?.event).not.toHaveProperty("request");
    store.appendTerminalRuntimeEvent("session-a", { type: "track:begin", jobId: "job-a", trackId: "track-a", request }, 2_000);
    for (let index = 0; index < 200; index++) {
      store.appendTerminalRuntimeEvent("session-a", { type: "track:text", jobId: "job-a", trackId: "track-a", text: String(index) }, 2_001 + index);
    }

    const snapshot = store.listJobs("session-a")[0];
    const observedRequest = {
      ...request,
      blocks: [{ ...request.blocks[0], body: "  [redacted path]\nsk-live\n<script>literal</script>  " }],
    };
    expect(snapshot?.events).toHaveLength(200);
    expect(snapshot?.events.some((event) => event.type === "track:begin")).toBe(false);
    expect(snapshot?.request).toEqual(observedRequest);
    expect(reduceSnapshotJob("session-a", snapshot!).request).toEqual(observedRequest);
  });

  it("assigns globally monotonic observed ids across terminal sessions", () => {
    const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-a-"));
    const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-b-"));
    tempDirs.push(cwdA, cwdB);
    const store = createConsoleObservabilityStore({
      canonicalizeTheaterPath: (value) => fs.realpathSync.native(value),
      workspaceHash: (canonical) => path.basename(canonical),
    });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: cwdA, createdAt: 1_000 });
    store.createPendingTerminalSession({ sessionId: "session-b", cwd: cwdB, createdAt: 1_000 });
    store.registerTerminalRuntimeSession({ sessionId: "session-a", label: "A", mcpToolCount: 0 });
    store.registerTerminalRuntimeSession({ sessionId: "session-b", label: "B", mcpToolCount: 0 });

    const a = store.appendTerminalRuntimeEvent("session-a", { type: "track:text", jobId: "job-a", trackId: "t1", text: "a" });
    const b = store.appendTerminalRuntimeEvent("session-b", { type: "track:text", jobId: "job-b", trackId: "t1", text: "b" });

    expect(a?.id).toBe(1);
    expect(b?.id).toBe(2);
  });
});

describe("agent operation title precedence", () => {
  function createStore() {
    return createConsoleObservabilityStore({ workspaceHash: () => "theater-a" });
  }

  function createSession(store: ReturnType<typeof createStore>, sessionId = "session-a") {
    store.createPendingTerminalSession({ sessionId, cwd: "/workspace/project", createdAt: 1_000 });
  }

  it("applies default, auto, provider, refreshed provider, then user precedence", () => {
    const store = createStore();
    createSession(store);

    expect(store.autoNameTerminalSession("session-a", "Prompt title")).toMatchObject({ renamed: true, session: { label: "Prompt title", labelSource: "auto" } });
    expect(store.applyTerminalSessionProviderIdentity("session-a", "Provider title")).toMatchObject({ renamed: true, session: { label: "Provider title" } });
    expect(store.getDurableOperation("session-a")).toMatchObject({ providerTitle: { source: "provider" } });
    expect(store.applyTerminalSessionProviderIdentity("session-a", "Refreshed title")).toMatchObject({ renamed: true, session: { label: "Refreshed title" } });
    expect(store.renameTerminalSession("session-a", "Manual title")).toMatchObject({ label: "Manual title", labelSource: "user" });
    expect(store.applyTerminalSessionProviderIdentity("session-a", "Ignored provider title")).toMatchObject({ renamed: false, session: { label: "Manual title", labelSource: "user" } });
    expect(store.getDurableOperation("session-a")?.providerTitle).toBeUndefined();
  });

  it("protects conservatively interpreted legacy titles and refuses auto-name after provider identity", () => {
    const store = createStore();
    store.injectDormantOperation({ sessionId: "legacy", theaterId: "theater-a", cwd: "/workspace/project", label: "Legacy title", createdAt: 1_000 });
    expect(store.applyTerminalSessionProviderIdentity("legacy", "Provider title")).toMatchObject({ renamed: false, session: { label: "Legacy title" } });

    createSession(store);
    store.applyTerminalSessionProviderIdentity("session-a", "Provider title");
    expect(store.autoNameTerminalSession("session-a", "Prompt title")).toMatchObject({ renamed: false, session: { label: "Provider title" } });
  });

  it("clears user and provider provenance on empty rename, and ignores malformed or duplicate provider titles", () => {
    const store = createStore();
    createSession(store);
    expect(store.applyTerminalSessionProviderIdentity("session-a", "  Provider title  ")).toMatchObject({ renamed: true, session: { label: "Provider title" } });
    expect(store.applyTerminalSessionProviderIdentity("session-a", "Provider title")).toMatchObject({ renamed: false });
    expect(store.applyTerminalSessionProviderIdentity("session-a", "   ")).toMatchObject({ renamed: false });
    expect(store.renameTerminalSession("session-a", "")).toMatchObject({ label: undefined, labelSource: undefined });
    expect(store.getDurableOperation("session-a")?.providerTitle).toBeUndefined();

    expect(store.applyTerminalSessionProviderIdentity("session-a", `  ${"x".repeat(201)}  `)?.session.label).toBe("x".repeat(200));
  });

  it("rehydrates provider provenance without exposing it in browser session DTOs", () => {
    const store = createStore();
    const session = store.injectDormantOperation({
      sessionId: "session-a",
      theaterId: "theater-a",
      cwd: "/workspace/project",
      label: "Provider title",
      providerTitle: { source: "provider" },
      createdAt: 1_000,
    });

    expect(store.applyTerminalSessionProviderIdentity("session-a", "Refreshed title")).toMatchObject({ renamed: true, session: { label: "Refreshed title" } });
    expect(JSON.stringify(session)).not.toContain("providerTitle");
    expect(store.getDurableOperation("session-a")).toMatchObject({ label: "Refreshed title", providerTitle: { source: "provider" } });
  });
});
