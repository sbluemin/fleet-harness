import { renderMarkdown } from "@fleet-console/markdown/core";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { getT } from "../i18n/index.js";

const STREAM_RENDER_DELAY_MS = 32;

function markdownCopyOptions(locale: ConsoleLocale) {
  const t = getT(locale);
  return {
    copyLabel: t("terminal.markdown.copy"),
    copyAriaLabel: (language: string) => t("terminal.markdown.copyCodeAria", { language }),
  };
}

export const StreamedMarkdown = React.memo(function StreamedMarkdown({
  text,
  streaming,
  className,
  language = "en",
  transformHtml,
}: {
  readonly text: string;
  readonly streaming: boolean;
  readonly className?: string;
  readonly language?: ConsoleLocale;
  /* sanitize 이후의 HTML 후처리 훅(예: 증거 인용 칩). 호출자는 참조가 안정된 함수를 넘겨야
     memo 이득이 유지된다. */
  readonly transformHtml?: (html: string) => string;
}) {
  const latestText = React.useRef(text);
  const renderedText = React.useRef(streaming ? text : "");
  const renderTimer = React.useRef<number | null>(null);
  const transform = React.useRef(transformHtml);
  transform.current = transformHtml;
  const render = (value: string) => {
    const html = renderMarkdown(value, markdownCopyOptions(language)).html;
    return transform.current ? transform.current(html) : html;
  };
  const [streamedHtml, setStreamedHtml] = React.useState(() => streaming ? render(text) : "");
  latestText.current = text;

  const completedHtml = React.useMemo(
    () => {
      if (streaming) return null;
      const html = renderMarkdown(text, markdownCopyOptions(language)).html;
      return transformHtml ? transformHtml(html) : html;
    },
    [streaming, text, language, transformHtml],
  );

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
      setStreamedHtml(render(nextText));
    }, STREAM_RENDER_DELAY_MS);
  }, [streaming, text, language]);

  React.useEffect(() => () => {
    if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
  }, []);

  // 흐르는 동안만 다는 표식 — 캐럿과 끝단 옅어짐은 CSS가 이 클래스에 건다. 글이 멈추면
  // 클래스가 함께 걷혀 확정된 글에 "아직 자란다"가 남지 않는다.
  const streamingClass = streaming ? `${className ?? ""} is-streaming`.trim() : className;
  return <div className={streamingClass} dangerouslySetInnerHTML={{ __html: completedHtml ?? streamedHtml }} />;
});
