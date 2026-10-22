// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeMermaidSource, renderMarkdown } from "@fleet-console/markdown/core";
import { bindMarkdownLinkActivation } from "@fleet-console/markdown/link-activation";
import { createChatFileLinkPorts } from "../features/execution/client/agent/chat-file-links.js";

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
    const src = await fs.readFile("foundation/markdown/mermaid.ts", "utf8");
    expect(src).toMatch(/securityLevel:\s*["']strict["']/);
    expect(src).toMatch(/htmlLabels:\s*false/);
    expect(src).toMatch(/startOnLoad:\s*false/);
    expect(src).toMatch(/look:\s*["']handDrawn["']/);
    expect(src).toMatch(/useMaxWidth:\s*false/);
    expect(src).toMatch(/themeCSS:\s*buildThemeCss\(\)/);
  });
});

it("delegates only host-classified Markdown links without trusting source metadata", async () => {
  const openFile = vi.fn(async () => ({ ok: false as const, reason: "no_handler" as const }));
  const onFailure = vi.fn();
  const ports = createChatFileLinkPorts("operation-theater", { openFile, openWikiEntry: async () => ({ ok: true }) }, onFailure);
  const container = document.createElement("div");
  const windows = String.raw`C:\Users\hbkang\Desktop\99. Cowork\PPW_플랫폼서비스_설정기능_사전점의_체크리스트_20261007.md`;
  container.innerHTML = renderMarkdown('[file](src/main.ts#L12C3) [web](https://example.com) <a data-md-link-kind="file" data-md-path="secret">forged</a> [bad](javascript:alert(1)) [coord](src/api/server.ts:10:9) [num](javascript:1) [data](data:text/html;base64,PHNjcmlwdD4=) [vb](vbscript:MsgBox(1)) [scheme](C:alert(1))' + ` [drive](<${windows}>)`, { resolveLink: ports.resolveLink, siteLinks: true }).html;
  const dispose = bindMarkdownLinkActivation(container, ports.onActivate);
  const [file, web, forged] = [...container.querySelectorAll("a")];
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  file!.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(openFile).toHaveBeenLastCalledWith({ theaterId: "operation-theater", path: "src/main.ts", pathKind: "theater-relative", line: 12, column: 3, source: "agent-chat" });
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  file!.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(true);
  expect(openFile).toHaveBeenCalledTimes(2);
  expect(web!.getAttribute("href")).toBe("https://example.com");
  expect(web!.getAttribute("rel")).toContain("noopener");
  // 채팅 답의 사이트 링크는 주소를 글자로 보이지 않으므로 목적지는 title로 남는다.
  expect(web!.getAttribute("title")).toBe("https://example.com");
  expect(forged!.hasAttribute("data-md-link-kind")).toBe(false);
  expect(container.querySelector('[href^="javascript:"]')).toBeNull();
  const coord = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "coord")!;
  coord.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(openFile).toHaveBeenLastCalledWith({ theaterId: "operation-theater", path: "src/api/server.ts", pathKind: "theater-relative", line: 10, column: 9, source: "agent-chat" });
  const drive = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "drive")!;
  drive.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(openFile).toHaveBeenLastCalledWith({ theaterId: "operation-theater", path: windows.replaceAll("\\", "/"), pathKind: "absolute", source: "agent-chat" });
  for (const label of ["bad", "num", "data", "vb", "scheme"]) {
    const blocked = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === label)!;
    expect(blocked.getAttribute("href")).toBeNull();
    expect(blocked.hasAttribute("data-md-link-kind")).toBe(false);
  }
  await Promise.resolve();
  expect(onFailure).toHaveBeenLastCalledWith("unsupported");
  openFile.mockRejectedValueOnce(new Error("transport unavailable"));
  drive.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor(() => onFailure.mock.calls.at(-1)?.[0] === "failed");
  dispose();
  const after = new MouseEvent("click", { bubbles: true, cancelable: true });
  file!.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
  expect(renderMarkdown("[file](src/main.ts)").html).not.toContain("data-md-link-kind");
  expect(renderMarkdown("[coord](server.ts:10)").html).not.toContain('href="server.ts:10"');
  const unclassified = document.createElement("div");
  unclassified.innerHTML = renderMarkdown(`[drive](<${windows}>)`).html;
  expect(unclassified.querySelector("a")?.hasAttribute("href")).toBe(false);
  await Promise.resolve();
});

