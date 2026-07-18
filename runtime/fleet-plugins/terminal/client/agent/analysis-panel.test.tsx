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
  it("keeps the approved copy in separate companion panels", () => {
    const chat = readFileSync(new URL("./analysis-chat-panel.tsx", import.meta.url), "utf8");
    const artifacts = readFileSync(new URL("./analysis-artifacts-panel.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("./analysis.css", import.meta.url), "utf8");
    expect(chat).toContain("Walk me through how this session unfolded");
    expect(artifacts).toContain("SANDBOXED HTML");
    expect(artifacts).toContain("Artifacts the analyst publishes will appear here.");
    expect(css).not.toContain("agent-stream-host--analyst");
  });
  it("registers the two companion chips on the Agent operation kind", () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const companions = [...source.matchAll(/\{ id: "([^"]+)", title: "([^"]+)"/g)].map((match) => ({ id: match[1], title: match[2] }));
    expect(companions).toMatchInlineSnapshot(`
      [
        {
          "id": "session-analyst-chat",
          "title": "Session Analyst",
        },
        {
          "id": "session-analyst-artifacts",
          "title": "Artifacts",
        },
      ]
    `);
    expect(source).toContain("context.onRequestCompanions?.(!context.companionsOpen)");
  });
});
