// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeMermaidSource, renderMarkdown } from "@fleet-console/markdown/core";
import type { OpenUIOpenPort } from "@fleet-console/markdown/openui";
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
// 확정 때 그릴 수 없는 블록(잘림·미등록 컴포넌트)은 정제된 코드 블록으로 남는다. 답·열기 단추는 사람의 클릭으로만 전송·열기 포트에 닿는다.
describe("openui hydrator containment", () => {
  const ALLOWED_TAGS = new Set(["DIV", "SECTION", "P", "SPAN", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "svg", "path"]);
  const ALLOWED_ATTRIBUTES = new Set(["class", "role", "aria-label", "aria-busy", "aria-hidden", "data-openui-owned", "viewBox", "preserveAspectRatio", "d", "fill", "vector-effect", "focusable"]);
  const containers = new Set<HTMLElement>();

  afterEach(async () => {
    const { releaseOpenUIHydrator } = await import("@fleet-console/markdown/openui");
    for (const container of containers) {
      releaseOpenUIHydrator(container);
      container.remove();
    }
    containers.clear();
    await Promise.resolve();
  });

  async function hydrated(markdown: string, options: { readonly streaming?: boolean; readonly reply?: (text: string) => void; readonly open?: OpenUIOpenPort } = {}): Promise<HTMLElement[]> {
    const container = document.createElement("div");
    container.innerHTML = renderMarkdown(markdown, { openui: true, ...(options.streaming ? { deferUnclosedMermaid: true } : {}) }).html;
    document.body.append(container);
    containers.add(container);
    const { installOpenUIHydrator } = await import("@fleet-console/markdown/openui");
    installOpenUIHydrator(container, undefined, options.reply, options.open);
    const blocks = [...container.querySelectorAll<HTMLElement>(".openui-block")];
    await waitFor(() => blocks.every((block) => block.dataset.openuiState === "fallback" || (block.dataset.openuiState === "rendered" && block.querySelector("section.openui") !== null)), 5000);
    return blocks;
  }

  it("draws only whitelisted elements and keeps hostile strings as text", async () => {
    const [block, staticBlock] = await hydrated([
      "```openui-lang",
      'root = Card("<img src=x onerror=alert(1)>", [kpi, steps, bars, tbl, facts, note, prog])',
      'kpi = Stats([Stat("<script>alert(1)</script>", "javascript:alert(1)", null, "bad")])',
      'steps = Steps([Step("<a href=javascript:alert(1)>x</a>", "blocked", "<svg onload=alert(1)>")])',
      'bars = Bars(["<b>bold</b>"], [1e308], "<svg onload=alert(1)>")',
      'tbl = Table(["<iframe src=//evil.example>"], [["<style>body{}</style>"]])',
      'facts = Facts([Fact("<img src=x>", "<script>alert(2)</script>", "good")])',
      'note = Callout("<a href=javascript:alert(2)>x</a>", "warn")',
      'prog = Progress("<b>p</b>", 3, 5, "<iframe src=//evil.example>")',
      "```",
      "",
      "```openui-lang",
      'root = Card("정적", [timeline, compare, tags, sparks])',
      'timeline = Timeline([Moment("<img src=x>", "<script>x</script>", "done", "<svg onload=x>")])',
      'compare = Compare("<img src=x>", "<script>x</script>", [Delta("<b>x</b>", "<iframe>", "<svg onload=x>", "good")])',
      'tags = Tags([Tag("<script>x</script>", "bad")])',
      'sparks = Sparklines([Sparkline("<b>x</b>", [1, -1e15, 3], "<svg>")])',
      "```",
    ].join("\n"));

    expect(block!.dataset.openuiState).toBe("rendered");
    const view = block!.querySelector("[data-openui-owned]")!;
    expect(staticBlock!.dataset.openuiState).toBe("rendered");
    for (const element of [...view.querySelectorAll("*"), ...staticBlock!.querySelectorAll("[data-openui-owned] *")]) {
      expect(ALLOWED_TAGS.has(element.tagName)).toBe(true);
      for (const attribute of element.attributes) {
        if (attribute.name === "style") {
          if (element.className === "openui-content") {
            // Renderer.Content의 고정 감싸개만 — 모델이 준 style은 통과하지 않는다.
            expect([...((element as HTMLElement).style)]).toEqual(["opacity", "transition"]);
            expect((element as HTMLElement).style.opacity).toBe("1");
          } else {
            // 막대 폭만 — 계산한 숫자 하나로 쓴다.
            expect(element.className).toBe("openui-bar-fill");
            expect(attribute.value).toMatch(/^width: \d+(\.\d+)?%;$/);
          }
          continue;
        }
        expect(ALLOWED_ATTRIBUTES.has(attribute.name)).toBe(true);
      }
    }
    expect(block!.querySelector("script, img, a, iframe, svg, style, b")).toBeNull();
    expect(staticBlock!.querySelector("script, img, a, iframe, style, b")).toBeNull();
    expect(staticBlock!.querySelectorAll("svg")).toHaveLength(1);
    expect(staticBlock!.querySelector("svg")?.classList.contains("openui-spark")).toBe(true);
    expect(staticBlock!.querySelector("path")?.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+( C(-?[\d.]+ ){5}-?[\d.]+)+$/);
    expect(staticBlock!.querySelector(".openui-moment-label")?.textContent).toBe("<script>x</script>");
    expect(staticBlock!.querySelector(".openui-delta-value")?.textContent).toBe("<iframe>");
    expect(staticBlock!.querySelector(".openui-tags .openui-tag")?.firstChild?.textContent).toBe("<script>x</script>");
    expect(view.querySelector(".openui-title")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(view.querySelector(".openui-stat-label")?.textContent).toBe("<script>alert(1)</script>");
    expect(view.querySelector(".openui-stat-value")?.lastChild?.textContent).toBe("javascript:alert(1)");
    expect(view.querySelector("td")?.textContent).toBe("<style>body{}</style>");
    expect(view.querySelector(".openui-fact-value")?.lastChild?.textContent).toBe("<script>alert(2)</script>");
    expect(view.querySelector(".openui-callout-text")?.textContent).toBe("<a href=javascript:alert(2)>x</a>");
    expect(view.querySelector(".openui-progress-note")?.textContent).toBe("<iframe src=//evil.example>");
  });

  it("falls back to the sanitized code block for truncated or unknown programs", async () => {
    const blocks = await hydrated([
      "```openui-lang",
      'root = Card("x", [Html("<script>alert(1)</script>")])',
      "```",
      "",
      ...[
        'root = Card("x", [Moment("14:02", "x")])',
        'root = Card("x", [Sparklines([Sparkline("x", [1])])])',
        `root = Card("x", [Tags([${Array.from({ length: 13 }, () => 'Tag("x")').join(", ")}])])`,
      ].flatMap((source) => ["```openui-lang", source, "```", ""]),
      "```openui-lang",
      'root = Card("x", [kpi])',
      'kpi = Stats([Stat("목표", "3"), Stat("결정", ',
    ].join("\n"));

    expect(blocks).toHaveLength(5);
    for (const block of blocks) {
      expect(block.dataset.openuiState).toBe("fallback");
      expect(block.querySelector("[data-openui-owned]")).toBeNull();
      expect(block.querySelector("pre.code-block")).not.toBeNull();
    }
    expect(blocks[0]!.querySelector("script")).toBeNull();
    // 켜지 않은 대화(구성원·일반 채팅)에서는 자리표시자조차 생기지 않는다.
    expect(renderMarkdown("```openui-lang\nroot = Card(\"x\", [])\n```").html).not.toContain("openui-block");
  });

  // 답 전송은 사람의 클릭으로만 일어나야 한다 — 그리기·스크립트 click·흐르는 중 블록은 포트에 닿지 않는다.
  // jsdom은 사람의 클릭(isTrusted)을 만들 수 없으므로 1회 전송·중복 방지 양성 경로는 실앱 검증이 맡는다.
  it("lets answer buttons reach the reply port only through a person's click on a finished block", async () => {
    const reply = vi.fn();
    const choices = 'c = Choices([Choice("A · 시안", "A로 가 주세요"), Choice("<b>B</b>", "<img src=x onerror=alert(1)>")])';
    const [finished] = await hydrated(["```openui-lang", 'root = Card("다음", [c])', choices, "```"].join("\n"), { reply });

    expect(finished!.dataset.openuiState).toBe("rendered");
    const buttons = [...finished!.querySelectorAll<HTMLButtonElement>("button.openui-button")];
    expect(buttons.map((button) => [button.textContent, button.title, button.disabled])).toEqual([
      ["A · 시안", "A로 가 주세요", false],
      ["<b>B</b>", "<img src=x onerror=alert(1)>", false],
    ]);
    expect(finished!.querySelector("b, img")).toBeNull();
    buttons[0]!.click();
    buttons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(reply).not.toHaveBeenCalled();

    // 입력창이 없는 자리(포트 없음)는 정적 칩, 흐르는 중인 블록은 잠긴다.
    const [readOnly] = await hydrated(["```openui-lang", 'root = Card("다음", [c])', choices, "```"].join("\n"));
    expect([...readOnly!.querySelectorAll("button.openui-button")].every((button) => button.getAttribute("aria-disabled") === "true")).toBe(true);
    const [streaming] = await hydrated(["```openui-lang", 'root = Card("다음", [c])', choices].join("\n"), { streaming: true, reply });
    expect(streaming!.getAttribute("data-openui-final")).toBe("0");
    expect([...streaming!.querySelectorAll<HTMLButtonElement>("button.openui-button")].every((button) => button.disabled)).toBe(true);

    const decision = 'root = Card("결정", [Choices([Choice("A", "A로 진행", "짧은 이유", "결과"), Choice("B", "B로 진행")])])';
    const [options] = await hydrated(["```openui-lang", decision, "```"].join("\n"), { reply });
    expect(options!.querySelectorAll(".openui-option")).toHaveLength(2);
    expect(options!.querySelector<HTMLButtonElement>(".openui-option")?.title).toBe("A로 진행");
    options!.querySelector<HTMLButtonElement>(".openui-option")!.click();
    const refused = await hydrated([
      ["```openui-lang", 'root = Card("x", [Choices([Choice("명령", "/clear"), Choice("B", "B")])])', "```"].join("\n"),
      ["```openui-lang", 'root = Card("x", [Choices([Choice("멘션", "확인 @누군가"), Choice("B", "B")])])', "```"].join("\n"),
      ["```openui-lang", `root = Card("x", [Choices([Choice("A", "A", "${"가".repeat(121)}"), Choice("B", "B")])])`, "```"].join("\n"),
      ["```openui-lang", `root = Card("x", [Choices([Choice("긴 답", "${"가".repeat(201)}"), Choice("B", "B")])])`, "```"].join("\n"),
    ].join("\n\n"));
    expect(refused.map((block) => block.dataset.openuiState)).toEqual(["fallback", "fallback", "fallback", "fallback"]);
    expect(reply).not.toHaveBeenCalled();

    // 말 속 원시 HTML의 표식을 정제가 걷는다. 정제를 우회해 소유 칸 안에 들어온 위조 단추도 React 클릭 클로저가 없다.
    const source = encodeMermaidSource(['root = Card("다음", [c])', choices].join("\n"));
    const forged = `<div class="openui-block" data-openui-source="${source}" data-openui-final="1" data-openui-state="rendered"><button class="openui-button" data-openui-reply="/clear">X</button></div>`;
    const sanitized = renderMarkdown(forged, { openui: true }).html;
    expect(sanitized).not.toContain("openui-block");
    expect(sanitized).not.toContain("openui-button");
    expect(sanitized).not.toContain("data-openui-reply");
    expect(renderMarkdown('<button class="openui-button">위조 열기</button>', { openui: true }).html).not.toContain("openui-button");
    const fake = document.createElement("button");
    fake.className = "openui-button";
    fake.title = "/clear";
    fake.textContent = "X";
    finished!.querySelector("[data-openui-owned]")!.append(fake);
    expect(fake.disabled).toBe(false);
    fake.click();
    expect(reply).not.toHaveBeenCalled();
  });

  it("contains single-step open actions and never opens from drawing or synthetic clicks", async () => {
    const open = { accepts: vi.fn(() => true), open: vi.fn() };
    const source = 'root = Card("열기", [Button("PR", @OpenUrl("https://github.com/o/r/pull/1")), Button("목표", @OpenUrl("objective:01234567-89ab-cdef-0123-456789abcdef")), Button("미션", @OpenUrl("mission:2"))])';
    const [block] = await hydrated(["```openui-lang", source, "```"].join("\n"), { open });
    expect(block!.dataset.openuiState).toBe("rendered");
    const buttons = [...block!.querySelectorAll<HTMLButtonElement>("button.openui-button")];
    expect(buttons).toHaveLength(3);
    expect(buttons[0]!.textContent).toContain("github.com");
    expect(buttons[0]!.title).toBe("https://github.com/o/r/pull/1");
    expect(block!.querySelector("a, [href], form, [target]")).toBeNull();
    buttons.forEach((button) => button.click());
    expect(open.open).not.toHaveBeenCalled();
    const [inert] = await hydrated(["```openui-lang", source, "```"].join("\n"));
    expect(inert!.querySelectorAll(".openui-inert")).toHaveLength(3);
    expect(inert!.querySelector("[data-openui-owned] button")).toBeNull();
    const [streaming] = await hydrated(["```openui-lang", source].join("\n"), { streaming: true, open });
    expect([...streaming!.querySelectorAll<HTMLButtonElement>("[data-openui-owned] button")].every((button) => button.disabled)).toBe(true);
    const refused = await hydrated([
      ...["javascript:alert(1)", "http://example.com/", "https://github.com@evil.example/x", "https://GitHub.com/"].map((target) => `root = Card("x", [Button("X", @OpenUrl(${JSON.stringify(target)}))])`),
      'root = Card("x", [Button("X", @Run("anything"))])',
      'root = Card("x", [Button("X", Action([@ToAssistant("X"), @OpenUrl("https://example.com/")]))])',
      'root = Card("x", [Button("X", @ToAssistant("X", {secret: "hidden"}))])',
    ].map((program) => ["```openui-lang", program, "```"].join("\n")).join("\n\n"), { open });
    expect(refused.every((candidate) => candidate.dataset.openuiState === "fallback")).toBe(true);
    expect(open.open).not.toHaveBeenCalled();
  });

  it("composes form messages as one-pass plain text without implicit or synthetic submission", async () => {
    const { composeDraft, sendableDraft } = await import("@fleet-console/markdown/openui");
    expect(composeDraft("PR {a} 확인", new Map([["a", "{b} $& \n/clear"]]))).toBe("PR {b} $& /clear 확인");
    expect(sendableDraft("확인 @누군가")).toBeNull();
    const reply = vi.fn();
    const source = 'root = Card("입력", [Form([Input("pr", "PR"), Select("mode", "방식", ["병합", "대기"])], "PR {pr}을 {mode}", "보내기")])';
    const [block] = await hydrated(["```openui-lang", source, "```"].join("\n"), { reply });
    expect(block!.querySelector("form, input[name], input[id], [action], [target]")).toBeNull();
    const input = block!.querySelector<HTMLInputElement>("input")!;
    expect(input.type).toBe("text");
    expect(input.autocomplete).toBe("off");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "12");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const submit = block!.querySelector<HTMLButtonElement>(".openui-form button")!;
    await waitFor(() => !submit.disabled);
    submit.click();
    expect(reply).not.toHaveBeenCalled();
    const [inert] = await hydrated(["```openui-lang", source, "```"].join("\n"));
    expect([...inert!.querySelectorAll<HTMLInputElement>(".openui-form input, .openui-form select, .openui-form button")].every((field) => field.disabled)).toBe(true);
    const refused = await hydrated([
      '{pr} 병합', 'PR {missing} 병합', 'PR 병합', 'PR {pr}\\n병합',
    ].map((template) => ["```openui-lang", `root = Card("x", [Form([Input("pr", "PR")], "${template}", "보내기")])`, "```"].join("\n")).concat([
      ["```openui-lang", 'root = Card("x", [Choices([Choice("A", "A"), Choice("B", "B")]), Form([Input("pr", "PR")], "PR {pr}", "보내기")])', "```"].join("\n"),
    ]).join("\n\n"));
    expect(refused.every((candidate) => candidate.dataset.openuiState === "fallback")).toBe(true);
  });

  // 블록·호스트가 사라질 때 루트가 남으면 스트림과 함께 구독·메모리가 누적된다. 기존 격리 검사는 이 수명을 보지 않는다.
  it("releases React roots when blocks leave or the host releases", async () => {
    const markdown = '```openui-lang\nroot = Card("수명", [])\n```';
    const blocks = await hydrated([markdown, markdown, markdown, markdown].join("\n\n"));
    const container = blocks[0]!.parentElement!;
    const views = blocks.map((block) => block.querySelector<HTMLElement>("[data-openui-owned]")!);
    const { installOpenUIHydrator, releaseOpenUIHydrator } = await import("@fleet-console/markdown/openui");
    blocks[0]!.remove();
    await waitFor(() => views[0]!.childNodes.length === 0);
    blocks[1]!.replaceWith(document.createElement("p"));
    await waitFor(() => views[1]!.childNodes.length === 0);
    blocks[2]!.setAttribute("data-openui-source", encodeMermaidSource('root = Card("잘림", ['));
    await waitFor(() => blocks[2]!.dataset.openuiState === "fallback" && views[2]!.childNodes.length === 0);
    container.innerHTML = markdown;
    await waitFor(() => views[3]!.childNodes.length === 0);

    container.innerHTML = renderMarkdown(markdown, { openui: true }).html;
    await waitFor(() => container.querySelector("section.openui") !== null);
    const released = container.querySelector<HTMLElement>("[data-openui-owned]")!;
    releaseOpenUIHydrator(container);
    // StrictMode처럼 같은 턴에 다시 설치해도 새 컨테이너를 쓰고, 옛 루트는 비워진다.
    installOpenUIHydrator(container);
    await waitFor(() => released.childNodes.length === 0 && container.querySelector("section.openui") !== null);
    expect(container.querySelectorAll("[data-openui-owned]")).toHaveLength(1);
    const last = container.querySelector<HTMLElement>("[data-openui-owned]")!;
    releaseOpenUIHydrator(container);
    await waitFor(() => last.childNodes.length === 0);
    expect(container.querySelector("[data-openui-owned]")).toBeNull();
  });
});
