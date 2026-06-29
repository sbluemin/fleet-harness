// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeMermaidSource } from "@fleet-console/markdown/core";

interface InstalledHydrator {
  installDiagramHydrator: (root: ParentNode) => void;
}

type DialogConstructor = typeof HTMLDialogElement;
type DialogPrototypePatch = HTMLElement & {
  close?: () => void;
  showModal?: () => void;
};

const { renderMock, initializeMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  initializeMock: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: initializeMock,
    render: renderMock,
  },
}));

async function loadHydrator(): Promise<InstalledHydrator> {
  vi.resetModules();
  initializeMock.mockClear();
  renderMock.mockClear();
  return (await import("@fleet-console/markdown/mermaid")) as unknown as InstalledHydrator;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function placeholderHtml(source: string): string {
  return `<div class="diagram-block" data-mermaid-source="${encodeMermaidSource(source)}" data-diagram-state="pending"></div>`;
}

async function renderDiagram(svg: string, source = "graph TD; A-->B"): Promise<HTMLElement> {
  renderMock.mockResolvedValue({ svg });
  document.body.innerHTML = `<main id="app-shell">${placeholderHtml(source)}</main>`;
  const { installDiagramHydrator } = await loadHydrator();
  installDiagramHydrator(document.body);
  const block = document.querySelector<HTMLElement>(".diagram-block")!;
  await waitFor(() => block.dataset.diagramState === "rendered");
  return block;
}

function dispatchCancelable(element: EventTarget, event: Event): boolean {
  return element.dispatchEvent(event);
}

function numberAttr(element: Element, name: string): number {
  return Number(element.getAttribute(name));
}

function setElementBox(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: height });
  element.getBoundingClientRect = () =>
    ({
      bottom: height,
      height,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function pointerEvent(type: string, init: MouseEventInit & { pointerId?: number } = {}): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "pointerId", { configurable: true, value: init.pointerId ?? 1 });
  return event;
}

function installDialogStub(): () => void {
  const originalCtor = globalThis.HTMLDialogElement;
  const prototype = HTMLElement.prototype as DialogPrototypePatch;
  const originalShowModal = prototype.showModal;
  const originalClose = prototype.close;
  class TestDialogElement extends HTMLElement {}
  Object.defineProperty(globalThis, "HTMLDialogElement", {
    configurable: true,
    value: TestDialogElement as unknown as DialogConstructor,
  });
  prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  prototype.close = function close() {
    this.removeAttribute("open");
  };
  return () => {
    Object.defineProperty(globalThis, "HTMLDialogElement", {
      configurable: true,
      value: originalCtor,
    });
    if (originalShowModal) {
      prototype.showModal = originalShowModal;
    } else {
      delete prototype.showModal;
    }
    if (originalClose) {
      prototype.close = originalClose;
    } else {
      delete prototype.close;
    }
  };
}

