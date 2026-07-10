import fs from "node:fs";

import { describe, expect, it } from "vitest";

const CLIENT_ROOT = new URL("../core/client/src/", import.meta.url);
const OWNED_SOURCES = [
  "canvas/canvas-store.ts",
  "canvas/canvas-grid.tsx",
  "canvas/canvas-context-menu.tsx",
  "canvas/canvas-minimap.tsx",
  "canvas/canvas.tsx",
  "pages/operations.tsx",
  "sidebar/operations-side-bar.tsx",
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

  it("keeps Formation, mapFullscreen, and maximize store contracts", () => {
    const store = source("canvas/canvas-store.ts");
    expect(store).toContain("toggleFormationView");
    expect(store).toContain("toggleMapFullscreen");
    expect(store).toContain("setMaximizedOperationId");
  });
});
