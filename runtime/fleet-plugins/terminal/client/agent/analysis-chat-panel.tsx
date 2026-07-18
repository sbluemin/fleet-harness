import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { useAnalysisStore } from "./analysis-store.js";

const SUGGESTIONS = [
  "Walk me through how this session unfolded",
  "What is the agent doing right now?",
  "Flag anything I should review",
  "Draft a handoff brief",
] as const;

export function AnalystChatPanel({ context }: { readonly context: OperationRenderContext }) {
  const { state, dispatch, send } = useAnalysisStore(context);
  const [draft, setDraft] = React.useState("");
  const cli = state.catalog?.clis.find((item) => item.cliId === state.cliId);
  const model = cli?.models.find((item) => item.id === state.model);
  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || state.busy) return;
    setDraft("");
    await send(trimmed);
  };

  return (
    <section className="session-analyst__chat-pane" aria-label="Session Analyst chat">
      <header className="session-analyst__hero"><span>SESSION ANALYST</span><h2>Ask about this session</h2><p>The analyst watches the host agent&apos;s transcript — it never interrupts the work.</p></header>
      <div className="session-analyst__selectors"><label>CLI<select aria-label="Analysis CLI" disabled={state.started || !state.catalog} value={state.cliId} onChange={(event) => dispatch({ type: "select-cli", cliId: event.target.value })}>{state.catalog?.clis.map((item) => <option key={item.cliId} value={item.cliId} disabled={!item.available}>{item.label}</option>)}</select></label><label>Model<select aria-label="Analysis model" disabled={state.started || !model} value={state.model} onChange={(event) => dispatch({ type: "select-model", model: event.target.value })}>{cli?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>Effort<select aria-label="Analysis effort" disabled={state.started || !model} value={state.effort} onChange={(event) => dispatch({ type: "select-effort", effort: event.target.value })}>{model?.effortLevels.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div>
      <section className="session-analyst__chat" aria-live="polite">{state.entries.length ? <ol>{state.entries.map((entry, index) => <li className={`session-analyst__message session-analyst__message--${entry.role}`} key={`${entry.role}-${index}`}>{entry.text}</li>)}</ol> : <div className="session-analyst__suggestions">{SUGGESTIONS.map((suggestion) => <button type="button" key={suggestion} onClick={() => void submit(suggestion)}>{suggestion}</button>)}</div>}{state.thinking ? <details><summary>Thinking</summary><pre>{state.thinking}</pre></details> : null}{state.tools.map((tool) => <p className="session-analyst__tool" key={tool.title}>{tool.title} · {tool.status}</p>)}{state.error ? <p role="alert" className="session-analyst__error">{state.error}</p> : null}</section>
      <form className="session-analyst__composer" onSubmit={(event) => { event.preventDefault(); void submit(draft); }}><label htmlFor={`analysis-${context.operationId}`}>Ask about this session</label><textarea id={`analysis-${context.operationId}`} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={state.busy} /><button type="submit" disabled={state.busy || !draft.trim()}>Send</button></form>
    </section>
  );
}
