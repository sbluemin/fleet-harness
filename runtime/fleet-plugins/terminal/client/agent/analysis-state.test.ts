import { describe, expect, it } from "vitest";
import { analysisReducer, initialAnalysisState, MAX_ANALYSIS_ARTIFACTS, splitAnalystLedger } from "./analysis-state.js";

const catalog = { clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [{ id: "sonnet", label: "Sonnet", effortLevels: ["low", "high"], defaultEffort: "high" }] }] };

describe("shared analysis store reducer", () => {
  it("locks its selection after first send and tracks run timing in memory", () => {
    const selected = analysisReducer(initialAnalysisState, { type: "catalog", catalog });
    const locked = analysisReducer(selected, { type: "sending", started: true, text: "Review this", now: 1_000 });
    expect(analysisReducer(locked, { type: "select-cli", cliId: "other" }).cliId).toBe("claude");
    expect(locked).toMatchObject({ started: true, busy: true, phase: "starting", runStartedAt: 1_000, runEndedAt: null });
  });

  it("exposes the reset selection lock and preserves it until explicitly released", () => {
    const selected = analysisReducer(initialAnalysisState, { type: "catalog", catalog });
    const locked = analysisReducer(selected, { type: "selection-lock", locked: true });
    expect(locked.selectionLocked).toBe(true);

    const reset = analysisReducer(locked, { type: "reset" });
    expect(reset.selectionLocked).toBe(true);
    expect(analysisReducer(reset, { type: "selection-lock", locked: false }).selectionLocked).toBe(false);
  });

  it("prefers Claude Sonnet at medium and restores that selection on reset", () => {
    const preferredCatalog = { clis: [
      { cliId: "cursor", label: "Cursor", available: true, defaultModel: "gpt", models: [{ id: "gpt", label: "GPT", effortLevels: ["high"], defaultEffort: "high" }] },
      { cliId: "claude", label: "Claude Code", available: true, defaultModel: "opus[1m]", models: [
        { id: "opus[1m]", label: "Claude Opus [1M]", effortLevels: ["high", "xhigh"], defaultEffort: "xhigh" },
        { id: "sonnet", label: "Claude Sonnet", effortLevels: ["low", "medium", "high"], defaultEffort: "medium" },
      ] },
    ] };
    const selected = analysisReducer(initialAnalysisState, { type: "catalog", catalog: preferredCatalog });
    expect(selected).toMatchObject({ cliId: "claude", model: "sonnet", effort: "medium" });

    const dirty = {
      ...selected,
      started: true,
      busy: true,
      phase: "writing" as const,
      draft: "Unsent question",
      queue: ["Queued question"],
      entries: [{ role: "user" as const, text: "Review this" }],
      artifacts: [{ id: "artifact", title: "Artifact", html: "<p>artifact</p>", createdAt: 1 }],
      error: "old error",
    };
    expect(analysisReducer(dirty, { type: "reset" })).toMatchObject({
      catalog: preferredCatalog,
      cliId: "claude",
      model: "sonnet",
      effort: "medium",
      started: false,
      busy: false,
      phase: "idle",
      draft: "",
      queue: [],
      entries: [],
      artifacts: [],
      error: null,
    });
  });

  it("hydrates persisted selection field by field and restores it on reset", () => {
    const hydrationCatalog = { clis: [
      { cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [
        { id: "sonnet", label: "Sonnet", effortLevels: ["low", "medium", "high"], defaultEffort: "medium" },
        { id: "opus", label: "Opus", effortLevels: ["high"], defaultEffort: "high" },
      ] },
      { cliId: "cursor", label: "Cursor", available: true, defaultModel: "gpt", models: [
        { id: "gpt", label: "GPT", effortLevels: [], defaultEffort: undefined },
      ] },
    ] };
    const hydrated = analysisReducer(initialAnalysisState, {
      type: "catalog",
      catalog: hydrationCatalog,
      selection: { cliId: "cursor", model: "removed", effort: "high" },
    });
    expect(hydrated).toMatchObject({ cliId: "cursor", model: "gpt", effort: "" });

    const reset = analysisReducer({ ...hydrated, started: true, entries: [{ role: "user", text: "Question" }] }, {
      type: "reset",
      selection: { cliId: "claude", model: "opus", effort: "high" },
    });
    expect(reset).toMatchObject({ cliId: "claude", model: "opus", effort: "high", started: false, entries: [] });
  });

  it("falls back within a valid persisted CLI when its model was removed", () => {
    const sharedModelCatalog = { clis: [
      { cliId: "claude", label: "Claude", available: false, defaultModel: "sonnet", models: [
        { id: "sonnet", label: "Sonnet", effortLevels: ["medium"], defaultEffort: "medium" },
      ] },
      { cliId: "claude", label: "Claude", available: true, defaultModel: "shared", models: [
        { id: "shared", label: "Shared Codex", effortLevels: ["high"], defaultEffort: "high" },
      ] },
      { cliId: "cursor", label: "Cursor", available: true, defaultModel: "auto", models: [
        { id: "shared", label: "Shared Cursor", effortLevels: ["high"], defaultEffort: "high" },
        { id: "auto", label: "Auto", effortLevels: ["low", "medium"], defaultEffort: "low" },
      ] },
    ] };
    const hydrated = analysisReducer(initialAnalysisState, {
      type: "catalog",
      catalog: sharedModelCatalog,
      selection: { cliId: "cursor", model: "removed", effort: "high" },
    });

    expect(hydrated).toMatchObject({ cliId: "cursor", model: "auto", effort: "medium" });
  });

  it("persists drafts and supports cancellable FIFO queue state", () => {
    const drafted = analysisReducer(initialAnalysisState, { type: "set-draft", draft: "Keep this question" });
    const first = analysisReducer(drafted, { type: "queue-push", text: "First" });
    const second = analysisReducer(first, { type: "queue-push", text: "Second" });
    expect(second).toMatchObject({ draft: "Keep this question", queue: ["First", "Second"] });

    const cancelled = analysisReducer(second, { type: "queue-cancel", index: 0 });
    expect(cancelled.queue).toEqual(["Second"]);
    expect(analysisReducer(cancelled, { type: "queue-clear" }).queue).toEqual([]);
  });

  it("clears queued questions on stop and error endings", () => {
    const queued = { ...initialAnalysisState, started: true, busy: true, queue: ["Do not fire"] };
    expect(analysisReducer(queued, { type: "stopped", now: 2_000 }).queue).toEqual([]);
    expect(analysisReducer(queued, { type: "error", message: "Failed", now: 2_000 }).queue).toEqual([]);
    expect(analysisReducer(queued, { type: "session-lost", now: 2_000 }).queue).toEqual([]);
    expect(analysisReducer(queued, { type: "start-failed", message: "Failed", now: 2_000 }).queue).toEqual([]);
  });

  it("advances activity only from observed events and never stores thought content", () => {
    const sent = analysisReducer(initialAnalysisState, { type: "sending", started: true, text: "Review this", now: 1_000 });
    const connected = analysisReducer(sent, { type: "event", event: { type: "connected" }, now: 1_010 });
    expect(connected).toMatchObject({ phase: "starting", latestActivity: { kind: "starting", connected: true } });

    const reasoning = analysisReducer(connected, { type: "event", event: { type: "thought", text: "private chain of thought" }, now: 1_020 });
    expect(reasoning).toMatchObject({ phase: "reasoning", latestActivity: { kind: "reasoning" } });
    expect(JSON.stringify(reasoning)).not.toContain("private chain of thought");

    const tooling = analysisReducer(reasoning, { type: "event", event: { type: "tool", title: "wiki_read", status: "running" }, now: 1_030 });
    expect(tooling).toMatchObject({ phase: "tool", latestActivity: { kind: "tool", title: "wiki_read", status: "running" } });

    const writing = analysisReducer(tooling, { type: "event", event: { type: "chunk", text: "First" }, now: 1_040 });
    const streamed = analysisReducer(writing, { type: "event", event: { type: "chunk", text: " reply" }, now: 1_050 });
    expect(streamed).toMatchObject({
      phase: "writing",
      latestActivity: { kind: "writing" },
      entries: [
        { role: "user", text: "Review this" },
        { role: "analyst", segments: [{ text: "", steps: [{ title: "wiki_read", status: "running" }] }, { text: "First reply", steps: [] }] },
      ],
    });

    const complete = analysisReducer(streamed, { type: "event", event: { type: "complete" }, now: 2_000 });
    expect(complete).toMatchObject({ busy: false, phase: "complete", runEndedAt: 2_000 });
  });

  it("opens a new segment after tools so process narration never merges into the answer", () => {
    const sent = analysisReducer(initialAnalysisState, { type: "sending", started: true, text: "Summarize", now: 1_000 });
    const narrated = analysisReducer(sent, { type: "event", event: { type: "chunk", text: "Reading the outline first." }, now: 1_010 });
    const tooled = analysisReducer(narrated, { type: "event", event: { type: "tool", title: "session_outline", status: "in_progress" }, now: 1_020 });
    const toolDone = analysisReducer(tooled, { type: "event", event: { type: "tool", title: "session_outline", status: "completed" }, now: 1_030 });
    const answered = analysisReducer(toolDone, { type: "event", event: { type: "chunk", text: "The session did X." }, now: 1_040 });

    const analyst = answered.entries.at(-1);
    if (analyst?.role !== "analyst") throw new Error("expected analyst entry");
    // 같은 구간 안의 같은 제목은 상태 갱신이다 — 스텝이 두 줄로 불어나지 않는다.
    expect(analyst.segments).toEqual([
      { text: "Reading the outline first.", steps: [{ title: "session_outline", status: "completed" }] },
      { text: "The session did X.", steps: [] },
    ]);
    // 원장 분리: 과정 = 도구가 붙은 구간, 답 = 도구가 뒤따르지 않은 꼬리 텍스트 구간.
    expect(splitAnalystLedger(analyst.segments)).toEqual({
      process: [{ text: "Reading the outline first.", steps: [{ title: "session_outline", status: "completed" }] }],
      answer: { text: "The session did X.", steps: [] },
    });
    // 꼬리 구간에 도구가 붙는 순간 답 후보는 과정으로 승격된다.
    const reopened = analysisReducer(answered, { type: "event", event: { type: "tool", title: "session_read", status: "pending" }, now: 1_050 });
    const reopenedAnalyst = reopened.entries.at(-1);
    if (reopenedAnalyst?.role !== "analyst") throw new Error("expected analyst entry");
    expect(splitAnalystLedger(reopenedAnalyst.segments).answer).toBeNull();
  });

  it("orders artifacts newest first and preserves conversation and artifacts when stopped", () => {
    const sent = analysisReducer(initialAnalysisState, { type: "sending", started: true, text: "Review this", now: 1_000 });
    const writing = analysisReducer(sent, { type: "event", event: { type: "chunk", text: "Answer" }, now: 1_010 });
    const first = analysisReducer(writing, { type: "event", event: { type: "artifact", artifact: { id: "a", title: "A", html: "<p>a</p>", createdAt: 1 } }, now: 1_020 });
    const next = analysisReducer(first, { type: "event", event: { type: "artifact", artifact: { id: "b", title: "B", html: "<p>b</p>", createdAt: 2 } }, now: 1_030 });
    const stopped = analysisReducer(next, { type: "stopped", now: 1_500 });
    expect(stopped).toMatchObject({ started: false, busy: false, phase: "stopped", runEndedAt: 1_500, entries: writing.entries, artifacts: next.artifacts, latestActivity: { kind: "writing" } });
    expect(stopped.artifacts.map((artifact) => artifact.id)).toEqual(["b", "a"]);
    expect(analysisReducer(stopped, { type: "clear-artifacts" }).artifacts).toEqual([]);
  });

  it("tracks publish_artifact authoring and transitions to a timed published artifact", () => {
    const sent = analysisReducer(initialAnalysisState, { type: "sending", started: true, text: "Publish this", now: 1_000 });
    const authoring = analysisReducer(sent, {
      type: "event",
      event: { type: "tool", title: "mcp__session_analyst__publish_artifact", status: "PENDING" },
      now: 2_000,
    });
    expect(authoring).toMatchObject({ artifactAuthoring: { startedAt: 2_000 }, artifactPublished: null });

    const stillAuthoring = analysisReducer(authoring, {
      type: "event",
      event: { type: "tool", title: "analyst__publish_artifact", status: "in_progress" },
      now: 3_000,
    });
    expect(stillAuthoring.artifactAuthoring).toEqual({ startedAt: 2_000 });

    const artifact = { id: "artifact", title: "Evidence", html: "<p>evidence</p>", createdAt: 1 };
    const published = analysisReducer(stillAuthoring, { type: "event", event: { type: "artifact", artifact }, now: 5_500 });
    expect(published).toMatchObject({
      artifactAuthoring: null,
      artifactPublished: { artifact, durationMs: 3_500 },
    });
  });

  it("ignores non-matching tools and clears authoring at run boundaries", () => {
    const baseline = { ...initialAnalysisState, artifactAuthoring: { startedAt: 1_000 } };
    const unrelated = analysisReducer(baseline, {
      type: "event",
      event: { type: "tool", title: "wiki_read", status: "pending" },
      now: 2_000,
    });
    expect(unrelated.artifactAuthoring).toEqual({ startedAt: 1_000 });

    const artifact = { id: "artifact", title: "Evidence", html: "<p>evidence</p>", createdAt: 1 };
    const published = { ...baseline, artifactPublished: { artifact, durationMs: 2_000 } };
    expect(analysisReducer(published, { type: "sending", started: false, text: "Again", now: 4_000 })).toMatchObject({ artifactAuthoring: null, artifactPublished: null });
    expect(analysisReducer(published, { type: "reset" })).toMatchObject({ artifactAuthoring: null, artifactPublished: null });
    expect(analysisReducer(published, { type: "stopped", now: 4_000 })).toMatchObject({ artifactAuthoring: null, artifactPublished: { artifact, durationMs: 2_000 } });
    expect(analysisReducer(published, { type: "error", message: "Failed", now: 4_000 })).toMatchObject({ artifactAuthoring: null, artifactPublished: { artifact, durationMs: 2_000 } });
  });

  it("returns a published card to authoring when the same turn republishes", () => {
    const artifact = { id: "artifact", title: "First", html: "<p>first</p>", createdAt: 1 };
    const published = { ...initialAnalysisState, artifactPublished: { artifact, durationMs: 2_000 } };
    const authoring = analysisReducer(published, {
      type: "event",
      event: { type: "tool", title: "publish_artifact", status: "in_progress" },
      now: 8_000,
    });
    expect(authoring).toMatchObject({ artifactAuthoring: { startedAt: 8_000 }, artifactPublished: null });
  });

  it("ends authoring when the turn completes without an artifact event", () => {
    const authoring = { ...initialAnalysisState, busy: true, artifactAuthoring: { startedAt: 1_000 } };
    const completed = analysisReducer(authoring, { type: "event", event: { type: "complete" }, now: 5_000 });
    expect(completed).toMatchObject({ phase: "complete", busy: false, artifactAuthoring: null, artifactPublished: null });
  });

  it("clears the published card together with cleared artifacts", () => {
    const artifact = { id: "artifact", title: "Evidence", html: "<p>evidence</p>", createdAt: 1 };
    const published = {
      ...initialAnalysisState,
      artifacts: [artifact],
      artifactPublished: { artifact, durationMs: 2_000 },
    };
    expect(analysisReducer(published, { type: "clear-artifacts" })).toMatchObject({ artifacts: [], artifactPublished: null });
  });

  it("keeps only the newest per-operation artifact working set", () => {
    let state = initialAnalysisState;
    for (let index = 0; index <= MAX_ANALYSIS_ARTIFACTS; index += 1) {
      state = analysisReducer(state, {
        type: "event",
        event: { type: "artifact", artifact: { id: `artifact-${index}`, title: `Artifact ${index}`, html: `<p>${index}</p>`, createdAt: index } },
        now: index,
      });
    }

    expect(state.artifacts).toHaveLength(MAX_ANALYSIS_ARTIFACTS);
    expect(state.artifacts[0]?.id).toBe(`artifact-${MAX_ANALYSIS_ARTIFACTS}`);
    expect(state.artifacts.at(-1)?.id).toBe("artifact-1");
    expect(state.artifacts.some((artifact) => artifact.id === "artifact-0")).toBe(false);
  });

  it("unlocks selection and shows restart guidance when the server session is lost", () => {
    const sent = analysisReducer(initialAnalysisState, { type: "sending", started: true, text: "Review this", now: 1_000 });
    const ended = analysisReducer(sent, { type: "session-lost", now: 2_000 });
    expect(ended).toMatchObject({
      started: false,
      busy: false,
      phase: "error",
      error: "Analysis session ended — send again to restart.",
    });
  });
});
