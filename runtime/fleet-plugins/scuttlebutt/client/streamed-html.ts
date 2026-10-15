import { renderMarkdown } from "@fleet-console/markdown/core";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { markdownRenderOptions } from "./scuttlebutt-catalog.js";

/**
 * 흐르는 답의 마크다운 — 채팅뷰의 스트림 렌더와 같은 계약이다.
 *
 * 청크마다 전체를 다시 렌더하면 긴 답의 끝에서 한 글자에 한 번씩 파서가 돈다. 흐르는 동안은 32ms에
 * 한 번만 렌더하고, 멈추면(정착·중단) 마지막 글을 즉시 확정한다. 렌더러는 core 공유 것 그대로다.
 */
const STREAM_RENDER_DELAY_MS = 32;

export function useStreamedHtml(text: string, streaming: boolean, locale: ConsoleLocale | undefined): string {
  const render = React.useCallback((value: string) => renderMarkdown(value, markdownRenderOptions(locale)).html, [locale]);
  const latest = React.useRef(text);
  const rendered = React.useRef<string | null>(null);
  const timer = React.useRef<number | null>(null);
  const [streamed, setStreamed] = React.useState(() => render(text));
  latest.current = text;
  const settled = React.useMemo(() => (streaming ? null : render(text)), [streaming, text, render]);
  React.useEffect(() => {
    if (!streaming) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      rendered.current = null;
      return;
    }
    if (rendered.current === text || timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const next = latest.current;
      if (next === rendered.current) return;
      rendered.current = next;
      setStreamed(render(next));
    }, STREAM_RENDER_DELAY_MS);
  }, [streaming, text, render]);
  React.useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return settled ?? streamed;
}
