import { React } from "@fleet-console/sdk/plugin/browser";
import { Select } from "@fleet-console/sdk/react/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import "@fleet-console/markdown/styles.css";

import type { AnalysisActivity, AnalysisState } from "./analysis-state.js";
import { useAnalysisStore } from "./analysis-store.js";
import { StreamedMarkdown } from "./streamed-markdown.js";

const SUGGESTIONS = [
  { icon: "◈", tone: "aurora", text: "Walk me through how this session unfolded" },
  { icon: "●", tone: "aurora", text: "What is the agent doing right now?" },
  { icon: "▲", tone: "coral", text: "Flag anything I should review" },
  { icon: "≡", tone: "brass", text: "Draft a handoff brief" },
] as const;
const FOLLOW_UPS = [
  { icon: "◈", tone: "aurora", label: "Go deeper on the last answer", text: "Go deeper on your previous answer with more evidence citations." },
  { icon: "▲", tone: "coral", label: "Check for intent drift", text: "Review this session for intent drift against my stated goals." },
  { icon: "≡", tone: "brass", label: "Turn this into an artifact", text: "Turn your previous answer into a published artifact." },
  { icon: "●", tone: "aurora", label: "What is the agent doing now?", text: "What is the agent doing right now?" },
] as const;
const SLASH_COMMANDS = [
  { command: "/now", description: "Current state — what the agent is doing right now", template: "What is the agent doing right now?" },
  { command: "/drift", description: "Intent drift review against settled goals", template: "Review this session for intent drift against my stated goals." },
  { command: "/brief", description: "Handoff brief as an artifact", template: "Draft a handoff brief and publish it as an artifact." },
  { command: "/risks", description: "Flag anything that needs review", template: "Flag anything I should review before this work continues." },
  { command: "/timeline", description: "How the session unfolded, end to end", template: "Walk me through how this session unfolded." },
] as const;
export const ANALYST_ARTIFACTS_COMPANION_ID = "session-analyst-artifacts";

