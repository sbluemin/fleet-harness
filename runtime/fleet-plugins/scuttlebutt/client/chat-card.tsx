import { renderMarkdown } from "@fleet-console/markdown/core";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import { React, usePluginApi } from "@fleet-console/sdk/plugin/browser";
import { Select } from "@fleet-console/sdk/react/browser";

import type { ChatCatalog } from "./catalog.js";
import {
  appendUser,
  hydrateEntries,
  initialChatState,
  reduceChatEvent,
  type ChatState,
} from "./chat-store.js";
import { placeCard, type CardPlacement, type Size } from "./geometry.js";
import type { ScuttlebuttSettings } from "./settings-store.js";
import { connectChatStream, type ChatStreamConnection } from "./sse-client.js";

const FOLLOWUPS = [
  { label: "HTTP/2 → HTTP/3?", prompt: "What changed between HTTP/2 and HTTP/3?" },
  { label: "pnpm vs bun", prompt: "Compare pnpm and bun for monorepos" },
  { label: "KST → UTC", prompt: "What time is 09:00 KST in UTC?" },
] as const;

export function ChatCard({
  api,
  mascot,
  settings,
  onClose,
  onTuck,
  onSnap,
  positionRevision,
  onPhaseChange,
}: {
  readonly api: ClientApiCapability;
  readonly mascot: React.RefObject<HTMLButtonElement | null>;
  readonly settings: ScuttlebuttSettings;
  readonly onClose: () => void;
  readonly onTuck: () => void;
  readonly onSnap: (corner: "bottom-right" | "bottom-left" | "top-right") => void;
  readonly positionRevision: number;
  readonly onPhaseChange: (phase: ChatState["phase"]) => void;
}) {
  const pluginApi = usePluginApi(api, "scuttlebutt");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const streamRef = React.useRef<ChatStreamConnection | null>(null);
  const [catalog, setCatalog] = React.useState<ChatCatalog | null>(null);
  const [state, setState] = React.useState<ChatState>(initialChatState);
  const [draft, setDraft] = React.useState("");
  const [chatId, setChatId] = React.useState<string | null>(null);
  const [cliId, setCliId] = React.useState(settings.cliId);
  const [modelId, setModelId] = React.useState(settings.model);
  const [effort, setEffort] = React.useState(settings.effort ?? "");
  const [placement, setPlacement] = React.useState<CardPlacement | null>(null);
  const hydratedRef = React.useRef(false);
  const activeCli = catalog?.clis.find((cli) => cli.cliId === cliId && cli.available)
    ?? catalog?.clis.find((cli) => cli.available);
  const activeModel = activeCli?.models.find((model) => model.id === modelId) ?? activeCli?.models[0];

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

  React.useEffect(() => {
    const controller = new AbortController();
    void pluginApi.fetch("chat/catalog", { signal: controller.signal })
      .then((response) => response.json() as Promise<ChatCatalog>)
      .then((nextCatalog) => {
        setCatalog(nextCatalog);
        if (!hydratedRef.current) {
          hydratedRef.current = true;
          setState(hydrateEntries(nextCatalog.threads));
        }
        const requestedCli = nextCatalog.clis.find((cli) => cli.available && cli.cliId === settings.cliId)
          ?? nextCatalog.clis.find((cli) => cli.available);
        if (!requestedCli) return;
        const requestedModel = requestedCli.models.find((item) => item.id === settings.model) ?? requestedCli.models[0];
        setCliId(requestedCli.cliId);
        if (requestedModel) {
          setModelId(requestedModel.id);
          setEffort(settings.effort && requestedModel.effortLevels.includes(settings.effort)
            ? settings.effort
            : requestedModel.defaultEffort ?? "");
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState(errorState(error));
      });
    return () => controller.abort();
  }, [pluginApi, settings]);

  React.useLayoutEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
    position();
  }, [state.entries, state.phase, position]);

  React.useEffect(() => () => streamRef.current?.close(), []);
  React.useEffect(() => onPhaseChange(state.phase), [onPhaseChange, state.phase]);

  const submit = async (text: string) => {
    const question = text.trim();
    if (!question || state.phase === "starting" || state.phase === "thinking" || !activeCli || !activeModel) return;
    setDraft("");
    setState((current) => ({ ...appendUser(current, question), phase: "starting" }));
    try {
      let activeChatId = chatId;
      if (!activeChatId) {
        const response = await pluginApi.fetch("chat/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cliId: activeCli.cliId,
            model: activeModel.id,
            ...(effort ? { effort } : {}),
          }),
        });
        const payload = await response.json() as { readonly thread: { readonly id: string } };
        activeChatId = payload.thread.id;
        setChatId(activeChatId);
        const connection = connectChatStream(activeChatId, (event) => setState((current) => reduceChatEvent(current, event)));
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
  return (
    <div
      ref={cardRef}
      className="scuttlebutt-chat-card"
      style={style}
      role="dialog"
      aria-label="Scuttlebutt chat"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="scuttlebutt-chat-head">
        <span className="scuttlebutt-chat-sigil" aria-hidden="true">⚓</span>
        <span className="scuttlebutt-chat-who">Admiral Sam</span>
        <span className="scuttlebutt-chat-scope">No theater · read-only · web ok</span>
        <span className="scuttlebutt-snap-controls" aria-label="Snap position">
          <button type="button" aria-label="Snap bottom left" onClick={() => onSnap("bottom-left")}>↙</button>
          <button type="button" aria-label="Snap top right" onClick={() => onSnap("top-right")}>↗</button>
          <button type="button" aria-label="Snap bottom right" onClick={() => onSnap("bottom-right")}>↘</button>
        </span>
        <button type="button" className="scuttlebutt-chat-tuck" aria-label="Tuck away" onClick={onTuck}>✕</button>
      </div>
      <div ref={logRef} className="scuttlebutt-chat-log" aria-live="polite">
        {state.entries.length === 0 ? (
          <div className="scuttlebutt-message-sam">
            Mrow — ask anything that does not need a workspace. I can search the web, and I never touch your files.
          </div>
        ) : null}
        {state.entries.map((entry) => entry.kind === "assistant" ? (
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
      {busy ? <div className="scuttlebutt-thinking"><i /><i /><i />Sam is looking it up…</div> : null}
      <div className="scuttlebutt-followups">
        {FOLLOWUPS.map((followup) => (
          <button key={followup.label} type="button" disabled={busy} onClick={() => void submit(followup.prompt)}>
            {followup.label}
          </button>
        ))}
      </div>
      <form className="scuttlebutt-composer" onSubmit={(event) => {
        event.preventDefault();
        void submit(draft);
      }}>
        <Select
          value={activeCli?.cliId ?? ""}
          label="Backend CLI"
          disabled={busy}
          options={(catalog?.clis.filter((cli) => cli.available) ?? []).map((cli) => ({ value: cli.cliId, label: cli.label }))}
          onChange={(nextCliId) => {
            const nextCli = catalog?.clis.find((cli) => cli.cliId === nextCliId);
            const nextModel = nextCli?.models.find((model) => model.id === nextCli.defaultModel) ?? nextCli?.models[0];
            if (!nextCli || !nextModel) return;
            setCliId(nextCli.cliId);
            setModelId(nextModel.id);
            setEffort(nextModel.defaultEffort ?? "");
            setChatId(null);
            streamRef.current?.close();
            streamRef.current = null;
          }}
        />
        <Select
          value={activeModel?.id ?? ""}
          label="Model"
          disabled={busy}
          options={(activeCli?.models ?? []).map((model) => ({ value: model.id, label: model.label }))}
          onChange={(nextModelId) => {
            const nextModel = activeCli?.models.find((model) => model.id === nextModelId);
            if (!nextModel) return;
            setModelId(nextModel.id);
            setEffort(nextModel.defaultEffort ?? "");
            setChatId(null);
            streamRef.current?.close();
            streamRef.current = null;
          }}
        />
        {activeModel && activeModel.effortLevels.length > 0 ? (
          <Select
            value={effort}
            label="Effort"
            disabled={busy}
            options={activeModel.effortLevels.map((value) => ({ value, label: value }))}
            onChange={(value) => {
              setEffort(value);
              setChatId(null);
              streamRef.current?.close();
              streamRef.current = null;
            }}
          />
        ) : null}
        <input
          ref={inputRef}
          value={draft}
          disabled={busy || !activeCli}
          placeholder="Ask Sam anything…"
          autoComplete="off"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <button type="submit" className="scuttlebutt-send" disabled={busy || !draft.trim()}>Send</button>
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
