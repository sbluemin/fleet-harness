// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_CSP, safeArtifactSrcdoc } from "./analysis-types.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

describe("artifact frame", () => {
  it("regenerates a CSP-first static document from positive element and attribute allowlists", () => {
    const srcdoc = safeArtifactSrcdoc(`<!doctype html><html><head>
      <meta http-equiv="refresh" content="0;url=https://attacker.example/meta">
      <base href="https://attacker.example/"><link rel="preload" href="https://attacker.example/leak">
      <style>.safe { color: red; background: url(https://attacker.example/css) } @import "https://attacker.example/import";</style>
    </head><body onload="location='https://attacker.example/event'">
      <article id="safe" class="safe" style="display:grid;background:url(https://attacker.example/inline)">
        <details open><summary>Evidence</summary><table><tbody><tr><th scope="row">Ref</th><td><code>[e1]</code></td></tr></tbody></table></details>
        <img id="raster" alt="Chart" src="data:image/png;base64,iVBORw0KGgo=">
        <img id="svg-image" src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">
        <img id="remote-image" src="https://attacker.example/image.png" onerror="alert(1)">
      </article>
      <script>location='https://attacker.example/script'</script><noscript>fallback</noscript>
      <a href="https://attacker.example/link" ping="https://attacker.example/ping">link</a><area href="https://attacker.example/area">
      <form action="https://attacker.example/form"><input><button formaction="https://attacker.example/button">Go</button></form>
      <iframe src="https://attacker.example/frame"></iframe><object data="https://attacker.example/object"></object><embed src="https://attacker.example/embed">
      <video poster="https://attacker.example/poster"><source src="https://attacker.example/media"></video>
      <svg><a href="https://attacker.example/svg"><animate attributeName="href" values="https://attacker.example/smil"></animate></a></svg>
      <math><a href="https://attacker.example/math">math</a></math>
      <template shadowrootmode="open"><script>location='https://attacker.example/shadow'</script></template>
    </body></html>`)!;
    const document = new DOMParser().parseFromString(srcdoc, "text/html");
    const csp = document.head.firstElementChild;

    expect(csp?.outerHTML).toBe(ARTIFACT_CSP);
    expect(document.querySelector("article#safe.safe")).not.toBeNull();
    expect(document.querySelector("details[open] summary")?.textContent).toBe("Evidence");
    expect(document.querySelector("table code")?.textContent).toBe("[e1]");
    expect(document.querySelector("style")?.textContent).toContain("color: red");
    expect(document.querySelector("article")?.getAttribute("style")).toContain("display:grid");
    expect(document.querySelector("img#raster")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(document.querySelector("img#svg-image")?.hasAttribute("src")).toBe(false);
    expect(document.querySelector("img#remote-image")?.hasAttribute("src")).toBe(false);
    expect(document.querySelector("[onload], [onerror], [href], [ping], [action], [formaction], [srcdoc], [srcset], [poster]")).toBeNull();
    expect(document.querySelector("script, noscript, template, svg, math, animate, a, area, form, input, button, iframe, frame, object, embed, video, audio, source, link, base")).toBeNull();
    expect(document.querySelectorAll("meta")).toHaveLength(1);
    expect(srcdoc).not.toContain("attacker.example");
    expect(safeArtifactSrcdoc("x".repeat(50 * 1024 + 1))).toBeNull();
  });
  it("uses an empty sandbox without a post-navigation load detector", () => {
    const panel = readFileSync(resolve("client/agent/analysis-artifacts-panel.tsx"), "utf8");
    expect(panel).toContain('sandbox=""');
    expect(panel).not.toContain("allow-scripts");
    expect(panel).not.toContain("onLoad=");
    expect(panel).not.toContain("loadCount");
    expect(panel).toContain('type: "clear-artifacts"');
  });
  it("opens a creation-ordered header listbox and keeps one selected preview", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(AnalystArtifactsPanel, { context: {} as never })));

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
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(options.map((option) => option.querySelector("strong")?.textContent)).toEqual(["Early artifact", "Later artifact"]);
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(options.every((option) => option.querySelector("time")?.hasAttribute("datetime"))).toBe(true);

    // 목록에서 선택하면 해당 문서가 전체 뷰로 렌더되고 popover는 닫힌다.
    act(() => (options[0] as HTMLButtonElement).click());
    expect(container.querySelector("iframe")?.title).toBe("Early artifact");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe("");
    act(() => iframe?.dispatchEvent(new Event("load", { bubbles: true })));
    expect(container.querySelector("iframe")).toBe(iframe);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    act(() => iframe?.dispatchEvent(new Event("load", { bubbles: true })));
    expect(container.querySelector("iframe")).toBe(iframe);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});
