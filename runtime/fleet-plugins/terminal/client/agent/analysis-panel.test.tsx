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
    // 컴포저는 한 장이다 — 선택 줄은 같은 면 안 하단 줄이지, 자기 테두리를 가진 두 번째 상자가 아니다.
    expect(css).not.toContain("session-analyst__selector-strip");
    // 떠 있던 칩 줄이 캡션으로 옮겨간 뒤 본문은 어느 모드에서도 그 자리를 비워 두지 않는다 —
    // 한 경로만 남으면 그 화면만 빈 띠를 이고 미리보기 높이를 잃는다.
    expect(css).not.toMatch(/padding(-top)?: calc\(var\(--space-\d\) \+ 34px\)/);
    expect(css).toContain(".session-analyst__composer.is-initial .session-analyst__composer-surface { flex-direction: column;");
    // 저장 표식은 자리를 늘 차지한다 — 나타날 때 줄이 밀리면 그 흔들림이 알림보다 크게 읽힌다.
    expect(css).toMatch(/\.session-analyst__saved \{[^}]*inline-size: [\d.]+em;/);
    // 모델은 Quick Launch 칩, 강도는 공용 트랙이다.
    expect(css).toContain(".session-analyst__model-chip");
    expect(css).toContain(".session-analyst__effort");
    // 드롭다운 모델명은 우클릭 실행 메뉴와 같은 variant-row 조판이다.
    expect(css).not.toContain(".session-analyst__model-row");
    expect(css).toContain(".session-analyst__model-menu .operation-launch-variant-row");
    expect(css).not.toContain("--fc-select-compact-tone: var(--effort-tone, var(--text-secondary));");
    expect(css).toContain("user-select: text");
    expect(css).toContain(":is(button, select) { user-select: none; }");
    expect(css).not.toContain(":is(button, a)");
    expect(css).toContain(".session-analyst__chat > ol {");
    expect(css).not.toMatch(/\.session-analyst__chat ol\s*\{/);
    expect(css).not.toContain(".session-analyst__chat ol.is-dimmed");
    // 면 계약 — 드로어는 companion 프레임과 같은 패널 면 한 장을 잇는다. pillar로 되돌아가면 안 되고,
    // 포커스 워시(--surface-window)는 캡션 전용이라 본문이 따라가서도 안 된다(PR#711 결정).
    expect(css).toContain("background: var(--glass-tint-panel-face);");
    expect(css).not.toContain("var(--surface-pillar)");
    expect(css).not.toContain("surface-window");
    expect(css).toContain("var(--surface-panel-raised)");
    expect(css).not.toContain("background: color-mix(in oklch, var(--ink-mid) 60%, black)");
    expect(css).not.toContain(".session-analyst__chat-pane textarea:focus-visible");
    expect(css).not.toContain(".session-analyst__chat-pane select:focus-visible");
    expect(css.match(/grid-template-columns: minmax\(0, 1fr\)/g)).toHaveLength(2);
    expect(css).toContain(".agent-stream-host .terminal-stage { z-index: 0; }");
    expect(css).not.toContain("agent-stream-host--analyst");
  });
  it("keeps the single Analyst companion hidden by default", () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const visibility = readFileSync(new URL("./analysis-visibility.ts", import.meta.url), "utf8");
    expect(source).toContain('id: ANALYST_CHAT_COMPANION_ID, title: (locale) => getT(locale)("terminal.companion.sessionAnalyst"), defaultHidden: true');
    // 캡션 밴드는 호스트가 자리를 비워 둔다 — 채우지 않으면 빈 띠가 남고 위 모서리가 각진다.
    expect(source).toContain('caption: (context) => <AnalystCaption context={context} />');
    expect(source).not.toContain("hideCaption");
    // 아티팩트는 드로어 안의 모드다 — 두 번째 컴패니언이 되살아나면 안 된다.
    expect(source).not.toContain("ANALYST_ARTIFACTS_COMPANION_ID");
    expect(visibility).not.toContain("session-analyst-artifacts");
    expect(source.match(/defaultHidden: true/g)).toHaveLength(1);
    expect(source).toContain('shortcut: { code: "KeyA", label: "A", clusterIds: ANALYST_COMPANION_IDS }');
    expect(source).toContain("toggleCompanionPanel(context, ANALYST_CHAT_COMPANION_ID, ANALYST_COMPANION_IDS)");
    expect(source).not.toContain("getAnalysisStore");
  });
});
