// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeMermaidSource } from "../client/src/markdown/renderer";

interface InstalledHydrator {
  installDiagramHydrator: (root: ParentNode) => void;
}

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
  return (await import("../client/src/markdown/diagrams")) as unknown as InstalledHydrator;
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
    const src = await fs.readFile("client/src/markdown/diagrams.ts", "utf8");
    expect(src).toMatch(/securityLevel:\s*["']strict["']/);
    expect(src).toMatch(/htmlLabels:\s*false/);
    expect(src).toMatch(/startOnLoad:\s*false/);
    expect(src).toMatch(/look:\s*["']handDrawn["']/);
    expect(src).toMatch(/themeCSS:\s*buildThemeCss\(\)/);
  });

  it("source declares hand-drawn themeCSS overlay (static check)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("client/src/markdown/diagrams.ts", "utf8");
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

describe("cssColorToHex (pure-JS oklch converter)", () => {
  it("converts percent-formatted oklch to a 7-char #rrggbb hex", async () => {
    const { cssColorToHex } = await import("../client/src/markdown/diagrams");
    const result = cssColorToHex("oklch(58% 0.13 200)");
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("converts decimal-formatted oklch lightness to a 7-char #rrggbb hex", async () => {
    const { cssColorToHex } = await import("../client/src/markdown/diagrams");
    const result = cssColorToHex("oklch(0.78 0.13 75)");
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("emits 8-bit alpha as #rrggbbaa when alpha < 1", async () => {
    const { cssColorToHex } = await import("../client/src/markdown/diagrams");
    const result = cssColorToHex("oklch(82% 0.13 195 / 28%)");
    expect(result).toMatch(/^#[0-9a-f]{8}$/);
    const alphaByte = parseInt(result.slice(7, 9), 16);
    expect(alphaByte).toBe(Math.round(0.28 * 255));
  });

  it("renders Maritime Codex --ink-pearl (oklch(96% 0.012 88)) as a near-white hex", async () => {
    const { cssColorToHex } = await import("../client/src/markdown/diagrams");
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
    const { cssColorToHex } = await import("../client/src/markdown/diagrams");
    expect(cssColorToHex("#ff0000")).toBe("#ff0000");
  });

  it("leaves non-oklch CSS values unchanged", async () => {
    const { cssColorToHex } = await import("../client/src/markdown/diagrams");
    expect(cssColorToHex("transparent")).toBe("transparent");
    expect(cssColorToHex("inherit")).toBe("inherit");
    expect(cssColorToHex("rgb(12, 34, 56)")).toBe("rgb(12, 34, 56)");
  });

  it("returns the trimmed input for empty/whitespace values", async () => {
    const { cssColorToHex } = await import("../client/src/markdown/diagrams");
    expect(cssColorToHex("")).toBe("");
    expect(cssColorToHex("   ")).toBe("");
  });

  it("returns the original input when the oklch payload fails to parse", async () => {
    const { cssColorToHex } = await import("../client/src/markdown/diagrams");
    expect(cssColorToHex("oklch(invalid)")).toBe("oklch(invalid)");
  });
});
