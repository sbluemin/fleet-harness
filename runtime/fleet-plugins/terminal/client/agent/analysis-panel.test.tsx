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
  it("keeps the approved visible-copy and motion contracts in separate companion panels", () => {
    const chat = readFileSync(new URL("./analysis-chat-panel.tsx", import.meta.url), "utf8");
    const artifacts = readFileSync(new URL("./analysis-artifacts-panel.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("./analysis.css", import.meta.url), "utf8");
    expect(chat).toContain("Walk me through how this session unfolded");
    expect(chat).toContain("Read-only intelligence for this operation");
    expect(chat).toContain("Review, explain, and summarize this session — without affecting the host agent.");
    expect(chat).not.toContain("host agent&apos;s transcript");
    expect(chat).toContain("Starting analyst");
    expect(chat).toContain("Reasoning over session");
    expect(chat).toContain("Writing answer");
    expect(chat.match(/aria-label="Stop"/g)).toHaveLength(1);
    expect(chat).toContain('className="session-analyst__send session-analyst__stop"');
    expect(chat).not.toContain("state.thinking");
    expect(artifacts).not.toContain("SANDBOXED HTML");
    expect(artifacts).not.toContain("Sandboxed");
    expect(artifacts).toContain("Artifacts the analyst publishes will appear here.");
    expect(artifacts).toContain('sandbox="allow-scripts"');
    expect(artifacts).not.toContain("allow-same-origin");
    expect(artifacts).not.toContain("srcDoc=");
    expect(artifacts).toContain("src={analysisArtifactUrl(artifact.id, theme, canvas, foreground)}");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("var(--aurora)");
    expect(css).toContain("var(--positive)");
    expect(css).toContain("var(--coral)");
    expect(css).toContain(".session-analyst__composer-surface:focus-within");
    expect(css).toContain(".session-analyst__composer.is-working .session-analyst__composer-surface");
    expect(css).toContain("user-select: text");
    expect(css).toContain(":is(button, select) { user-select: none; }");
    expect(css).not.toContain(":is(button, a)");
    expect(css).toContain(".session-analyst__chat > ol {");
    expect(css).not.toMatch(/\.session-analyst__chat ol\s*\{/);
    expect(css).not.toContain(".session-analyst__chat ol.is-dimmed");
    expect(css).toContain("var(--surface-glass-strong)");
    expect(css).not.toContain("background: color-mix(in oklch, var(--ink-mid) 60%, black)");
    expect(css).not.toContain(".session-analyst__chat-pane textarea:focus-visible");
    expect(css).not.toContain(".session-analyst__chat-pane select:focus-visible");
    expect(css.match(/grid-template-columns: minmax\(0, 1fr\)/g)).toHaveLength(2);
    expect(css).toContain(".agent-stream-host .terminal-stage { z-index: 0; }");
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
    expect(source.match(/hideCaption: true/g)).toHaveLength(2);
    expect(source).toContain("context.onRequestCompanions?.(!context.companionsOpen)");
  });
});