describe("diagram hydrator security", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
  });

  afterEach(() => {
    renderMock.mockReset();
    initializeMock.mockReset();
  });

  it("strips <script>, event handlers, and javascript: anchors from rendered SVG", async () => {
    renderMock.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><script>alert('xss')</script><g class="node" onclick="alert('xss')"><a href="javascript:alert('xss')"><text>label</text></a></g></svg>`,
    });
    document.body.innerHTML = placeholderHtml("graph TD; A-->B");
    const { installDiagramHydrator } = await loadHydrator();
    installDiagramHydrator(document.body);
    const block = document.querySelector<HTMLElement>(".diagram-block")!;
    await waitFor(() => block.dataset.diagramState === "rendered");

    expect(block.querySelector("script")).toBeNull();
    expect(block.outerHTML).not.toMatch(/\sonclick=/i);
    expect(block.outerHTML).not.toContain("javascript:");
    expect(block.outerHTML).not.toContain("alert('xss')");
    const anchor = block.querySelector("a");
    expect(anchor?.getAttribute("href")).toBeNull();
    expect(block.querySelector("text")?.textContent).toBe("label");
  });

  it("strips <foreignObject> from rendered SVG", async () => {
    renderMock.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>html in svg</div></foreignObject><text>safe</text></svg>`,
    });
    document.body.innerHTML = placeholderHtml("graph TD; A");
    const { installDiagramHydrator } = await loadHydrator();
    installDiagramHydrator(document.body);
    const block = document.querySelector<HTMLElement>(".diagram-block")!;
    await waitFor(() => block.dataset.diagramState === "rendered");

    expect(block.querySelector("foreignObject")).toBeNull();
    expect(block.outerHTML).not.toMatch(/<foreignObject/i);
    expect(block.querySelector("text")?.textContent).toBe("safe");
  });

  it("preserves <style> elements inside Mermaid SVG", async () => {
    renderMock.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><style>.node{fill:red}</style><text>x</text></svg>`,
    });
    document.body.innerHTML = placeholderHtml("graph TD; A");
    const { installDiagramHydrator } = await loadHydrator();
    installDiagramHydrator(document.body);
    const block = document.querySelector<HTMLElement>(".diagram-block")!;
    await waitFor(() => block.dataset.diagramState === "rendered");

    expect(block.querySelector("style")).not.toBeNull();
  });

  it("reapplies only normalized same-origin SPA hrefs after sanitize", async () => {
    renderMock.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <a href="javascript:alert(1)"><text>js</text></a>
        <a href="https://evil.example.com/entry/foo"><text>external</text></a>
        <a xlink:href="../../etc/passwd"><text>traversal</text></a>
        <a href="alpha"><text>bare</text></a>
        <a href="/entry/beta"><text>direct</text></a>
      </svg>`,
    });
    document.body.innerHTML = placeholderHtml("graph TD; A-->B");
    const { installDiagramHydrator } = await loadHydrator();
    installDiagramHydrator(document.body);
    const block = document.querySelector<HTMLElement>(".diagram-block")!;
    await waitFor(() => block.dataset.diagramState === "rendered");

    const anchors = Array.from(block.querySelectorAll("a"));
    expect(anchors.length).toBe(5);
    const hrefs = anchors.map((a) => a.getAttribute("href"));
    expect(hrefs[0]).toBeNull();
    expect(hrefs[1]).toBeNull();
    expect(hrefs[2]).toBeNull();
    expect(hrefs[3]).toBe("/entry/alpha");
    expect(hrefs[4]).toBe("/entry/beta");
    expect(block.outerHTML).not.toContain("javascript:");
    expect(block.outerHTML).not.toContain("evil.example.com");
    expect(block.outerHTML).not.toContain("xlink:href");
  });

  it("rejects encoded traversal payloads in /entry/<segment> hrefs", async () => {
    renderMock.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><a href="/entry/%2e%2e%2Fraw"><text>encoded-traversal</text></a></svg>`,
    });
    document.body.innerHTML = placeholderHtml("graph TD; A");
    const { installDiagramHydrator } = await loadHydrator();
    installDiagramHydrator(document.body);
    const block = document.querySelector<HTMLElement>(".diagram-block")!;
    await waitFor(() => block.dataset.diagramState === "rendered");

    const anchor = block.querySelector("a");
    expect(anchor?.getAttribute("href")).toBeNull();
    expect(block.outerHTML).not.toContain("%2e%2e");
    expect(block.outerHTML).not.toContain("%2E%2E");
    expect(block.outerHTML).not.toContain("../raw");
  });

  it("rejects /entry/<segment> hrefs whose decoded id violates ENTRY_ID_PATTERN", async () => {
    renderMock.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><a href="/entry/foo%20bar"><text>space-id</text></a></svg>`,
    });
    document.body.innerHTML = placeholderHtml("graph TD; A");
    const { installDiagramHydrator } = await loadHydrator();
    installDiagramHydrator(document.body);
    const block = document.querySelector<HTMLElement>(".diagram-block")!;
    await waitFor(() => block.dataset.diagramState === "rendered");

    const anchor = block.querySelector("a");
    expect(anchor?.getAttribute("href")).toBeNull();
    expect(block.outerHTML).not.toContain("foo%20bar");
    expect(block.outerHTML).not.toContain("foo bar");
  });

  it("preserves Korean labels in rendered SVG text content", async () => {
    renderMock.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><g class="node"><text>문서 수집</text></g><g class="node"><text>검증 완료</text></g></svg>`,
    });
    document.body.innerHTML = placeholderHtml("graph TD\nA[문서 수집] --> B[검증 완료]");
    const { installDiagramHydrator } = await loadHydrator();
    installDiagramHydrator(document.body);
    const block = document.querySelector<HTMLElement>(".diagram-block")!;
    await waitFor(() => block.dataset.diagramState === "rendered");

    const texts = Array.from(block.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts).toContain("문서 수집");
    expect(texts).toContain("검증 완료");
  });

  it("source declares strict Mermaid config (static check)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("markdown/mermaid.ts", "utf8");
    expect(src).toMatch(/securityLevel:\s*["']strict["']/);
    expect(src).toMatch(/htmlLabels:\s*false/);
    expect(src).toMatch(/startOnLoad:\s*false/);
    expect(src).toMatch(/look:\s*["']handDrawn["']/);
    expect(src).toMatch(/useMaxWidth:\s*false/);
    expect(src).toMatch(/themeCSS:\s*buildThemeCss\(\)/);
  });

  it("source declares hand-drawn themeCSS overlay (static check)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("markdown/mermaid.ts", "utf8");
    expect(src).toMatch(/function\s+buildThemeCss\s*\(/);
    expect(src).toMatch(/--brass-deep/);
    expect(src).toMatch(/--aurora-deep/);
    expect(src).toMatch(/--surface-glass/);
    expect(src).toMatch(/--ink-pearl/);
    expect(src).toMatch(/Manrope/);
    expect(src).toMatch(/\.node\b/);
    expect(src).toMatch(/\.edgePath\b/);
  });

  it("confines parse errors to the failing .diagram-block via error state", async () => {
    renderMock.mockRejectedValue(new Error("Parse error: bad syntax"));
    document.body.innerHTML = `${placeholderHtml("invalid")}<p id="sibling">document text</p>`;
    const { installDiagramHydrator } = await loadHydrator();
    installDiagramHydrator(document.body);
    const block = document.querySelector<HTMLElement>(".diagram-block")!;
    await waitFor(() => block.dataset.diagramState === "error");

    expect(block.dataset.diagramState).toBe("error");
    expect(block.textContent).toContain("Parse error");
    expect(document.querySelector("#sibling")?.textContent).toBe("document text");
  });
});

describe("diagram lightbox lifecycle", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    renderMock.mockReset();
    initializeMock.mockReset();
  });

  it("does not hijack SVG anchor click or keyboard activation", async () => {
    const block = await renderDiagram(`<svg xmlns="http://www.w3.org/2000/svg"><a href="/entry/alpha"><text>alpha</text></a></svg>`);
    const anchor = block.querySelector<HTMLAnchorElement>("a[href]")!;
    let anchorClickObserved = false;
    anchor.addEventListener("click", () => {
      anchorClickObserved = true;
    });

    const clickAllowedDefault = dispatchCancelable(anchor, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    const enterAllowedDefault = dispatchCancelable(anchor, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));

    expect(anchorClickObserved).toBe(true);
    expect(clickAllowedDefault).toBe(true);
    expect(enterAllowedDefault).toBe(true);
    expect(document.querySelector(".diagram-lightbox")).toBeNull();
    expect(block.getAttribute("role")).toBeNull();
  });

  it("opens a native dialog from a real .diagram-block click", async () => {
    const restoreDialog = installDialogStub();
    try {
      const block = await renderDiagram(`<svg xmlns="http://www.w3.org/2000/svg"><text>plain</text></svg>`);

      block.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      const dialog = document.querySelector<HTMLDialogElement>("dialog.diagram-lightbox");

      expect(dialog).not.toBeNull();
      expect(dialog?.hasAttribute("open")).toBe(true);
      dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
      expect(document.querySelector("dialog.diagram-lightbox")).toBeNull();
    } finally {
      restoreDialog();
    }
  });

  it("retargets cloned SVG style selectors to the lightbox SVG id", async () => {
    const restoreDialog = installDialogStub();
    try {
      const block = await renderDiagram(`
        <svg id="mermaid-test-x" xmlns="http://www.w3.org/2000/svg">
          <style>#mermaid-test-x .probe { fill: red }</style>
          <text class="probe">styled</text>
        </svg>
      `);

      block.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      const dialog = document.querySelector<HTMLDialogElement>("dialog.diagram-lightbox");
      const clonedSvg = dialog?.querySelector<SVGElement>(".diagram-lightbox__viewport svg");
      const clonedStyle = clonedSvg?.querySelector("style");

      expect(dialog).not.toBeNull();
      expect(dialog?.hasAttribute("open")).toBe(true);
      expect(clonedSvg).not.toBeNull();
      expect(clonedSvg?.id).not.toBe("mermaid-test-x");
      expect(clonedStyle?.textContent).toContain(`#${clonedSvg?.id} .probe`);
      expect(clonedStyle?.textContent).not.toContain("#mermaid-test-x");
      dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    } finally {
      restoreDialog();
    }
  });

  it("zooms with controls, keyboard, and ctrl-wheel while plain wheel remains native scroll", async () => {
    const restoreDialog = installDialogStub();
    try {
      const block = await renderDiagram(`<svg id="mermaid-zoom" width="200" height="100" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg"><text>zoom</text></svg>`);

      block.click();
      const dialog = document.querySelector<HTMLDialogElement>("dialog.diagram-lightbox")!;
      const viewport = dialog.querySelector<HTMLElement>(".diagram-lightbox__viewport")!;
      const svg = viewport.querySelector<SVGElement>("svg")!;
      const zoomIn = dialog.querySelector<HTMLButtonElement>("[data-zoom-action='in']")!;
      const zoomOut = dialog.querySelector<HTMLButtonElement>("[data-zoom-action='out']")!;
      const reset = dialog.querySelector<HTMLButtonElement>("[data-zoom-action='reset']")!;
      const readout = dialog.querySelector<HTMLElement>(".diagram-lightbox__zoom-readout")!;
      setElementBox(viewport, 200, 100);

      const initialWidth = numberAttr(svg, "width");
      zoomIn.click();
      expect(numberAttr(svg, "width")).toBeGreaterThan(initialWidth);
      expect(readout.textContent).toBe("125%");

      zoomOut.click();
      expect(numberAttr(svg, "width")).toBeLessThan(250);
      expect(readout.textContent).toBe("100%");

      dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "+" }));
      expect(readout.textContent).toBe("125%");
      reset.click();
      expect(readout.textContent).toBe("100%");

      const plainWheelAllowed = dispatchCancelable(viewport, new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 }));
      expect(plainWheelAllowed).toBe(true);
      expect(readout.textContent).toBe("100%");

      const ctrlWheelAllowed = dispatchCancelable(viewport, new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 20, clientY: 20, ctrlKey: true, deltaY: -100 }));
      expect(ctrlWheelAllowed).toBe(false);
      expect(readout.textContent).toBe("125%");
      dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    } finally {
      restoreDialog();
    }
  });

  it("uses the clicked inline SVG rendered size as the lightbox zoom base", async () => {
    const restoreDialog = installDialogStub();
    try {
      const block = await renderDiagram(`<svg id="mermaid-inline-size" width="100%" height="100%" style="max-width: 400px;" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><text>inline size</text></svg>`);
      const inlineSvg = block.querySelector<SVGElement>("svg")!;
      inlineSvg.getBoundingClientRect = () =>
        ({
          bottom: 420,
          height: 420,
          left: 0,
          right: 760,
          top: 0,
          width: 760,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;

      block.click();
      const dialog = document.querySelector<HTMLDialogElement>("dialog.diagram-lightbox")!;
      const clonedSvg = dialog.querySelector<SVGElement>(".diagram-lightbox__viewport svg")!;
      const reset = dialog.querySelector<HTMLButtonElement>("[data-zoom-action='reset']")!;

      expect(inlineSvg.getAttribute("style")).toBe("max-width: 400px;");
      expect(clonedSvg.getAttribute("style")).toBeNull();
      reset.click();
      expect(clonedSvg.getAttribute("width")).toBe("760");
      expect(clonedSvg.getAttribute("height")).toBe("420");
      dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    } finally {
      restoreDialog();
    }
  });

  it("recomputes Fit on resize and pans by pointer drag", async () => {
    const restoreDialog = installDialogStub();
    try {
      const block = await renderDiagram(`<svg id="mermaid-pan" width="400" height="200" viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg"><text>pan</text></svg>`);

      block.click();
      const dialog = document.querySelector<HTMLDialogElement>("dialog.diagram-lightbox")!;
      const viewport = dialog.querySelector<HTMLElement>(".diagram-lightbox__viewport")!;
      const svg = viewport.querySelector<SVGElement>("svg")!;
      setElementBox(viewport, 200, 100);

      window.dispatchEvent(new Event("resize"));
      expect(svg.getAttribute("width")).toBe("200");
      expect(svg.getAttribute("height")).toBe("100");

      viewport.scrollLeft = 50;
      viewport.scrollTop = 25;
      dispatchCancelable(viewport, pointerEvent("pointerdown", { button: 0, clientX: 100, clientY: 80, pointerId: 7 }));
      dispatchCancelable(viewport, pointerEvent("pointermove", { button: 0, clientX: 80, clientY: 60, pointerId: 7 }));
      expect(viewport.scrollLeft).toBe(70);
      expect(viewport.scrollTop).toBe(45);
      dispatchCancelable(viewport, pointerEvent("pointerup", { button: 0, clientX: 80, clientY: 60, pointerId: 7 }));
      dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    } finally {
      restoreDialog();
    }
  });

  it("fits small diagrams above 100% when the viewport has room", async () => {
    const restoreDialog = installDialogStub();
    try {
      const block = await renderDiagram(`<svg id="mermaid-small" width="400" height="300" viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg"><text>small</text></svg>`);

      block.click();
      const dialog = document.querySelector<HTMLDialogElement>("dialog.diagram-lightbox")!;
      const viewport = dialog.querySelector<HTMLElement>(".diagram-lightbox__viewport")!;
      const svg = viewport.querySelector<SVGElement>("svg")!;
      const readout = dialog.querySelector<HTMLElement>(".diagram-lightbox__zoom-readout")!;
      setElementBox(viewport, 1200, 700);

      window.dispatchEvent(new Event("resize"));
      expect(numberAttr(svg, "width")).toBeGreaterThan(400);
      expect(numberAttr(svg, "height")).toBeGreaterThan(300);
      expect(readout.textContent).toBe("200%");
      dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    } finally {
      restoreDialog();
    }
  });

  it("removes pan/zoom listeners after lightbox close", async () => {
    const restoreDialog = installDialogStub();
    const elementAddSpy = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const elementRemoveSpy = vi.spyOn(HTMLElement.prototype, "removeEventListener");
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const windowRemoveSpy = vi.spyOn(window, "removeEventListener");
    try {
      const block = await renderDiagram(`<svg width="200" height="100" xmlns="http://www.w3.org/2000/svg"><text>cleanup</text></svg>`);

      block.click();
      dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));

      expect(elementAddSpy.mock.calls.filter(([type]) => type === "pointerdown").length).toBeGreaterThanOrEqual(1);
      expect(elementRemoveSpy.mock.calls.filter(([type]) => type === "pointerdown").length).toBeGreaterThanOrEqual(1);
      expect(elementRemoveSpy.mock.calls.filter(([type]) => type === "wheel").length).toBeGreaterThanOrEqual(1);
      expect(windowAddSpy.mock.calls.filter(([type]) => type === "resize").length).toBe(1);
      expect(windowRemoveSpy.mock.calls.filter(([type]) => type === "resize").length).toBe(1);
    } finally {
      elementAddSpy.mockRestore();
      elementRemoveSpy.mockRestore();
      windowAddSpy.mockRestore();
      windowRemoveSpy.mockRestore();
      restoreDialog();
    }
  });

  it("still opens the lightbox when a link wraps an entire nested SVG", async () => {
    const block = await renderDiagram(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <a href="/entry/wrapped"><svg><text>wrapped diagram</text></svg></a>
      </svg>
    `);
    const wrappedText = block.querySelector<SVGTextElement>("a[href] svg text")!;

    const clickAllowedDefault = dispatchCancelable(wrappedText, new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    expect(clickAllowedDefault).toBe(false);
    expect(document.querySelector(".diagram-lightbox")).not.toBeNull();
    dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
  });

  it("keeps button semantics only for diagrams without focusable SVG links", async () => {
    const block = await renderDiagram(`<svg xmlns="http://www.w3.org/2000/svg"><text>plain</text></svg>`);

    expect(block.getAttribute("role")).toBe("button");
    expect(block.tabIndex).toBe(0);
  });

  it("traps focus, closes on Escape, and restores inert state plus trigger focus", async () => {
    const block = await renderDiagram(`<svg xmlns="http://www.w3.org/2000/svg"><text>plain</text></svg>`);
    const appShell = document.querySelector<HTMLElement>("#app-shell")!;
    appShell.setAttribute("aria-hidden", "legacy-hidden");
    appShell.inert = false;

    block.focus();
    block.click();
    const dialog = document.querySelector<HTMLElement>(".diagram-lightbox")!;
    const closeButton = dialog.querySelector<HTMLButtonElement>(".diagram-lightbox__close")!;
    const firstZoomButton = dialog.querySelector<HTMLButtonElement>("[data-zoom-action='out']")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(appShell.inert).toBe(true);
    expect(appShell.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(closeButton);

    const tabAllowedDefault = dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" }));
    expect(tabAllowedDefault).toBe(false);
    expect(document.activeElement).toBe(firstZoomButton);

    const shiftTabAllowedDefault = dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab", shiftKey: true }));
    expect(shiftTabAllowedDefault).toBe(false);
    expect(document.activeElement).toBe(closeButton);

    const escapeAllowedDefault = dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    expect(escapeAllowedDefault).toBe(false);
    expect(document.querySelector(".diagram-lightbox")).toBeNull();
    expect(appShell.inert).toBe(false);
    expect(appShell.getAttribute("aria-hidden")).toBe("legacy-hidden");
    expect(document.activeElement).toBe(block);
  });

  it("closes on outside click and removes keydown listeners across repeated open/close cycles", async () => {
    const block = await renderDiagram(`<svg xmlns="http://www.w3.org/2000/svg"><text>plain</text></svg>`);
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    block.click();
    const firstDialog = document.querySelector<HTMLElement>(".diagram-lightbox")!;
    firstDialog.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(document.querySelector(".diagram-lightbox")).toBeNull();

    block.click();
    dispatchCancelable(document, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    expect(document.querySelector(".diagram-lightbox")).toBeNull();

    const addedKeydown = addSpy.mock.calls.filter(([type]) => type === "keydown").length;
    const removedKeydown = removeSpy.mock.calls.filter(([type]) => type === "keydown").length;
    expect(addedKeydown).toBe(2);
    expect(removedKeydown).toBe(2);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("cleans up the lightbox when the trigger unmounts during route transitions", async () => {
    const block = await renderDiagram(`<svg xmlns="http://www.w3.org/2000/svg"><text>plain</text></svg>`);
    const appShell = document.querySelector<HTMLElement>("#app-shell")!;
    appShell.inert = false;

    block.click();
    expect(document.querySelector(".diagram-lightbox")).not.toBeNull();

    block.remove();
    appShell.append(document.createElement("p"));
    await waitFor(() => document.querySelector(".diagram-lightbox") === null);

    expect(appShell.inert).toBe(false);
    expect(appShell.getAttribute("aria-hidden")).toBeNull();
  });
});

describe("cssColorToHex (pure-JS oklch converter)", () => {
  it("converts percent-formatted oklch to a 7-char #rrggbb hex", async () => {
    const { cssColorToHex } = await import("@fleet-console/markdown/mermaid");
    const result = cssColorToHex("oklch(58% 0.13 200)");
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("converts decimal-formatted oklch lightness to a 7-char #rrggbb hex", async () => {
    const { cssColorToHex } = await import("@fleet-console/markdown/mermaid");
    const result = cssColorToHex("oklch(0.78 0.13 75)");
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("emits 8-bit alpha as #rrggbbaa when alpha < 1", async () => {
    const { cssColorToHex } = await import("@fleet-console/markdown/mermaid");
    const result = cssColorToHex("oklch(82% 0.13 195 / 28%)");
    expect(result).toMatch(/^#[0-9a-f]{8}$/);
    const alphaByte = parseInt(result.slice(7, 9), 16);
    expect(alphaByte).toBe(Math.round(0.28 * 255));
  });

  it("renders Maritime Codex --ink-pearl (oklch(96% 0.012 88)) as a near-white hex", async () => {
    const { cssColorToHex } = await import("@fleet-console/markdown/mermaid");
    const result = cssColorToHex("oklch(96% 0.012 88)");
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
    const r = parseInt(result.slice(1, 3), 16);
    const g = parseInt(result.slice(3, 5), 16);
    const b = parseInt(result.slice(5, 7), 16);
    expect(r).toBeGreaterThanOrEqual(0xd0);
    expect(g).toBeGreaterThanOrEqual(0xd0);
    expect(b).toBeGreaterThanOrEqual(0xd0);
  });

  it("passes hex input through unchanged", async () => {
    const { cssColorToHex } = await import("@fleet-console/markdown/mermaid");
    expect(cssColorToHex("#ff0000")).toBe("#ff0000");
  });

  it("leaves non-oklch CSS values unchanged", async () => {
    const { cssColorToHex } = await import("@fleet-console/markdown/mermaid");
    expect(cssColorToHex("transparent")).toBe("transparent");
    expect(cssColorToHex("inherit")).toBe("inherit");
    expect(cssColorToHex("rgb(12, 34, 56)")).toBe("rgb(12, 34, 56)");
  });

  it("returns the trimmed input for empty/whitespace values", async () => {
    const { cssColorToHex } = await import("@fleet-console/markdown/mermaid");
    expect(cssColorToHex("")).toBe("");
    expect(cssColorToHex("   ")).toBe("");
  });

  it("returns the original input when the oklch payload fails to parse", async () => {
    const { cssColorToHex } = await import("@fleet-console/markdown/mermaid");
    expect(cssColorToHex("oklch(invalid)")).toBe("oklch(invalid)");
  });
});