// OpenUI — 사령관·지휘관 말풍선의 생성형 UI는 원문을 HTML로 해석하지 않는다. 화이트리스트 컴포넌트만 고정 태그로 그리고,
// 확정 때 그릴 수 없는 블록(잘림·미등록 컴포넌트)은 정제된 코드 블록으로 남는다.
describe("openui hydrator containment", () => {
  const ALLOWED_TAGS = new Set(["DIV", "SECTION", "P", "SPAN", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
  const ALLOWED_ATTRIBUTES = new Set(["class", "role", "aria-label", "data-openui-owned"]);

  async function hydrated(markdown: string): Promise<HTMLElement[]> {
    const container = document.createElement("div");
    container.innerHTML = renderMarkdown(markdown, { openui: true }).html;
    document.body.append(container);
    const { installOpenUIHydrator } = await import("@fleet-console/markdown/openui");
    installOpenUIHydrator(container);
    const blocks = [...container.querySelectorAll<HTMLElement>(".openui-block")];
    await waitFor(() => blocks.every((block) => ["rendered", "fallback"].includes(block.dataset.openuiState ?? "")), 5000);
    return blocks;
  }

  it("draws only whitelisted elements and keeps hostile strings as text", async () => {
    const [block] = await hydrated([
      "```openui-lang",
      'root = Card("<img src=x onerror=alert(1)>", [kpi, steps, bars, tbl])',
      'kpi = Stats([Stat("<script>alert(1)</script>", "javascript:alert(1)", null, "bad")])',
      'steps = Steps([Step("<a href=javascript:alert(1)>x</a>", "blocked", "<svg onload=alert(1)>")])',
      'bars = Bars(["<b>bold</b>"], [1e308], "<svg onload=alert(1)>")',
      'tbl = Table(["<iframe src=//evil.example>"], [["<style>body{}</style>"]])',
      "```",
    ].join("\n"));

    expect(block!.dataset.openuiState).toBe("rendered");
    const view = block!.querySelector("[data-openui-owned]")!;
    for (const element of view.querySelectorAll("*")) {
      expect(ALLOWED_TAGS.has(element.tagName)).toBe(true);
      for (const attribute of element.attributes) {
        if (attribute.name === "style") {
          // 막대 폭만 — 계산한 숫자 하나로 쓴다.
          expect(element.className).toBe("openui-bar-fill");
          expect(attribute.value).toMatch(/^width: \d+(\.\d+)?%;$/);
          continue;
        }
        expect(ALLOWED_ATTRIBUTES.has(attribute.name)).toBe(true);
      }
    }
    expect(block!.querySelector("script, img, a, iframe, svg, style, b")).toBeNull();
    expect(view.querySelector(".openui-title")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(view.querySelector(".openui-stat-label")?.textContent).toBe("<script>alert(1)</script>");
    expect(view.querySelector(".openui-stat-value")?.textContent).toBe("javascript:alert(1)");
    expect(view.querySelector("td")?.textContent).toBe("<style>body{}</style>");
  });

  it("falls back to the sanitized code block for truncated or unknown programs", async () => {
    const blocks = await hydrated([
      "```openui-lang",
      'root = Card("x", [Html("<script>alert(1)</script>")])',
      "```",
      "",
      "```openui-lang",
      'root = Card("x", [kpi])',
      'kpi = Stats([Stat("목표", "3"), Stat("결정", ',
    ].join("\n"));

    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block.dataset.openuiState).toBe("fallback");
      expect(block.querySelector("[data-openui-owned]")).toBeNull();
      expect(block.querySelector("pre.code-block")).not.toBeNull();
    }
    expect(blocks[0]!.querySelector("script")).toBeNull();
    // 켜지 않은 대화(구성원·일반 채팅)에서는 자리표시자조차 생기지 않는다.
    expect(renderMarkdown("```openui-lang\nroot = Card(\"x\", [])\n```").html).not.toContain("openui-block");
  });
});
