import { describe, expect, it } from "vitest";
import { analysisReducer, initialAnalysisState } from "./analysis-state.js";

const catalog = { clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [{ id: "sonnet", label: "Sonnet", effortLevels: ["low", "high"], defaultEffort: "high" }] }] };
describe("analysisReducer", () => {
  it("locks its selection after first send and remains in component memory", () => {
    const selected = analysisReducer(initialAnalysisState, { type: "catalog", catalog });
    const locked = analysisReducer(selected, { type: "sending", started: true, text: "Review this" });
    expect(analysisReducer(locked, { type: "select-cli", cliId: "other" }).cliId).toBe("claude");
    expect(locked.started).toBe(true);
  });
  it("accumulates user and streaming analyst entries, then orders artifacts newest first", () => {
    const sent = analysisReducer(initialAnalysisState, { type: "sending", started: true, text: "Review this" });
    const streaming = analysisReducer(analysisReducer(sent, { type: "event", event: { type: "chunk", text: "First" } }), { type: "event", event: { type: "chunk", text: " reply" } });
    expect(streaming.entries).toEqual([{ role: "user", text: "Review this" }, { role: "analyst", text: "First reply" }]);
    const first = analysisReducer(streaming, { type: "event", event: { type: "artifact", artifact: { id: "a", title: "A", html: "<p>a</p>", createdAt: 1 } } });
    const next = analysisReducer(first, { type: "event", event: { type: "artifact", artifact: { id: "b", title: "B", html: "<p>b</p>", createdAt: 2 } } });
    expect(next.artifacts.map((artifact) => artifact.id)).toEqual(["b", "a"]);
    expect(analysisReducer(next, { type: "clear-artifacts" }).artifacts).toEqual([]);
  });
});
