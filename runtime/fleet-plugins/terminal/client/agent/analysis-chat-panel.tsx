import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { useAnalysisStore } from "./analysis-store.js";

// 승인 시안의 제안 카드 4종 — 카피와 톤 아이콘(◈ 흐름/● 현재/▲ 리뷰/≡ 브리프)을 함께 고정한다.
const SUGGESTIONS = [
  { icon: "◈", tone: "aurora", text: "Walk me through how this session unfolded" },
  { icon: "●", tone: "positive", text: "What is the agent doing right now?" },
  { icon: "▲", tone: "coral", text: "Flag anything I should review" },
  { icon: "≡", tone: "brass", text: "Draft a handoff brief" },
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
      <section className="session-analyst__chat" aria-live="polite">
        {state.entries.length ? (
          <ol>{state.entries.map((entry, index) => <li className={`session-analyst__message session-analyst__message--${entry.role}`} key={`${entry.role}-${index}`}>{entry.text}</li>)}</ol>
        ) : (
          <div className="session-analyst__hero-wrap">
            <header className="session-analyst__hero">
              <span className="session-analyst__sigil" aria-hidden="true">✳</span>
              <h2>Ask about this session</h2>
              <p>The analyst watches the host agent&apos;s transcript — it never interrupts the work.</p>
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
        {state.thinking ? <details><summary>Thinking</summary><pre>{state.thinking}</pre></details> : null}
        {state.tools.map((tool) => <p className="session-analyst__tool" key={tool.title}>{tool.title} · {tool.status}</p>)}
        {state.error ? <p role="alert" className="session-analyst__error">{state.error}</p> : null}
      </section>
      <form className="session-analyst__composer" onSubmit={(event) => { event.preventDefault(); void submit(draft); }}>
        <label className="session-analyst__sr-only" htmlFor={`analysis-${context.operationId}`}>Ask about this session</label>
        <textarea id={`analysis-${context.operationId}`} placeholder="Ask about the session…" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={state.busy} />
        <div className="session-analyst__composer-meta">
          <span className="session-analyst__select"><select aria-label="Analysis CLI" disabled={state.started || !state.catalog} value={state.cliId} onChange={(event) => dispatch({ type: "select-cli", cliId: event.target.value })}>{state.catalog?.clis.map((item) => <option key={item.cliId} value={item.cliId} disabled={!item.available}>{item.label}</option>)}</select></span>
          <span className="session-analyst__select"><select aria-label="Analysis model" disabled={state.started || !model} value={state.model} onChange={(event) => dispatch({ type: "select-model", model: event.target.value })}>{cli?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></span>
          <span className="session-analyst__select"><select aria-label="Analysis effort" disabled={state.started || !model || !model.effortLevels.length} value={state.effort} onChange={(event) => dispatch({ type: "select-effort", effort: event.target.value })}>{model?.effortLevels.length ? model.effortLevels.map((item) => <option key={item} value={item}>{item}</option>) : <option value="">n/a</option>}</select></span>
          <button type="submit" className="session-analyst__send" aria-label="Send" disabled={state.busy || !draft.trim()}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 10 V2 M2.5 5.5 L6 2 l3.5 3.5" /></svg>
          </button>
        </div>
      </form>
    </section>
  );
}
