import { renderMarkdown } from "@fleet-console/markdown/core";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import { React, usePluginApi } from "@fleet-console/sdk/plugin/browser";

import {
  appendUser,
  currentExchange,
  initialChatState,
  reduceChatEvent,
  type ChatState,
} from "./chat-store.js";
import { placeCard, type CardPlacement, type Size } from "./geometry.js";
import { getT, type ScuttlebuttMessageKey } from "./i18n.js";
import { connectChatStream, type ChatStreamConnection } from "./sse-client.js";

const FOLLOWUPS = [
  "followup.whoAreYou",
  "followup.whatCanYouDo",
] as const;

export function ChatCard({
  api,
  mascot,
  onClose,
  onTuck,
  locale,
  positionRevision,
  onPhaseChange,
}: {
  readonly api: ClientApiCapability;
  readonly mascot: React.RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly onTuck: () => void;
  readonly locale?: ConsoleLocale;
  readonly positionRevision: number;
  readonly onPhaseChange: (phase: ChatState["phase"]) => void;
}) {
  const pluginApi = usePluginApi(api, "scuttlebutt");
  const t = getT(locale);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const streamRef = React.useRef<ChatStreamConnection | null>(null);
  const [state, setState] = React.useState<ChatState>(initialChatState);
  const [draft, setDraft] = React.useState("");
  const [chatId, setChatId] = React.useState<string | null>(null);
  const [placement, setPlacement] = React.useState<CardPlacement | null>(null);

  const position = React.useCallback(() => {
    const mascotElement = mascot.current;
    const card = cardRef.current;
    if (!mascotElement || !card) return;
    const mascotRect = mascotElement.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    setPlacement(placeCard(
      { width: window.innerWidth, height: window.innerHeight },
      { left: mascotRect.left, top: mascotRect.top, width: mascotRect.width, height: mascotRect.height },
      { width: cardRect.width || 380, height: cardRect.height || 320 },
    ));
  }, [mascot]);

  React.useLayoutEffect(() => {
    position();
    inputRef.current?.focus();
    const card = cardRef.current;
    if (typeof ResizeObserver === "undefined" || !card) return;
    const observer = new ResizeObserver(position);
    observer.observe(card);
    return () => observer.disconnect();
  }, [position, positionRevision]);

  React.useEffect(() => {
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [position]);

  React.useLayoutEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
    position();
  }, [state.entries, state.phase, position]);

  React.useEffect(() => () => streamRef.current?.close(), []);
  React.useEffect(() => onPhaseChange(state.phase), [onPhaseChange, state.phase]);

  // 카드 바깥을 누르면 닫는다. 캡처 단계나 preventDefault를 쓰지 않으므로 그 클릭은
  // 아래 콘솔에 그대로 도달한다 — 마스코트 위 누름은 드래그 시작이라 닫힘에서 제외한다.
  React.useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (cardRef.current?.contains(target)) return;
      if (mascot.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [mascot, onClose]);

  const submit = async (text: string) => {
    const question = text.trim();
    if (!question || state.phase === "starting" || state.phase === "thinking") return;
    setDraft("");
    setState((current) => ({ ...appendUser(current, question), phase: "starting" }));
    try {
      let activeChatId = chatId;
      if (!activeChatId) {
        const response = await pluginApi.fetch("chat/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const payload = await response.json() as { readonly chatId?: unknown; readonly error?: unknown };
        if (!response.ok || typeof payload.chatId !== "string") {
          throw new Error(typeof payload.error === "string" ? payload.error : "Chat is unavailable.");
        }
        activeChatId = payload.chatId;
        setChatId(activeChatId);
        const connection = connectChatStream(activeChatId, (event) => {
          setState((current) => reduceChatEvent(current, event, locale));
        });
        streamRef.current = connection;
        await connection.connected;
      }
      await pluginApi.fetch(`chat/${encodeURIComponent(activeChatId)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: question }),
      });
      setState((current) => ({ ...current, phase: "thinking" }));
    } catch (error) {
      setState(errorState(error));
    }
  };

  const style = placementStyle(placement);
  const busy = state.phase === "starting" || state.phase === "thinking";
  const visibleEntries = currentExchange(state);
  return (
    <div
      ref={cardRef}
      className="scuttlebutt-chat-card"
      style={style}
      role="dialog"
      aria-label={t("mascot.label")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="scuttlebutt-chat-head">
        <span className="scuttlebutt-chat-sigil" aria-hidden="true">⚓</span>
        <span className="scuttlebutt-chat-who">{t("mascot.label")}</span>
        <button type="button" className="scuttlebutt-chat-tuck" aria-label={t("chat.tuck")} onClick={onTuck}>✕</button>
      </div>
      <div ref={logRef} className="scuttlebutt-chat-log" aria-live="polite">
        {visibleEntries.length === 0 ? (
          <div className="scuttlebutt-message-sam">
            {t("chat.greeting")}
          </div>
        ) : null}
        {visibleEntries.map((entry) => entry.kind === "assistant" ? (
          <div
            key={entry.id}
            className="scuttlebutt-message-sam scuttlebutt-markdown-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text).html }}
          />
        ) : entry.kind === "user" ? (
          <div key={entry.id} className="scuttlebutt-message-user">{entry.text}</div>
        ) : (
          <div key={entry.id} className={`scuttlebutt-status-row${entry.kind === "error" ? " is-error" : ""}`}>
            {entry.text}
          </div>
        ))}
      </div>
      {busy ? <div className="scuttlebutt-thinking"><i /><i /><i />{t("chat.thinking")}</div> : null}
      <div className="scuttlebutt-followups">
        {FOLLOWUPS.map((key: ScuttlebuttMessageKey) => (
          <button key={key} type="button" disabled={busy} onClick={() => void submit(t(key))}>
            {t(key)}
          </button>
        ))}
      </div>
      <form className="scuttlebutt-composer" onSubmit={(event) => {
        event.preventDefault();
        void submit(draft);
      }}>
        <input
          ref={inputRef}
          value={draft}
          disabled={busy}
          placeholder={t("chat.placeholder")}
          autoComplete="off"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <button type="submit" className="scuttlebutt-send" disabled={busy || !draft.trim()}>{t("chat.send")}</button>
      </form>
    </div>
  );
}

function placementStyle(placement: CardPlacement | null): React.CSSProperties {
  if (!placement) return { visibility: "hidden" };
  if (placement.side === "above") {
    return { left: placement.left, bottom: placement.bottom, maxHeight: placement.maxHeight };
  }
  return { left: placement.left, top: placement.top, maxHeight: placement.maxHeight };
}

function errorState(error: unknown): ChatState {
  return reduceChatEvent(initialChatState, {
    type: "error",
    error: { code: "client_error", message: error instanceof Error ? error.message : "Chat is unavailable." },
  });
}
