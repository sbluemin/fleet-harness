import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseAnalysisCatalog, parseAnalysisEvent } from "./analysis-types.js";
describe("Session Analyst contract", () => {
  it("accepts the frozen catalog and event shapes", () => {
    expect(parseAnalysisCatalog({ clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [{ id: "sonnet", label: "Sonnet", effortLevels: ["low"], defaultEffort: "low" }] }] })?.clis[0]?.label).toBe("Claude");
    expect(parseAnalysisEvent({ type: "chunk", text: "English copy" })).toEqual({ type: "chunk", text: "English copy" });
  });
  it("rejects recursive sensitive payload keys", () => {
    expect(parseAnalysisEvent({ type: "chunk", text: "x", nested: { transcriptPath: "/private" } })).toBeNull();
  });
});
