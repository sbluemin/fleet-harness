// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { safeArtifactSrcdoc } from "./analysis-artifact.js";
import { ARTIFACT_CSP } from "./analysis-types.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("./analysis-store.js", () => ({
  useAnalysisStore: () => ({
    state: { artifacts: [{ id: "artifact", title: "Artifact", html: "<p>safe</p>", createdAt: 1 }] },
    dispatch: vi.fn(),
  }),
}));

import { AnalystArtifactsPanel } from "./analysis-artifacts-panel.js";

describe("artifact frame", () => {
  it("places the exact CSP first and rejects over-sized content", () => {
    expect(safeArtifactSrcdoc("<script>1</script>")).toBe(`${ARTIFACT_CSP}<script>1</script>`);
    expect(safeArtifactSrcdoc("x".repeat(50 * 1024 + 1))).toBeNull();
  });
  it("keeps sandboxing and in-memory clear controls in the artifact companion", () => {
    const panel = readFileSync(resolve("client/agent/analysis-artifacts-panel.tsx"), "utf8");
    expect(panel).toContain('sandbox="allow-scripts"');
    expect(panel).toContain('type: "clear-artifacts"');
  });
  it("removes an artifact iframe and warns after a second load event", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(AnalystArtifactsPanel, { context: {} as never })));
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();

    act(() => iframe?.dispatchEvent(new Event("load", { bubbles: true })));
    expect(container.querySelector("iframe")).toBe(iframe);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    act(() => iframe?.dispatchEvent(new Event("load", { bubbles: true })));
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Artifact blocked after attempting navigation.");

    act(() => root.unmount());
    container.remove();
  });
});
