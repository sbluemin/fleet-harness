import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import type { AnalysisActivity, AnalysisState } from "./analysis-state.js";
import { useAnalysisStore } from "./analysis-store.js";

const SUGGESTIONS = [
  { icon: "◈", tone: "aurora", text: "Walk me through how this session unfolded" },
  { icon: "●", tone: "aurora", text: "What is the agent doing right now?" },
  { icon: "▲", tone: "coral", text: "Flag anything I should review" },
  { icon: "≡", tone: "brass", text: "Draft a handoff brief" },
] as const;

export function AnalystChatPanel({ context }: { readonly context: OperationRenderContext }) {
  const { state, dispatch, send, stop, reset } = useAnalysisStore(context);
  const [draft, setDraft] = React.useState("");
  const cli = state.catalog?.clis.find((item) => item.cliId === state.cliId);
  const model = cli?.models.find((item) => item.id === state.model);
  const hasInteracted = state.entries.length > 0;
  const chatRef = React.useRef<HTMLElement>(null);
  const latestEntry = state.entries.at(-1);
  // 첫 상호작용이 이 마운트에서 발생했을 때만 도킹 모션을 붙인다. 클래스를 계속
  // 유지하면 뒤따르는 connected/chunk 렌더가 진행 중인 CSS 애니메이션을 끊지 않는다.
  const interactedAtMount = React.useRef(hasInteracted).current;
  const animateDock = hasInteracted && !interactedAtMount;
  React.useLayoutEffect(() => {
    const chat = chatRef.current;
    if (!chat || !hasInteracted) return;
    chat.scrollTop = chat.scrollHeight;
  }, [hasInteracted, latestEntry?.text, state.entries.length, state.latestActivity, state.phase]);
  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || state.busy) return;
    setDraft("");
    await send(trimmed);
  };

  return (
    <section className={`session-analyst__chat-pane ${hasInteracted ? "has-interacted" : "is-initial"}`} aria-label="Session Analyst chat" data-phase={state.phase}>
      <PanelHeader state={state} onReset={() => { void reset().then(() => setDraft("")).catch(() => {}); }} />
      <div className="session-analyst__workspace">
        <section ref={chatRef} className="session-analyst__chat" aria-live="polite" aria-busy={state.busy}>
          {hasInteracted ? (
            <ol className={state.busy ? "is-dimmed" : undefined}>
              {state.entries.map((entry, index) => (
                <li className={`session-analyst__message session-analyst__message--${entry.role}`} key={`${entry.role}-${index}`}>{entry.text}</li>
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
                  <button type="button" key={suggestion.text} onClick={() => void submit(suggestion.text)}>
                    <span className="session-analyst__suggestion-icon" data-tone={suggestion.tone} aria-hidden="true">{suggestion.icon}</span>
                    {suggestion.text}
                  </button>
                ))}
              </div>
            </div>
          )}
          {state.phase !== "idle" ? <EvidencePulse state={state} /> : null}
        </section>
        <form className={`session-analyst__composer ${hasInteracted ? "is-docked" : "is-initial"}${animateDock ? " is-docking" : ""}${state.busy ? " is-working" : ""}`} aria-busy={state.busy} onSubmit={(event) => { event.preventDefault(); void submit(draft); }}>
          <div className="session-analyst__composer-surface">
            {!hasInteracted ? <div className="session-analyst__selector-strip" aria-label="Initial analysis settings">
              <span className="session-analyst__select"><select aria-label="Analysis CLI" disabled={state.started || !state.catalog} value={state.cliId} onChange={(event) => dispatch({ type: "select-cli", cliId: event.target.value })}>{state.catalog?.clis.map((item) => <option key={item.cliId} value={item.cliId} disabled={!item.available}>{item.label}</option>)}</select></span>
              <span className="session-analyst__select"><select aria-label="Analysis model" disabled={state.started || !model} value={state.model} onChange={(event) => dispatch({ type: "select-model", model: event.target.value })}>{cli?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></span>
              <span className="session-analyst__select"><select aria-label="Analysis effort" disabled={state.started || !model || !model.effortLevels.length} value={state.effort} onChange={(event) => dispatch({ type: "select-effort", effort: event.target.value })}>{model?.effortLevels.length ? model.effortLevels.map((item) => <option key={item} value={item}>{item}</option>) : <option value="">n/a</option>}</select></span>
            </div> : null}
            <label className="session-analyst__sr-only" htmlFor={`analysis-${context.operationId}`}>Ask about this session</label>
            <textarea
              id={`analysis-${context.operationId}`}
              rows={1}
              placeholder="Ask about the session…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void submit(draft);
              }}
              disabled={state.busy}
            />
            {state.busy ? (
              <button type="button" className="session-analyst__send session-analyst__stop" aria-label="Stop" onClick={() => void stop()}>
                <span aria-hidden="true" />
              </button>
            ) : (
              <button type="submit" className="session-analyst__send" aria-label="Send" disabled={!draft.trim()}>
                <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 10 V2 M2.5 5.5 L6 2 l3.5 3.5" /></svg>
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}

function PanelHeader({ state, onReset }: { readonly state: AnalysisState; readonly onReset: () => void }) {
  const canReset = state.started || state.phase !== "idle" || state.entries.length > 0 || state.artifacts.length > 0;
  return (
    <header className="session-analyst__panel-head">
      <span className="session-analyst__panel-mark" aria-hidden="true">✳</span>
      <span className="session-analyst__panel-copy"><strong>Session Analyst</strong><small>Read-only intelligence for this operation</small></span>
      <button type="button" className="session-analyst__reset" aria-label="Reset Session Analyst" onClick={onReset} disabled={!canReset}>Reset</button>
      <span className="session-analyst__panel-state"><i aria-hidden="true" />{headerState(state)}</span>
    </header>
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

function formatElapsed(elapsedMs: number): string {
  return `${Math.floor(elapsedMs / 1_000)}s`;
}
