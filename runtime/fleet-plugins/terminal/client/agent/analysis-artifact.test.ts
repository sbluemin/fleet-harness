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
    // 스토어 순서는 최신 우선 — 탭은 생성순으로 뒤집혀야 한다.
    state: { artifacts: [
      { id: "artifact-late", title: "Later artifact", html: "<p>later</p>", createdAt: 2 },
      { id: "artifact-early", title: "Early artifact", html: "<p>early</p>", createdAt: 1 },
    ] },
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
  it("shows one full-size active artifact with creation-ordered tabs and blocks after a second load", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(AnalystArtifactsPanel, { context: {} as never })));

    // 탭은 생성순, 활성 문서는 최신 게시본 하나만 렌더된다.
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Early artifact", "Later artifact"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(container.querySelector("iframe")?.title).toBe("Later artifact");

    // 탭 전환 시 해당 문서가 전체 뷰로 렌더된다.
    act(() => (tabs[0] as HTMLButtonElement).click());
    expect(container.querySelector("iframe")?.title).toBe("Early artifact");

    const iframe = container.querySelector("iframe");
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
