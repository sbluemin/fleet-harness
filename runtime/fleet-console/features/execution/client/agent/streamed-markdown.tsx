import { useMarkdownLinkResolver } from "./markdown-link-boundary.js";
import { renderMarkdown } from "@fleet-console/markdown/core";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import { installOpenUIHydrator } from "@fleet-console/markdown/openui";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { diagramHydratorLabels, getT, openUIHydratorLabels } from "./i18n/index.js";

const STREAM_RENDER_DELAY_MS = 32;

function markdownCopyOptions(locale: ConsoleLocale) {
  const t = getT(locale);
  return {
    copyLabel: t("terminal.markdown.copy"),
    copyAriaLabel: (language: string) => t("terminal.markdown.copyCodeAria", { language }),
  };
}

function isDiagramBlock(node: Node): node is Element {
  return node instanceof Element && node.classList.contains("diagram-block") && node.hasAttribute("data-mermaid-source");
}

function sameDiagramSource(current: Node, next: Node): boolean {
  if (!isDiagramBlock(current) || !isDiagramBlock(next)) return false;
  const source = current.getAttribute("data-mermaid-source");
  return source !== null && source === next.getAttribute("data-mermaid-source");
}

/**
 * 하이드레이터가 이미 손을 댄 블록. 자리표시자와 isEqualNode로 다르다고 보고 속성을 덮으면
 * SVG가 지워지고, 그 변경은 자식 추가가 아니라서 MutationObserver가 다시 스캔하지 않는다.
 */
function drawnDiagram(node: Node, keepErrors: boolean): boolean {
  if (!isDiagramBlock(node)) return false;
  const state = node.getAttribute("data-diagram-state");
  if (state === "rendered" || node.getAttribute("data-diagram-hydrating") === "true") return true;
  return keepErrors && state === "error";
}

function isOpenUIBlock(node: Node): node is Element {
  return node instanceof Element && node.classList.contains("openui-block");
}

/** OpenUI 하이드레이터가 블록 안에 만든 그림 칸. 정제 결과에는 없으므로 맞춤이 지우면 안 된다. */
function isOpenUIOwned(node: Node): boolean {
  return node instanceof Element && node.hasAttribute("data-openui-owned");
}

// 자리표시자가 실어 오는 OpenUI 속성은 이 둘뿐이다. 상태(data-openui-state)는 하이드레이터가 쓰므로 맞춤이 건드리지 않는다.
const OPENUI_SOURCE_ATTRIBUTES = ["data-openui-source", "data-openui-final"] as const;

/** 이미 정제를 마친 HTML끼리만 맞춘다. 같은 블록·글자 노드를 지켜 델타마다 전체 렌더 트리를 버리지 않는다. */
function reconcileStreamedChildren(target: Element, source: DocumentFragment | Element, keepDiagramErrors: boolean): void {
  let current = target.firstChild;
  for (const next of Array.from(source.childNodes)) {
    if (current && isOpenUIOwned(current)) current = current.nextSibling;
    if (!current) {
      const tail = target.ownerDocument.createDocumentFragment();
      let node: ChildNode | null = next;
      while (node) { const after: ChildNode | null = node.nextSibling; tail.appendChild(node); node = after; }
      target.appendChild(tail);
      break;
    }
    const after = current.nextSibling;
    // OpenUI 블록은 그린 그림을 지킨다 — 원문 속성만 맞추면 하이드레이터가 그 자리에서 다시 그리고, 안쪽 코드 블록(폴백)만 글자를 따라간다.
    if (isOpenUIBlock(current) && isOpenUIBlock(next)) {
      for (const name of OPENUI_SOURCE_ATTRIBUTES) {
        const value = next.getAttribute(name);
        if (value === null) current.removeAttribute(name);
        else if (current.getAttribute(name) !== value) current.setAttribute(name, value);
      }
      reconcileStreamedChildren(current, next, keepDiagramErrors);
      current = after;
      continue;
    }
    // 같은 원문으로 그린 그림은 둔다. 원문이 바뀌면 자리표시자로 갈아 끼워 다시 그린다.
    if (!current.isEqualNode(next) && !(sameDiagramSource(current, next) && drawnDiagram(current, keepDiagramErrors))) {
      if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName || (isDiagramBlock(current) && isDiagramBlock(next)) || isOpenUIBlock(current) !== isOpenUIBlock(next)) {
        target.replaceChild(next, current);
      } else if (current instanceof Element && next instanceof Element) {
        for (const attribute of Array.from(current.attributes)) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
        for (const attribute of Array.from(next.attributes)) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
        reconcileStreamedChildren(current, next, keepDiagramErrors);
      } else current.nodeValue = next.nodeValue;
    }
    current = after;
  }
  while (current) { const after = current.nextSibling; if (!isOpenUIOwned(current)) target.removeChild(current); current = after; }
}

