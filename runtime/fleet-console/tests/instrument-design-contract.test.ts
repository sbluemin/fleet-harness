import fs from "node:fs";

import { describe, expect, it } from "vitest";

const CLIENT_ROOT = new URL("../core/client/src/", import.meta.url);
const SKILLS_CSS_PATH = new URL("../../fleet-plugins/skills/client/skills.css", import.meta.url);
const TERMINAL_AGENT_PATH = new URL("../../fleet-plugins/terminal/client/agent/index.tsx", import.meta.url);
const OWNED_SOURCES = [
  "app.tsx",
  "canvas/canvas-store.ts",
  "canvas/canvas-grid.tsx",
  "canvas/canvas-context-menu.tsx",
  "canvas/canvas-minimap.tsx",
  "canvas/canvas.tsx",
  "pages/operations.tsx",
  "components/side-bar-brand-foot.tsx",
  "sidebar/operations-side-bar.tsx",
  "styles/theme.css",
  "styles/components.css",
  "styles/layout.css",
  "styles/rail.css",
  "styles/rail-alerts.css",
  "rail/plans.css",
] as const;

const FORBIDDEN_DECORATION = /radar-sweep|operations-radar|BACKGROUND_ANIMATION_STORAGE_KEY|PERIMETER_ANIMATION_STORAGE_KEY|Panel pulse|perimeter-orbit|notification-wake-pulse|AnchorIcon/;

function source(path: string): string {
  return fs.readFileSync(new URL(path, CLIENT_ROOT), "utf8");
}

function externalSource(path: URL): string {
  return fs.readFileSync(path, "utf8");
}

