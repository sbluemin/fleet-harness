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
}: {
  readonly text: string;
  readonly streaming: boolean;
  readonly className?: string;
  readonly language?: ConsoleLocale;
}) {
  const latestText = React.useRef(text);
  const renderedText = React.useRef(streaming ? text : "");
  const renderTimer = React.useRef<number | null>(null);
  const [streamedHtml, setStreamedHtml] = React.useState(() => streaming ? renderMarkdown(text, markdownCopyOptions(language)).html : "");
  latestText.current = text;

  const completedHtml = React.useMemo(
    () => streaming ? null : renderMarkdown(text, markdownCopyOptions(language)).html,
    [streaming, text, language],
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
      setStreamedHtml(renderMarkdown(nextText, markdownCopyOptions(language)).html);
    }, STREAM_RENDER_DELAY_MS);
  }, [streaming, text, language]);

  React.useEffect(() => () => {
    if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
  }, []);

  return <div className={className} dangerouslySetInnerHTML={{ __html: completedHtml ?? streamedHtml }} />;
});
