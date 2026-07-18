import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { safeArtifactSrcdoc } from "./analysis-artifact.js";
import { useAnalysisStore } from "./analysis-store.js";

export function AnalystArtifactsPanel({ context }: { readonly context: OperationRenderContext }) {
  const { state, dispatch } = useAnalysisStore(context);
  return (
    <section className="session-analyst__artifacts" aria-label="Artifacts">
      <header><strong>Artifacts · sandboxed HTML</strong><button type="button" onClick={() => dispatch({ type: "clear-artifacts" })} disabled={!state.artifacts.length}>Clear</button></header>
      {state.artifacts.map((artifact) => {
        const srcdoc = safeArtifactSrcdoc(artifact.html);
        return srcdoc ? <article key={artifact.id}><header>{artifact.title}<span>Sandboxed</span></header><iframe title={artifact.title} srcDoc={srcdoc} sandbox="allow-scripts" /></article> : null;
      })}
    </section>
  );
}
