import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";
import type { AnalysisArtifact } from "./analysis-types.js";

import { safeArtifactSrcdoc } from "./analysis-artifact.js";
import { useAnalysisStore } from "./analysis-store.js";

export function AnalystArtifactsPanel({ context }: { readonly context: OperationRenderContext }) {
  const { state, dispatch } = useAnalysisStore(context);
  return (
    <section className="session-analyst__artifacts" aria-label="Artifacts">
      <header><span className="session-analyst__eyebrow">SANDBOXED HTML</span><button type="button" onClick={() => dispatch({ type: "clear-artifacts" })} disabled={!state.artifacts.length}>Clear</button></header>
      {state.artifacts.length === 0 ? (
        <div className="session-analyst__artifacts-empty">
          <span className="session-analyst__frame-mark">[ HTML CANVAS ]</span>
          The analyst answers with interactive HTML here — whatever form explains the session best. Each document renders in a sandboxed frame.
        </div>
      ) : null}
      {state.artifacts.map((artifact) => {
        const srcdoc = safeArtifactSrcdoc(artifact.html);
        return srcdoc ? <ArtifactCard key={artifact.id} artifact={artifact} srcdoc={srcdoc} /> : null;
      })}
    </section>
  );
}

function ArtifactCard({ artifact, srcdoc }: { readonly artifact: AnalysisArtifact; readonly srcdoc: string }) {
  const loadCount = React.useRef(0);
  const [blocked, setBlocked] = React.useState(false);
  const handleLoad = () => {
    loadCount.current += 1;
    if (loadCount.current > 1) setBlocked(true);
  };
  return (
    <article>
      <header>{artifact.title}<span>Sandboxed</span></header>
      {blocked
        ? <p role="alert">Artifact blocked after attempting navigation.</p>
        : <iframe title={artifact.title} srcDoc={srcdoc} sandbox="allow-scripts" onLoad={handleLoad} />}
    </article>
  );
}
