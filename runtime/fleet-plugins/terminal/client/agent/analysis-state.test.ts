import { describe, expect, it } from "vitest";
import { analysisReducer, initialAnalysisState } from "./analysis-state.js";

const catalog = { clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [{ id: "sonnet", label: "Sonnet", effortLevels: ["low", "high"], defaultEffort: "high" }] }] };

describe("shared analysis store reducer", () => {
  it("locks its selection after first send and tracks run timing in memory", () => {
    const selected = analysisReducer(initialAnalysisState, { type: "catalog", catalog });
    const locked = analysisReducer(selected, { type: "sending", started: true, text: "Review this", now: 1_000 });
    expect(analysisReducer(locked, { type: "select-cli", cliId: "other" }).cliId).toBe("claude");
    expect(locked).toMatchObject({ started: true, busy: true, phase: "starting", runStartedAt: 1_000, runEndedAt: null });
  });

  it("prefers Claude Sonnet at medium and restores that selection on reset", () => {
    const preferredCatalog = { clis: [
      { cliId: "codex", label: "Codex", available: true, defaultModel: "gpt", models: [{ id: "gpt", label: "GPT", effortLevels: ["high"], defaultEffort: "high" }] },
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
      entries: [],
      artifacts: [],
      error: null,
    });
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
    expect(streamed).toMatchObject({ phase: "writing", latestActivity: { kind: "writing" }, entries: [{ role: "user", text: "Review this" }, { role: "analyst", text: "First reply" }] });

    const complete = analysisReducer(streamed, { type: "event", event: { type: "complete" }, now: 2_000 });
    expect(complete).toMatchObject({ busy: false, phase: "complete", runEndedAt: 2_000 });
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
