// @vitest-environment jsdom

import type { ConsoleTheme, OperationRenderContext } from "@fleet-console/sdk/plugin";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./analysis-store.js", () => ({
  useAnalysisStore: () => ({
    // 스토어 순서는 최신 우선 — 헤더 popover 목록은 생성순으로 뒤집혀야 한다.
    state: { artifacts: [
      { id: "artifact-late", title: "Later artifact", html: "<p>later</p>", createdAt: 2 },
      { id: "artifact-early", title: "Early artifact", html: "<p>early</p>", createdAt: 1 },
    ] },
    dispatch: vi.fn(),
  }),
}));

import { AnalystArtifactsPanel } from "./analysis-artifacts-panel.js";

const THEMES = ["instrument", "maritime", "carbon", "whites"] as const satisfies readonly ConsoleTheme[];

function operationContext(theme: ConsoleTheme, fetch = vi.fn(async () => new Response(null, { status: 200 })), language?: "en" | "ko"): OperationRenderContext {
  return { theme, operationId: "op/id", api: { fetch }, language } as never;
}

function artifactUrl(frame: HTMLIFrameElement): URL {
  return new URL(frame.getAttribute("src") ?? "", "http://console.test");
}

afterEach(() => {
  document.documentElement.style.removeProperty("--surface-panel");
  document.documentElement.style.removeProperty("--text-primary");
});

describe("artifact frame", () => {

  it("opens a creation-ordered header listbox and keeps one selected preview", () => {
    document.documentElement.style.setProperty("--surface-panel", "rgb(11, 12, 13)");
    document.documentElement.style.setProperty("--text-primary", "rgb(241, 242, 243)");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ cleared: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    act(() => root.render(createElement(AnalystArtifactsPanel, { context: operationContext("instrument", fetch) })));

    const trigger = container.querySelector<HTMLButtonElement>(".session-analyst__artifact-count")!;
    expect(trigger.textContent).toBe("2 items");
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
    expect(url.pathname).toBe("/plugins/terminal/analysis/artifacts/artifact-early");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      theme: "instrument",
      ground: "rgb(11, 12, 13)",
      foreground: "rgb(241, 242, 243)",
    });
    act(() => iframe.dispatchEvent(new Event("load", { bubbles: true })));
    expect(container.querySelector("iframe")).toBe(iframe);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>(".session-analyst__clear")?.click());
    expect(fetch).toHaveBeenCalledWith("terminal", "analysis/op%2Fid/artifacts", { method: "DELETE" });

    act(() => root.unmount());
    container.remove();
  });
});
