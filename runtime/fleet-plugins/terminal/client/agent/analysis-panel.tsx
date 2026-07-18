import { React, type OperationRenderContext } from "@fleet-console/sdk/plugin/browser";
import { fetchAnalysisCatalog, sendAnalysisMessage, startAnalysis, subscribeAnalysis } from "./analysis-api.js";
import { safeArtifactSrcdoc } from "./analysis-artifact.js";
import { analysisReducer, initialAnalysisState } from "./analysis-state.js";

const SUGGESTIONS = ["Summarize the current session.", "What changed most recently?", "Identify the next useful check.", "Create a concise status artifact."];
export function AnalysisPanel({ context }: { readonly context: OperationRenderContext }) {
  const [state, dispatch] = React.useReducer(analysisReducer, initialAnalysisState);
  const [draft, setDraft] = React.useState("");
  const unsubscribe = React.useRef<(() => void) | null>(null);
  React.useEffect(() => { void fetchAnalysisCatalog(context.api).then((catalog) => dispatch({ type: "catalog", catalog })).catch((error: unknown) => dispatch({ type: "error", message: error instanceof Error ? error.message : "Analysis is unavailable." })); return () => unsubscribe.current?.(); }, [context.api]);
  const submit = async (text: string) => {
    const trimmed = text.trim(); if (!trimmed || state.busy) return;
    dispatch({ type: "sending", started: !state.started }); setDraft("");
    try { if (!state.started) { await startAnalysis(context.api, context.operationId, { cliId: state.cliId, model: state.model, effort: state.effort }); unsubscribe.current = subscribeAnalysis(context.api, context.operationId, (event) => dispatch({ type: "event", event })); } await sendAnalysisMessage(context.api, context.operationId, trimmed); } catch (error) { dispatch({ type: "error", message: error instanceof Error ? error.message : "Analysis is unavailable." }); }
  };
  const cli = state.catalog?.clis.find((item) => item.cliId === state.cliId);
  const model = cli?.models.find((item) => item.id === state.model);
  return <aside className="session-analyst" aria-label="Session Analyst">
    <header className="session-analyst__hero"><span>SESSION ANALYST</span><strong>Read the work without touching it.</strong><p>Ask for a concise, evidence-led view of this active session.</p></header>
    <div className="session-analyst__selectors">
      <label>CLI<select aria-label="Analysis CLI" disabled={state.started || !state.catalog} value={state.cliId} onChange={(event) => dispatch({ type: "select-cli", cliId: event.target.value })}>{state.catalog?.clis.map((item) => <option key={item.cliId} value={item.cliId} disabled={!item.available}>{item.label}</option>)}</select></label>
      <label>Model<select aria-label="Analysis model" disabled={state.started || !model} value={state.model} onChange={(event) => dispatch({ type: "select-model", model: event.target.value })}>{cli?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Effort<select aria-label="Analysis effort" disabled={state.started || !model} value={state.effort} onChange={(event) => dispatch({ type: "select-effort", effort: event.target.value })}>{model?.effortLevels.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
    </div>
    <section className="session-analyst__chat" aria-live="polite">{state.output ? <p>{state.output}</p> : <div className="session-analyst__suggestions">{SUGGESTIONS.map((suggestion) => <button type="button" key={suggestion} onClick={() => void submit(suggestion)}>{suggestion}</button>)}</div>}{state.thought ? <details><summary>Thinking</summary><pre>{state.thought}</pre></details> : null}{state.tools.map((tool) => <p className="session-analyst__tool" key={tool.title}>{tool.title} · {tool.status}</p>)}{state.error ? <p role="alert" className="session-analyst__error">{state.error}</p> : null}</section>
    <form className="session-analyst__composer" onSubmit={(event) => { event.preventDefault(); void submit(draft); }}><label htmlFor={`analysis-${context.operationId}`}>Ask about this session</label><textarea id={`analysis-${context.operationId}`} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={state.busy} /><button type="submit" disabled={state.busy || !draft.trim()}>Send</button></form>
    <section className="session-analyst__artifacts" aria-label="Artifacts"><div><strong>Artifacts</strong><button type="button" onClick={() => dispatch({ type: "clear-artifacts" })} disabled={!state.artifacts.length}>Clear</button></div>{state.artifacts.map((artifact) => { const srcdoc = safeArtifactSrcdoc(artifact.html); return srcdoc ? <article key={artifact.id}><header>{artifact.title}<span>Sandboxed</span></header><iframe title={artifact.title} srcDoc={srcdoc} sandbox="allow-scripts" /></article> : null; })}</section>
  </aside>;
}
