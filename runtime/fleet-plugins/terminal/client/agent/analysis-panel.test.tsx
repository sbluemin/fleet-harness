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
    const messages = readFileSync(new URL("../i18n/index.ts", import.meta.url), "utf8");
    const css = readFileSync(new URL("./analysis.css", import.meta.url), "utf8");
    expect(chat).toContain("terminal.analyst.suggestion.walkthrough");
    expect(messages).toContain('"Walk me through how this session unfolded"');
    expect(messages).toContain('"Answered in {elapsed}"');
    expect(messages).toContain('"Review, explain, and summarize this session — without affecting the host agent."');
    expect(chat).not.toContain("host agent&apos;s transcript");
    expect(chat).toContain("terminal.analyst.activity.starting");
    expect(chat).toContain("terminal.analyst.activity.reasoning");
    expect(chat).toContain("terminal.analyst.activity.writing");
    expect(chat.match(/t\("terminal\.analyst\.stop"\)/g)).toHaveLength(1);
    expect(chat).toContain('className="session-analyst__send session-analyst__stop"');
    expect(chat).not.toContain("state.thinking");
    expect(artifacts).not.toContain("SANDBOXED HTML");
    expect(artifacts).not.toContain("Sandboxed");
    expect(messages).toContain('"Artifacts the analyst publishes will appear here."');
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
    // 면 계약 — 드로어는 companion 프레임의 창 면을 그대로 잇는다. pillar로 되돌아가면 안 된다.
    expect(css).toContain("var(--surface-window, var(--surface-panel))");
    expect(css).not.toContain("var(--surface-pillar)");
    expect(css).toContain("var(--surface-panel-raised)");
    expect(css).not.toContain("background: color-mix(in oklch, var(--ink-mid) 60%, black)");
    expect(css).not.toContain(".session-analyst__chat-pane textarea:focus-visible");
    expect(css).not.toContain(".session-analyst__chat-pane select:focus-visible");
    expect(css.match(/grid-template-columns: minmax\(0, 1fr\)/g)).toHaveLength(2);
    expect(css).toContain(".agent-stream-host .terminal-stage { z-index: 0; }");
    expect(css).not.toContain("agent-stream-host--analyst");
  });
  it("keeps both Analyst panels hidden by default", () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const visibility = readFileSync(new URL("./analysis-visibility.ts", import.meta.url), "utf8");
    expect(source).toContain('id: ANALYST_CHAT_COMPANION_ID, title: (locale) => getT(locale)("terminal.companion.sessionAnalyst"), hideCaption: true, defaultHidden: true');
    expect(source).toContain('id: ANALYST_ARTIFACTS_COMPANION_ID, title: (locale) => getT(locale)("terminal.companion.artifacts"), hideCaption: true, defaultHidden: true');
    expect(visibility).toContain('export const ANALYST_ARTIFACTS_COMPANION_ID = "session-analyst-artifacts";');
    expect(source.match(/hideCaption: true/g)).toHaveLength(2);
    expect(source.match(/defaultHidden: true/g)).toHaveLength(2);
    expect(source).toContain('shortcut: { code: "KeyA", label: "A", clusterIds: ANALYST_COMPANION_IDS }');
    expect(source).not.toMatch(/id: ANALYST_ARTIFACTS_COMPANION_ID[^\n]*shortcut:/);
    expect(source).toContain("toggleCompanionPanel(context, ANALYST_CHAT_COMPANION_ID, ANALYST_COMPANION_IDS)");
    expect(source).toContain("previousCompanionsOpenRef");
    // dispose 경합에서 orphan store를 만들지 않도록 re-arm은 조회 전용 API만 사용한다.
    expect(source).toContain("rearmAnalysisArtifacts(context.operationId)");
    expect(source).not.toContain("getAnalysisStore");
    const storeSource = readFileSync(new URL("./analysis-store.ts", import.meta.url), "utf8");
    expect(storeSource).toContain('stores.get(operationId)?.dispatch({ type: "artifacts-chip-rearm" });');
  });
});