export const StreamedMarkdown = React.memo(function StreamedMarkdown({
  text,
  streaming,
  className,
  language = "en",
  transformHtml,
  siteLinks = false,
  preserveStreamingDom = false,
  openui = false,
}: {
  readonly text: string;
  readonly streaming: boolean;
  readonly className?: string;
  readonly language?: ConsoleLocale;
  /* sanitize 이후의 HTML 후처리 훅(예: 증거 인용 칩). 호출자는 참조가 안정된 함수를 넘겨야
     memo 이득이 유지된다. */
  readonly transformHtml?: (html: string) => string;
  /* AI 응답 본문만 켠다 — 외부 링크를 사이트 아이콘 + 이름으로 그린다(사람이 쓴 말풍선은 그대로). */
  readonly siteLinks?: boolean;
  /** 대화의 흐르는 말풍선만 선택한다. 확정 글·원장 등 다른 소비자는 기존 렌더를 유지한다. */
  readonly preserveStreamingDom?: boolean;
  /** `openui-lang` 펜스를 생성형 UI로 그린다 — 사령관·지휘관 말풍선만 켠다. 그리지 못하면 코드 블록 그대로다. */
  readonly openui?: boolean;
}) {
  const resolveLink = useMarkdownLinkResolver();
  const latestText = React.useRef(text);
  const renderedText = React.useRef(streaming ? text : "");
  const renderTimer = React.useRef<number | null>(null);
  const transform = React.useRef(transformHtml);
  transform.current = transformHtml;
  const render = (value: string, deferUnclosedMermaid: boolean) => {
    const html = renderMarkdown(value, { ...markdownCopyOptions(language), resolveLink, siteLinks, deferUnclosedMermaid, openui }).html;
    return transform.current ? transform.current(html) : html;
  };
  const [streamedHtml, setStreamedHtml] = React.useState(() => streaming ? render(text, true) : "");
  latestText.current = text;

  const completedHtml = React.useMemo(
    () => {
      if (streaming) return null;
      const html = renderMarkdown(text, { ...markdownCopyOptions(language), resolveLink, siteLinks, openui }).html;
      return transformHtml ? transformHtml(html) : html;
    },
    [streaming, text, language, transformHtml, resolveLink, siteLinks, openui],
  );

  React.useEffect(() => {
    if (streaming) setStreamedHtml(render(latestText.current, true));
  }, [streaming, language, resolveLink]);

  React.useEffect(() => {
    if (!streaming) {
      if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
      renderTimer.current = null;
      return;
    }
    if (renderedText.current === text || renderTimer.current !== null) return;
    renderTimer.current = window.setTimeout(() => {
      renderTimer.current = null;
      const nextText = latestText.current;
      if (nextText === renderedText.current) return;
      renderedText.current = nextText;
      setStreamedHtml(render(nextText, true));
    }, STREAM_RENDER_DELAY_MS);
  }, [streaming, text, language]);

  React.useEffect(() => () => {
    if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
  }, []);

  // 흐르는 동안만 다는 표식 — 캐럿과 끝단 옅어짐은 CSS가 이 클래스에 건다. 글이 멈추면
  // 클래스가 함께 걷혀 확정된 글에 "아직 자란다"가 남지 않는다.
  const streamingClass = streaming ? `${className ?? ""} is-streaming`.trim() : className;
  const html = completedHtml ?? streamedHtml;
  const root = React.useRef<HTMLDivElement | null>(null);
  const preserved = React.useRef(false);
  // 한 번 흐른 인스턴스는 확정 뒤에도 DOM을 직접 맞춘다. dangerouslySetInnerHTML로 돌아가면
  // 그려 둔 SVG가 통째로 갈아끼워져 그림이 비었다가 다시 그려진다.
  const streamedDom = React.useRef(false);
  const preserve = preserveStreamingDom && (streaming || preserved.current);
  const manageDom = streaming || preserve || streamedDom.current;
  React.useLayoutEffect(() => {
    const target = root.current;
    if (!manageDom || !target) return;
    if (streaming) streamedDom.current = true;
    if (preserve) preserved.current = true;
    // renderMarkdown의 sanitize와 기존 후처리를 통과한 출력만 파싱한다. 새로운 HTML 입력 경로는 없다.
    const template = target.ownerDocument.createElement("template");
    template.innerHTML = html;
    // 확정도 같은 맞춤이다. 정제 결과가 권위이고, 같은 원문으로 이미 그린 다이어그램만 그 자리에 남긴다.
    // 스트리밍 중의 오류 블록은 델타마다 되돌리지 않고, 확정 때는 최종 원문으로 한 번 다시 그린다.
    reconcileStreamedChildren(target, template.content, streaming);
  }, [manageDom, preserve, streaming, html]);
  React.useEffect(() => {
    const target = root.current;
    if (!target) return;
    installDiagramHydrator(target, diagramHydratorLabels(language));
  }, [language]);
  React.useEffect(() => {
    const target = root.current;
    if (!target || !openui) return;
    installOpenUIHydrator(target, openUIHydratorLabels(language));
  }, [openui, language]);
  return manageDom
    ? <div ref={root} className={streamingClass} />
    : <div ref={root} className={streamingClass} dangerouslySetInnerHTML={{ __html: html }} />;
});
