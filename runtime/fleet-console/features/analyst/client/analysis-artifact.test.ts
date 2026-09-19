// @vitest-environment jsdom

import type { ConsoleTheme, OperationRenderContext } from "@fleet-console/sdk/plugin";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalysisArtifact } from "./analysis-types.js";

const ARTIFACTS: readonly AnalysisArtifact[] = [
  { id: "artifact-late", title: "Later artifact", html: "<p>later</p>", createdAt: 2 },
  { id: "artifact-early", title: "Early artifact", html: "<p>early</p>", createdAt: 1 },
];
vi.mock("./analysis-store.js", () => ({
  useAnalysisStore: () => ({
    // 스토어 순서는 최신 우선 — 피커 목록은 생성순으로 뒤집혀야 한다.
    state: { artifacts: ARTIFACTS },
    dispatch: vi.fn(),
  }),
}));

import { AnalystArtifactsPanel, ArtifactClearGlyph, ArtifactPicker } from "./analysis-artifacts-panel.js";

const THEMES = ["instrument", "maritime", "carbon", "whites"] as const satisfies readonly ConsoleTheme[];

function operationContext(theme: ConsoleTheme, fetch = vi.fn(async () => new Response(null, { status: 200 })), language?: "en" | "ko"): OperationRenderContext {
  return { theme, operationId: "op/id", api: { fetch }, language } as never;
}

function artifactUrl(frame: HTMLIFrameElement): URL {
  return new URL(frame.getAttribute("src") ?? "", "http://console.test");
}

/* 발판 줄의 피커·지우기와 본문이 한 값을 보는 조립 — 채팅 패널이 쥐는 activeId를 그대로 흉내 낸다. */
function ArtifactsHarness({ context }: { readonly context: OperationRenderContext }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = ARTIFACTS.find((artifact) => artifact.id === activeId) ?? ARTIFACTS[0] ?? null;
  return createElement("div", null,
    createElement(ArtifactPicker, { context, active, onSelect: setActiveId }),
    createElement(ArtifactClearGlyph, { context }),
    createElement(AnalystArtifactsPanel, { context, artifact: active }),
  );
}

afterEach(() => {
  document.documentElement.style.removeProperty("--surface-panel");
  document.documentElement.style.removeProperty("--text-primary");
});

describe("artifact frame", () => {

  it("opens a creation-ordered picker listbox, keeps one selected preview, and clears only on the second press", () => {
    document.documentElement.style.setProperty("--surface-panel", "rgb(11, 12, 13)");
    document.documentElement.style.setProperty("--text-primary", "rgb(241, 242, 243)");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ cleared: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    act(() => root.render(createElement(ArtifactsHarness, { context: operationContext("instrument", fetch) })));

    const trigger = container.querySelector<HTMLButtonElement>(".session-analyst__artifact-count")!;
    expect(trigger.textContent).toContain("Later artifact");
    expect(trigger.textContent).toContain("2");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(container.querySelector("iframe")?.title).toBe("Later artifact");
    expect(container.querySelector('article[aria-label="Selected artifact preview"]')).not.toBeNull();

    act(() => trigger.click());
    const options = [...container.querySelectorAll('[role="option"]')];
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(options.map((option) => option.querySelector("strong")?.textContent)).toEqual(["Early artifact", "Later artifact"]);
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(options.every((option) => option.querySelector("time")?.hasAttribute("datetime"))).toBe(true);

    act(() => (options[0] as HTMLButtonElement).click());
    const iframe = container.querySelector("iframe")!;
    expect(iframe.title).toBe("Early artifact");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.hasAttribute("srcdoc")).toBe(false);
    const url = artifactUrl(iframe);
    expect(url.pathname).toBe("/api/v1/analysis/artifacts/artifact-early");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      theme: "instrument",
      ground: "rgb(11, 12, 13)",
      foreground: "rgb(241, 242, 243)",
    });
    act(() => iframe.dispatchEvent(new Event("load", { bubbles: true })));
    expect(container.querySelector("iframe")).toBe(iframe);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // 모두 지우기는 글자 없는 글리프라 두 번 누름으로 지킨다 — 첫 누름은 무장만, 두 번째가 지운다.
    const clear = container.querySelector<HTMLButtonElement>(".session-analyst__glyph--clear")!;
    act(() => clear.click());
    expect(clear.getAttribute("aria-pressed")).toBe("true");
    expect(fetch).not.toHaveBeenCalled();
    act(() => clear.click());
    expect(fetch).toHaveBeenCalledWith(null, "analysis/op%2Fid/artifacts", { method: "DELETE" });

    act(() => root.unmount());
    container.remove();
  });
});