export function AnalystChatPanel({ context }: { readonly context: OperationRenderContext }) {
  const { state, dispatch, send, stop, reset } = useAnalysisStore(context);
  const [slashSelection, setSlashSelection] = React.useState(0);
  const [slashDismissed, setSlashDismissed] = React.useState(false);
  const cli = state.catalog?.clis.find((item) => item.cliId === state.cliId);
  const model = cli?.models.find((item) => item.id === state.model);
  const hasInteracted = state.entries.length > 0;
  const artifactCount = state.artifacts.length;
  const hiddenCompanionPanelIds = context.hiddenCompanionPanelIds;
  const setCompanionPanelVisible = context.onSetCompanionPanelVisible;
  const supportsCompanionVisibility = hiddenCompanionPanelIds !== undefined && setCompanionPanelVisible !== undefined;
  const artifactsHidden = hiddenCompanionPanelIds?.includes(ANALYST_ARTIFACTS_COMPANION_ID) ?? false;
  const artifactsVisible = artifactCount > 0 && !artifactsHidden;
  const artifactAuthoring = state.artifactAuthoring !== null && artifactCount === 0;
  const previousArtifactCountRef = React.useRef(0);
  const [countPulseRevision, setCountPulseRevision] = React.useState(0);
  const artifactsChipRef = React.useRef<HTMLButtonElement>(null);
  const chatRef = React.useRef<HTMLElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const latestEntry = state.entries.at(-1);
  const slashMatches = state.draft.startsWith("/")
    ? SLASH_COMMANDS.filter((item) => item.command.toLowerCase().startsWith(state.draft.toLowerCase()))
    : [];
  const slashOpen = !slashDismissed && slashMatches.length > 0;
  const slashListboxId = `analysis-${context.operationId}-slash-listbox`;
  const slashOptionId = (command: string) => `analysis-${context.operationId}-slash-${command.slice(1)}`;
  const activeSlashOption = slashOpen ? slashMatches[Math.min(slashSelection, slashMatches.length - 1)] : undefined;
  // 첫 상호작용이 이 마운트에서 발생했을 때만 도킹 모션을 붙인다. 클래스를 계속
  // 유지하면 뒤따르는 connected/chunk 렌더가 진행 중인 CSS 애니메이션을 끊지 않는다.
  const interactedAtMount = React.useRef(hasInteracted).current;
  const animateDock = hasInteracted && !interactedAtMount;
  React.useLayoutEffect(() => {
    const chat = chatRef.current;
    if (!chat || !hasInteracted) return;
    chat.scrollTop = chat.scrollHeight;
  }, [hasInteracted, latestEntry?.text, state.entries.length, state.latestActivity, state.phase, state.artifactAuthoring, state.artifactPublished]);
  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    resizeAnalysisTextarea(textarea);
  }, [state.draft]);
  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => resizeAnalysisTextarea(textarea));
    observer.observe(textarea);
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    const chat = chatRef.current;
    if (chat) installDiagramHydrator(chat);
  }, []);
  React.useEffect(() => {
    const previousCount = previousArtifactCountRef.current;
    previousArtifactCountRef.current = artifactCount;
    if (!supportsCompanionVisibility || !setCompanionPanelVisible) return;
    if (artifactCount === 0) {
      if (!state.artifactsAutoOpenArmed) dispatch({ type: "artifacts-chip-rearm" });
      if (!artifactsHidden) {
        const returnFocusToChip = document.activeElement instanceof Element
          && document.activeElement.closest(".session-analyst__artifacts") !== null;
        setCompanionPanelVisible(ANALYST_ARTIFACTS_COMPANION_ID, false);
        if (returnFocusToChip) window.requestAnimationFrame(() => artifactsChipRef.current?.focus());
      }
      return;
    }
    if (previousCount === 0 && artifactsHidden && state.artifactsAutoOpenArmed) {
      setCompanionPanelVisible(ANALYST_ARTIFACTS_COMPANION_ID, true);
      return;
    }
    if (artifactCount > previousCount && artifactsHidden) setCountPulseRevision((revision) => revision + 1);
  }, [artifactCount, artifactsHidden, dispatch, setCompanionPanelVisible, state.artifactsAutoOpenArmed, supportsCompanionVisibility]);
  const submit = async (text: string, clearDraft: boolean) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (state.busy) {
      dispatch({ type: "queue-push", text: trimmed });
      if (clearDraft) dispatch({ type: "set-draft", draft: "" });
      return;
    }
    if (clearDraft) dispatch({ type: "set-draft", draft: "" });
    await send(trimmed);
  };
  const selectSlashCommand = (index: number) => {
    const selected = slashMatches[index];
    if (!selected) return;
    dispatch({ type: "set-draft", draft: selected.template });
    setSlashDismissed(true);
    setSlashSelection(0);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const handleTranscriptClick = React.useCallback((event: React.MouseEvent<HTMLOListElement>) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
    if (!button) return;
    const code = button.closest("pre")?.getAttribute("data-code");
    if (!code) return;
    copyCodeToClipboard(button, code);
  }, []);

  return (
    <section className={`session-analyst__chat-pane ${hasInteracted ? "has-interacted" : "is-initial"}`} aria-label="Session Analyst chat" data-phase={state.phase}>
      {supportsCompanionVisibility ? (
        <button
          ref={artifactsChipRef}
          type="button"
          className={`session-analyst-handle session-analyst-handle--artifacts${artifactCount === 0 ? " is-waiting" : ""}${artifactAuthoring ? " is-authoring" : ""}`}
          aria-label={artifactsVisible ? "Hide Artifacts" : "Open Artifacts"}
          aria-pressed={artifactsVisible}
          aria-disabled={artifactCount === 0}
          tabIndex={artifactCount === 0 ? -1 : undefined}
          title={artifactAuthoring ? "The analyst is authoring an artifact…" : artifactCount === 0 ? "Artifacts the analyst publishes appear here" : undefined}
          onClick={() => {
            if (!setCompanionPanelVisible || artifactCount === 0) return;
            if (artifactsVisible) dispatch({ type: "artifacts-chip-disarm" });
            setCompanionPanelVisible(ANALYST_ARTIFACTS_COMPANION_ID, !artifactsVisible);
          }}
        >
          <span className="session-analyst-handle__chev" aria-hidden="true">{artifactsVisible ? "«" : "»"}</span>
          {artifactCount > 0 ? <span key={countPulseRevision} className={`session-analyst-handle__count${countPulseRevision > 0 ? " is-pulsing" : ""}`}>{artifactCount}</span> : null}
          {artifactAuthoring ? <span className="session-analyst-handle__count">…</span> : null}
          <span className="session-analyst-handle__label">ARTIFACTS</span>
        </button>
      ) : null}
      <PanelHeader state={state} onReset={() => { void reset().catch(() => {}); }} />
      <div className="session-analyst__workspace">
        <section ref={chatRef} className="session-analyst__chat" aria-live="polite" aria-busy={state.busy}>
          {hasInteracted ? (
            <ol className="session-analyst__transcript" onClick={handleTranscriptClick}>
              {state.entries.map((entry, index) => (
                <li className={`session-analyst__message session-analyst__message--${entry.role}`} key={`${entry.role}-${index}`}>
                  {entry.role === "analyst"
                    ? <StreamedMarkdown className="session-analyst__response markdown-body" text={entry.text} streaming={state.busy && index === state.entries.length - 1} />
                    : entry.text}
                </li>
              ))}
            </ol>
          ) : (
            <div className="session-analyst__hero-wrap">
              <header className="session-analyst__hero">
                <span className="session-analyst__sigil" aria-hidden="true">✳</span>
                <h2>Ask about this session</h2>
                <p>Review, explain, and summarize this session — without affecting the host agent.</p>
              </header>
              <div className="session-analyst__suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button type="button" key={suggestion.text} onClick={() => void submit(suggestion.text, false)}>
                    <span className="session-analyst__suggestion-icon" data-tone={suggestion.tone} aria-hidden="true">{suggestion.icon}</span>
                    {suggestion.text}
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* 기존 EvidencePulse가 진행 상태를 낭독하므로 카드에는 별도 live region을 두지 않는다. */}
          {state.artifactAuthoring || state.artifactPublished ? (
            <ArtifactAuthorCard
              state={state}
              onOpen={supportsCompanionVisibility && setCompanionPanelVisible
                ? () => setCompanionPanelVisible(ANALYST_ARTIFACTS_COMPANION_ID, true)
                : undefined}
            />
          ) : null}
          {state.phase !== "idle" ? <EvidencePulse state={state} /> : null}
        </section>
        {state.queue.length > 0 ? (
          <div className="session-analyst__queue" aria-live="polite">
            {state.queue.map((text, index) => (
              <div className="session-analyst__queue-item" key={`${text}-${index}`}>
                <span className="session-analyst__queue-tag">QUEUED</span>
                <span className="session-analyst__queue-text">{text}</span>
                <button type="button" aria-label={`Cancel queued question ${index + 1}`} onClick={() => dispatch({ type: "queue-cancel", index })}>✕</button>
              </div>
            ))}
          </div>
        ) : null}
        {state.phase === "complete" && !state.busy && hasInteracted ? (
          <div className="session-analyst__followups">
            <span className="session-analyst__followups-label">FOLLOW UP</span>
            <div className="session-analyst__followups-row">
              {FOLLOW_UPS.map((item) => (
                <button type="button" key={item.label} onClick={() => void submit(item.text, false)}>
                  <span className="session-analyst__suggestion-icon" data-tone={item.tone} aria-hidden="true">{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <form className={`session-analyst__composer ${hasInteracted ? "is-docked" : "is-initial"}${animateDock ? " is-docking" : ""}${state.busy ? " is-working" : ""}`} aria-busy={state.busy} onSubmit={(event) => { event.preventDefault(); void submit(state.draft, true); }}>
          {slashOpen ? (
            <div id={slashListboxId} className="session-analyst__slash" role="listbox" aria-label="Analysis commands">
              <span className="session-analyst__slash-heading">Analysis commands</span>
              {slashMatches.map((item, index) => (
                <button
                  type="button"
                  id={slashOptionId(item.command)}
                  role="option"
                  aria-selected={index === slashSelection}
                  className={index === slashSelection ? "is-selected" : undefined}
                  key={item.command}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSlashCommand(index)}
                >
                  <span>{item.command}</span>
                  <small>{item.description}</small>
                </button>
              ))}
            </div>
          ) : null}
          {!hasInteracted ? <div className="session-analyst__selector-strip" aria-label="Initial analysis settings">
            <span className="session-analyst__select">
              <Select
                compact
                label="Analysis CLI"
                value={state.cliId}
                disabled={state.started || !state.catalog}
                options={state.catalog?.clis.map((item) => ({ value: item.cliId, label: item.label, disabled: !item.available })) ?? []}
                onChange={(cliId) => dispatch({ type: "select-cli", cliId })}
              />
            </span>
            <span className="session-analyst__select">
              <Select
                compact
                label="Analysis model"
                value={state.model}
                disabled={state.started || !model}
                options={cli?.models.map((item) => ({ value: item.id, label: item.label })) ?? []}
                onChange={(nextModel) => dispatch({ type: "select-model", model: nextModel })}
              />
            </span>
            <span className="session-analyst__select">
              <Select
                compact
                label="Analysis effort"
                value={state.effort}
                disabled={state.started || !model || !model.effortLevels.length}
                options={model?.effortLevels.length ? model.effortLevels.map((item) => ({ value: item, label: item })) : [{ value: "", label: "n/a" }]}
                onChange={(effort) => dispatch({ type: "select-effort", effort })}
              />
            </span>
          </div> : null}
          <div className="session-analyst__composer-surface">
            <label className="session-analyst__sr-only" htmlFor={`analysis-${context.operationId}`}>Ask about this session</label>
            <textarea
              ref={textareaRef}
              id={`analysis-${context.operationId}`}
              role="combobox"
              aria-expanded={slashOpen}
              aria-controls={slashListboxId}
              aria-activedescendant={activeSlashOption ? slashOptionId(activeSlashOption.command) : undefined}
              rows={1}
              placeholder="Ask about the session… (/ for commands)"
              value={state.draft}
              onChange={(event) => {
                dispatch({ type: "set-draft", draft: event.target.value });
                setSlashSelection(0);
                setSlashDismissed(false);
              }}
              onKeyDown={(event) => {
                if (slashOpen && !event.nativeEvent.isComposing) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSlashSelection((selection) => (selection + 1) % slashMatches.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSlashSelection((selection) => (selection - 1 + slashMatches.length) % slashMatches.length);
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    selectSlashCommand(Math.min(slashSelection, slashMatches.length - 1));
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                }
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void submit(state.draft, true);
              }}
            />
            {state.busy ? (
              <button type="button" className="session-analyst__send session-analyst__stop" aria-label="Stop" onClick={() => void stop()}>
                <span aria-hidden="true" />
              </button>
            ) : null}
            <button type="submit" className="session-analyst__send" aria-label={state.busy ? "Queue question" : "Send"} disabled={!state.draft.trim()}>
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 10 V2 M2.5 5.5 L6 2 l3.5 3.5" /></svg>
            </button>
          </div>
          {state.busy ? <div className="session-analyst__composer-hint">Enter queues the question — it fires when the analyst is ready</div> : null}
        </form>
      </div>
    </section>
  );
}

function resizeAnalysisTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  const style = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(style.lineHeight) || 18.75;
  const verticalPadding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const maxHeight = (lineHeight * 6) + verticalPadding;
  const nextHeight = Math.max(36, Math.min(textarea.scrollHeight, maxHeight));
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

function copyCodeToClipboard(button: HTMLElement, code: string): void {
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  let write: Promise<void>;
  try { write = clipboard.writeText(code); } catch { return; }
  const original = button.textContent;
  void write.then(() => {
    if (!button.isConnected) return;
    button.textContent = "Copied";
    window.setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1_200);
  }).catch(() => undefined);
}

function PanelHeader({ state, onReset }: { readonly state: AnalysisState; readonly onReset: () => void }) {
  const canReset = state.started || state.phase !== "idle" || state.draft.length > 0 || state.queue.length > 0 || state.entries.length > 0 || state.artifacts.length > 0;
  return (
    <header className="session-analyst__panel-head">
      <span className="session-analyst__panel-mark" aria-hidden="true">✳</span>
      <span className="session-analyst__panel-copy"><strong>Session Analyst</strong><small>Read-only intelligence for this operation</small></span>
      <button type="button" className="session-analyst__reset" aria-label="Reset Session Analyst" onClick={onReset} disabled={!canReset}>Reset</button>
      <span className="session-analyst__panel-state"><i aria-hidden="true" />{headerState(state)}</span>
    </header>
  );
}

function ArtifactAuthorCard({ state, onOpen }: { readonly state: AnalysisState; readonly onOpen?: () => void }) {
  const authoringElapsedMs = useArtifactAuthoringElapsedMs(state.artifactAuthoring?.startedAt ?? null);
  if (state.artifactAuthoring) {
    return (
      <div className="session-analyst__author-card is-authoring">
        <div className="session-analyst__author-head">
          <span className="session-analyst__author-sigil" aria-hidden="true">✳</span>
          <strong className="session-analyst__author-title">Publishing an artifact</strong>
          <time className="session-analyst__author-time">{formatElapsed(authoringElapsedMs)}</time>
        </div>
        <p className="session-analyst__author-sub">The analyst is authoring artifact content. It opens in Artifacts when it lands.</p>
        <div className="session-analyst__author-track" aria-hidden="true"><span /></div>
      </div>
    );
  }
  const published = state.artifactPublished;
  if (!published) return null;
  return (
    <div className="session-analyst__author-card is-done">
      <div className="session-analyst__author-head">
        <span className="session-analyst__author-sigil" aria-hidden="true">◆</span>
        <strong className="session-analyst__author-title">Artifact published — {published.artifact.title}</strong>
        {published.durationMs === null ? null : <time className="session-analyst__author-time">{formatElapsed(published.durationMs)}</time>}
        {onOpen ? <button type="button" className="session-analyst__author-open" onClick={onOpen}>Open in Artifacts</button> : null}
      </div>
    </div>
  );
}

function EvidencePulse({ state }: { readonly state: AnalysisState }) {
  const elapsedMs = useElapsedMs(state);
  const elapsed = formatElapsed(elapsedMs);
  const activity = activityLabel(state.latestActivity);
  if (state.phase === "complete") return null;
  if (state.phase === "stopped") {
    return <div className="session-analyst__receipt is-stopped" role="status">Stopped · last confirmed: {activity} · {elapsed}</div>;
  }
  const isError = state.phase === "error";
  const current = currentActivity(state.latestActivity);
  return (
    <div className={`session-analyst__pulse${isError ? " is-error" : ""}`} role={isError ? "alert" : "status"} aria-live={isError ? undefined : "polite"}>
      {!isError ? <span className="session-analyst__pulse-scan" aria-hidden="true" /> : null}
      <div className="session-analyst__pulse-main">
        <span className="session-analyst__pulse-orbit" aria-hidden="true" />
        <span className="session-analyst__pulse-copy"><strong key={`${state.phase}-${current.label}`}>{isError ? state.error : current.label}</strong><small>{isError ? `Last confirmed activity: ${activity}` : current.note}</small></span>
        <time>{elapsed}</time>
      </div>
      <span className="session-analyst__truth-mark">Last confirmed activity only</span>
    </div>
  );
}

function currentActivity(activity: AnalysisActivity | null): { readonly label: string; readonly note: string } {
  if (!activity || activity.kind === "starting") return { label: "Starting analyst", note: activity?.connected ? "Analyst connection confirmed" : "Starting a new analysis session" };
  if (activity.kind === "reasoning") return { label: "Reasoning over session", note: "Thought event received · content hidden" };
  if (activity.kind === "tool") return { label: `Using ${activity.title}`, note: `Tool status: ${activity.status}` };
  return { label: "Writing answer", note: "Answer chunk received" };
}

function activityLabel(activity: AnalysisActivity | null): string {
  if (!activity || activity.kind === "starting") return "Starting analyst";
  if (activity.kind === "reasoning") return "Reasoning over session";
  if (activity.kind === "tool") return `Using ${activity.title} (${activity.status})`;
  return "Writing answer";
}

function headerState(state: AnalysisState): string {
  if (state.phase === "error") return "Needs attention";
  if (state.busy) return "Analyzing";
  if (state.phase === "complete") return "Complete";
  if (state.phase === "stopped") return "Stopped";
  return "Ready";
}

function useElapsedMs(state: AnalysisState): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!state.busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [state.busy, state.runStartedAt]);
  if (state.runStartedAt === null) return 0;
  return Math.max(0, (state.runEndedAt ?? now) - state.runStartedAt);
}

function useArtifactAuthoringElapsedMs(startedAt: number | null): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

function formatElapsed(elapsedMs: number): string {
  return `${Math.floor(elapsedMs / 1_000)}s`;
}
