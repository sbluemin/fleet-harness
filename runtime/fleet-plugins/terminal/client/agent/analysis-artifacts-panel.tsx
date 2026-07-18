import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";
import type { AnalysisArtifact } from "./analysis-types.js";

import { safeArtifactSrcdoc } from "./analysis-artifact.js";
import { useAnalysisStore } from "./analysis-store.js";

export function AnalystArtifactsPanel({ context }: { readonly context: OperationRenderContext }) {
  const { state, dispatch } = useAnalysisStore(context);
  // 스토어는 최신 우선으로 쌓지만 탭 목록은 생성순(오래된 것부터)으로 고정한다.
  const artifacts = React.useMemo(() => [...state.artifacts].reverse(), [state.artifacts]);
  const newestId = state.artifacts[0]?.id ?? null;
  const [activeId, setActiveId] = React.useState<string | null>(null);
  // 새 아티팩트가 게시되면 그 문서를 활성 탭으로 전환한다.
  React.useEffect(() => {
    if (newestId) setActiveId(newestId);
  }, [newestId]);
  const active = artifacts.find((artifact) => artifact.id === activeId) ?? artifacts.at(-1) ?? null;
  return (
    <section className="session-analyst__artifacts" aria-label="Artifacts">
      <header><span className="session-analyst__eyebrow">SANDBOXED HTML</span><button type="button" onClick={() => dispatch({ type: "clear-artifacts" })} disabled={!state.artifacts.length}>Clear</button></header>
      {artifacts.length === 0 ? (
        <div className="session-analyst__artifacts-empty">Artifacts the analyst publishes will appear here.</div>
      ) : (
        <>
          <div className="session-analyst__artifact-tabs" role="tablist" aria-label="Published artifacts">
            {artifacts.map((artifact) => (
              <button type="button" role="tab" key={artifact.id} aria-selected={artifact.id === active?.id} className={artifact.id === active?.id ? "is-active" : undefined} title={artifact.title} onClick={() => setActiveId(artifact.id)}>{artifact.title}</button>
            ))}
          </div>
          {active ? <ActiveArtifact key={active.id} artifact={active} /> : null}
        </>
      )}
    </section>
  );
}

function ActiveArtifact({ artifact }: { readonly artifact: AnalysisArtifact }) {
  const loadCount = React.useRef(0);
  const [blocked, setBlocked] = React.useState(false);
  const srcdoc = safeArtifactSrcdoc(artifact.html);
  if (!srcdoc) return null;
  const handleLoad = () => {
    loadCount.current += 1;
    if (loadCount.current > 1) setBlocked(true);
  };
  return (
    <article>
      <header><span className="session-analyst__sandbox-mark">▣ Sandboxed</span><span className="session-analyst__artifact-title">{artifact.title}</span></header>
      {blocked
        ? <p role="alert">Artifact blocked after attempting navigation.</p>
        : <iframe title={artifact.title} srcDoc={srcdoc} sandbox="allow-scripts" onLoad={handleLoad} />}
    </article>
  );
}
