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
});
