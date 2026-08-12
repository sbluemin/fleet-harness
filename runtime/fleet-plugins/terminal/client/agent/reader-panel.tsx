import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";

import { getT } from "../i18n/index.js";
import { useReaderStore } from "./reader-store.js";
import type { ReaderBlock } from "./reader-types.js";
import { StreamedMarkdown } from "./streamed-markdown.js";

/**
 * Transcript reader panel.
 *
 * The source is block-granular: a completed block arrives whole, after a measured 0.1s-12.7s of
 * silence. Reading that raw is a screen that stalls and then jumps, so an arriving block is revealed
 * progressively. Two rules keep the reveal honest — it never outlives the arrival of the next block,
 * and it never applies to history.
 */
const REVEAL_MIN_MS = 260;
const REVEAL_MAX_MS = 2_600;
const REVEAL_CHARS_PER_MS = 0.08;

export function TranscriptReaderPanel({ context }: { readonly context: OperationRenderContext }) {
  const state = useReaderStore(context.operationId);
  const language = context.language ?? "en";
  const t = getT(language);

  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const stickRef = React.useRef(true);

  const onScroll = React.useCallback(() => {
    const node = bodyRef.current;
    if (!node) return;
    // Following the tail is the default, but a reader who scrolled up keeps their place.
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  }, []);

  React.useEffect(() => {
    const node = bodyRef.current;
    if (node && stickRef.current) node.scrollTop = node.scrollHeight;
  }, [state.blocks]);

  if (state.status === "unavailable") {
    return <div className="transcript-reader transcript-reader--empty">{t("terminal.reader.unavailable")}</div>;
  }
  if (state.blocks.length === 0) {
    return <div className="transcript-reader transcript-reader--empty">{t("terminal.reader.waiting")}</div>;
  }

  return (
    <div className="transcript-reader">
      {state.truncated ? <p className="transcript-reader__notice">{t("terminal.reader.truncated")}</p> : null}
      <div className="transcript-reader__body" ref={bodyRef} onScroll={onScroll}>
        {state.blocks.map((block) => (
          <ReaderBlockView
            key={`${state.generation}:${block.seq}`}
            block={block}
            revealing={block.seq === state.revealSeq}
            language={language}
          />
        ))}
      </div>
    </div>
  );
}

function ReaderBlockView({
  block,
  revealing,
  language,
}: {
  readonly block: ReaderBlock;
  readonly revealing: boolean;
  readonly language: ConsoleLocale;
}) {
  const t = getT(language);
  if (block.kind === "thinking") {
    return (
      <div className="transcript-reader__block transcript-reader__block--thinking">
        <span className={`transcript-reader__thought${revealing ? " is-live" : ""}`}>{t("terminal.reader.thinking")}</span>
      </div>
    );
  }
  if (block.kind === "tool") {
    return (
      <div className="transcript-reader__block transcript-reader__block--tool">
        <div className="transcript-reader__tool">
          <span className="transcript-reader__tool-name">{block.tool}</span>
          {block.detail ? <span className="transcript-reader__tool-detail">{block.detail}</span> : null}
        </div>
      </div>
    );
  }
  if (block.kind === "tool_result") {
    return (
      <div className="transcript-reader__block transcript-reader__block--result">
        <span className="transcript-reader__result-label">{t("terminal.reader.toolResult")}</span>
        <span className="transcript-reader__result-size">{t("terminal.reader.chars", { count: String(block.chars ?? 0) })}</span>
        <span className="transcript-reader__result-note">{t("terminal.reader.bodyWithheld")}</span>
      </div>
    );
  }
  return (
    <div className={`transcript-reader__block transcript-reader__block--${block.role}`}>
      <RevealedMarkdown text={block.text ?? ""} revealing={revealing} language={language} />
    </div>
  );
}

/**
 * Reveals an already-complete block over time. `revealing` drops as soon as a newer block arrives,
 * which snaps this one to full — so the reader is never shown less than the session has produced.
 */
export function RevealedMarkdown({
  text,
  revealing,
  language,
}: {
  readonly text: string;
  readonly revealing: boolean;
  readonly language: ConsoleLocale;
}) {
  const [visible, setVisible] = React.useState(() => (revealing ? 0 : text.length));
  const frameRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const cancel = () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
    const reduced = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!revealing || reduced || text.length === 0) {
      cancel();
      setVisible(text.length);
      return cancel;
    }
    const duration = Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, text.length / REVEAL_CHARS_PER_MS));
    const started = performance.now();
    const step = () => {
      const progress = Math.min(1, (performance.now() - started) / duration);
      setVisible(Math.floor(text.length * progress));
      frameRef.current = progress < 1 ? requestAnimationFrame(step) : null;
    };
    frameRef.current = requestAnimationFrame(step);
    return cancel;
  }, [revealing, text]);

  const shown = visible >= text.length ? text : text.slice(0, visible);
  return (
    <StreamedMarkdown
      className="transcript-reader__markdown markdown-body"
      text={shown}
      streaming={shown.length < text.length}
      language={language}
    />
  );
}