describe("Instrument core design contract", () => {
  it("removes ambient radar, panel pulse, perimeter wake, and anchor surfaces", () => {
    for (const path of OWNED_SOURCES) expect(source(path)).not.toMatch(FORBIDDEN_DECORATION);
  });

  it("keeps Map labels and navigation behavior while removing animation controls", () => {
    const minimap = source("canvas/canvas-minimap.tsx");
    const contextMenu = source("canvas/canvas-context-menu.tsx");
    expect(minimap).toContain(">Map<");
    expect(minimap).toContain("onPointerMove={onPointerMove}");
    expect(minimap).toContain("onJump({");
    expect(contextMenu).toContain("Formation view");
    expect(contextMenu).not.toContain("onToggleRadar");
    expect(contextMenu).not.toContain("onTogglePerimeter");
  });

  it("uses opaque token surfaces without blur or identity-accent borders", () => {
    const css = OWNED_SOURCES.filter((path) => path.endsWith(".css")).map(source).join("\n");
    expect(css).not.toMatch(/backdrop-filter|--op-accent|--chip-accent/);
    expect(css).toContain("background: var(--surface-glass)");
    expect(css).toContain(":focus-visible");
  });

  it("keeps Formation and maximize store contracts without the retired focus mode", () => {
    const store = source("canvas/canvas-store.ts");
    expect(store).toContain("toggleFormationView");
    expect(store).not.toContain("MapFullscreen");
    expect(store).toContain("setMaximizedOperationId");
  });

  it("pins the progressive shell and closed-chrome contracts", () => {
    const app = source("app.tsx");
    const layout = source("styles/layout.css");
    const components = source("styles/components.css");
    const rail = source("styles/rail.css");
    expect(app).toContain("FloatingChromeHandles");
    expect(source("components/floating-chrome-handles.tsx")).toContain("float-handle float-left");
    expect(app).not.toContain("FocusMode");
    expect(app).not.toContain("is-focus-mode");
    expect(app).toContain('closest(".side-bar-collapse-btn")');
    expect(app).toContain('closest(".right-rail-chrome-toggle")');
    expect(app).not.toContain("GlobalNavigation");
    expect(layout).not.toContain("--console-gnb-height");
    expect(layout).not.toContain("is-focus-mode");
    expect(components).toContain(".operations-side-bar.is-closed");
    expect(components).toContain(".float-handle {");
    expect(components).not.toContain("focus-mode-reveal");
    expect(rail).toContain(".right-rail.is-closed");
  });

  it("keeps the Instrument base tokens and selector while blocking legacy palette escapes", () => {
    const theme = source("styles/theme.css");
    const base = theme.slice(0, theme.indexOf(':root[data-theme="'));
    expect(theme).toContain(':root[data-theme="instrument"]');
    expect(base).toContain("--ink-abyss: oklch(13% 0.014 245);");
    expect(base).toContain("--brass: oklch(80% 0.085 78);");
    expect(base).toContain("--aurora: oklch(77% 0.085 200);");
    expect(base).toContain("--coral: oklch(68% 0.13 25);");
    expect(base).toContain("--warn: oklch(75% 0.08 90);");
    expect(base).toContain("--positive: oklch(76% 0.11 160);");
    expect(base).toContain("--canvas-sea-core: oklch(13% 0.018 245);");
    expect(base).toContain("color-mix(in oklch, var(--brass) 16%, transparent)");
    expect(base).not.toMatch(/--brass(?:-[a-z-]+)?:\s*oklch\([^;]*\b0\.13\b/);
    expect(theme).toContain(':root[data-theme="maritime"]');
    expect(theme).toContain(':root[data-theme="carbon"]');
    expect(theme).toContain("--brass: oklch(78% 0.13 75);");
    expect(theme.match(/^:root \{/gm)).toHaveLength(1);
    // Legacy 테마 블록은 팔레트 토큰만 — 모든 선언이 승인된 색 토큰 화이트리스트에 속해야 하며
    // 형상(radius/space)·배경 연출(grain/pseudo)·타이포(font) 오버라이드는 진입 불가.
    const variantBlocks = theme.match(/^:root\[data-theme="(?:maritime|carbon)"\][^{]*\{[^}]*\}/gm) ?? [];
    expect(variantBlocks).toHaveLength(3);
    for (const block of variantBlocks) {
      const declarations = block.match(/^\s{2}[^\n:]+:/gm) ?? [];
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) {
        expect(declaration.trim()).toMatch(/^--(?:ink|brass|aurora|coral|warn|positive|canvas|surface|hairline|text)[a-z-]*:$/);
      }
    }
    expect(theme).not.toMatch(/body::(?:before|after)/);
  });

  it("keeps real GNB and captain producers aligned with the static CSS gates", () => {
    const components = source("styles/components.css");
    const brandFoot = source("components/side-bar-brand-foot.tsx");
    const terminalAgent = externalSource(TERMINAL_AGENT_PATH);
    const skillsCss = externalSource(SKILLS_CSS_PATH);
    expect(components.match(/font-family:\s*var\(--font-display\)/g)).toHaveLength(1);
    expect(brandFoot).toContain('className="brand-foot-wordmark"');
    expect(components).not.toMatch(/data-sidebar-state="(?:rail|list|detail)"/);
    expect(components).not.toContain("global-navigation");
    expect(components).toContain(".job-dock-captain-dot {");
    expect(components).toContain(".job-dock-captain-tag {");
    expect(components).not.toMatch(/\.job-dock-(?:carrier|row-name)\[data-captain=/);
    expect(components).not.toContain("data-signature");
    expect(terminalAgent).toContain('className="job-dock-captain-dot"');
    expect(terminalAgent).toContain('className="job-dock-captain-tag"');
    expect(terminalAgent).not.toContain("data-signature");
    expect(skillsCss).not.toMatch(/color-mix\([^)]*\b(?:black|white)\b/);
  });

  it("keeps the v4 navigation, Theater, map, CLI, and rail visual producers", () => {
    const brandFoot = source("components/side-bar-brand-foot.tsx");
    const sidebar = source("sidebar/operations-side-bar.tsx");
    const chip = source("sidebar/operations-side-bar-chip.tsx");
    const minimap = source("canvas/canvas-minimap.tsx");
    const railProducer = source("rail/right-rail.tsx");
    const components = source("styles/components.css");
    const rail = source("styles/rail.css");

    expect(sidebar).toContain('className="side-bar-search-btn"');
    expect(sidebar).toContain("onClick={toggleOperationSearch}");
    expect(sidebar).toContain('className="side-bar-formation-btn"');
    expect(sidebar).toContain("onClick={toggleFormationView}");
    expect(sidebar).toContain("disabled={activeTheaterId === null}");
    expect(sidebar).toContain("aria-pressed={formationView}");
    expect(sidebar).not.toContain("side-bar-settings-btn");
    // 헤더 버튼 순서 계약: 접기 → Formation → 검색.
    const headerBlock = sidebar.slice(sidebar.indexOf('className="operations-side-bar-header"'), sidebar.indexOf("</header>"));
    const collapseAt = headerBlock.indexOf("side-bar-collapse-btn");
    const formationAt = headerBlock.indexOf("side-bar-formation-btn");
    const searchAt = headerBlock.indexOf("side-bar-search-btn");
    expect(collapseAt).toBeGreaterThan(-1);
    expect(formationAt).toBeGreaterThan(collapseAt);
    expect(searchAt).toBeGreaterThan(formationAt);
    expect(source("canvas/canvas-context-menu.tsx")).toContain('export type CanvasContextMenuMode = "full" | "launch";');
    expect(brandFoot).toContain('className="brand-foot-dropup-menu" role="menu"');
    expect(brandFoot).toContain('className="brand-foot-version"');
    expect(brandFoot).toContain("openWhatsNew");
    expect(components).toContain(".side-bar-brand-foot {");

    expect(sidebar).toContain("hasCustomGroups && section.entries.length > 0");
    expect(sidebar).toContain("theaterInitials(theater.label)");
    expect(chip).toContain("side-bar-chip-status");
    expect(chip).toContain('if (visual === "awaiting") return "tenant-beacon is-awaiting"');
    expect(chip).not.toContain("is-attention");
    expect(components).toContain(".side-bar-chip:focus-within .side-bar-chip-close");

    expect(minimap).not.toContain("is-plugin");
    expect(components).not.toContain(".canvas-minimap-operation.is-plugin");
    expect(components).toContain(".canvas-operation-cli {");
    expect(components).toContain("border: 1px solid var(--surface-rim);");
    expect(railProducer).toContain('<rect x="1.75" y="3" width="12.5" height="10" rx="2.4"');
    expect(rail).toContain("width: 44px");
    expect(rail).toContain("width: 16px");
  });
});
