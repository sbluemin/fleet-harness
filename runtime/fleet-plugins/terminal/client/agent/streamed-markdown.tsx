import { renderMarkdown } from "@fleet-console/markdown/core";
import { React } from "@fleet-console/sdk/plugin/browser";

const STREAM_RENDER_DELAY_MS = 32;

export const StreamedMarkdown = React.memo(function StreamedMarkdown({
  text,
  streaming,
  className,
}: {
  readonly text: string;
  readonly streaming: boolean;
  readonly className?: string;
}) {
  const latestText = React.useRef(text);
  const renderedText = React.useRef(streaming ? text : "");
  const renderTimer = React.useRef<number | null>(null);
  const [streamedHtml, setStreamedHtml] = React.useState(() => streaming ? renderMarkdown(text).html : "");
  latestText.current = text;

  const completedHtml = React.useMemo(() => streaming ? null : renderMarkdown(text).html, [streaming, text]);

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
      setStreamedHtml(renderMarkdown(nextText).html);
    }, STREAM_RENDER_DELAY_MS);
  }, [streaming, text]);

  React.useEffect(() => () => {
    if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
  }, []);

  return <div className={className} dangerouslySetInnerHTML={{ __html: completedHtml ?? streamedHtml }} />;
});
