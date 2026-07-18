import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";
import type { AnalysisArtifact } from "./analysis-types.js";

import { safeArtifactSrcdoc } from "./analysis-artifact.js";
import { useAnalysisStore } from "./analysis-store.js";

export function AnalystArtifactsPanel({ context }: { readonly context: OperationRenderContext }) {
  const { state, dispatch } = useAnalysisStore(context);
  const artifacts = React.useMemo(() => [...state.artifacts].reverse(), [state.artifacts]);
  const newestId = state.artifacts[0]?.id ?? null;
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [listOpen, setListOpen] = React.useState(false);
  const listId = React.useId();
  const listShell = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (newestId) setActiveId(newestId);
  }, [newestId]);
  const active = artifacts.find((artifact) => artifact.id === activeId) ?? artifacts.at(-1) ?? null;
  const count = artifacts.length;
  React.useEffect(() => {
    if (!listOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !listShell.current?.contains(event.target)) setListOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setListOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [listOpen]);
  React.useEffect(() => {
    if (!count) setListOpen(false);
  }, [count]);

  return (
    <section className="session-analyst__artifacts" aria-label="Artifacts">
      <header className="session-analyst__panel-head session-analyst__panel-head--artifacts">
        <span className="session-analyst__panel-mark session-analyst__panel-mark--artifact" aria-hidden="true">◇</span>
        <span className="session-analyst__panel-copy"><strong>Artifacts</strong><small>Visual outputs from this analysis</small></span>
        <div className="session-analyst__artifact-list-shell" ref={listShell}>
          <button type="button" className="session-analyst__artifact-count" aria-expanded={listOpen} aria-controls={listId} aria-haspopup="listbox" aria-label={`${listOpen ? "Hide" : "Show"} artifacts (${count} ${count === 1 ? "item" : "items"})`} onClick={() => setListOpen((open) => !open)} disabled={!count}>
            <strong>{count}</strong>{" "}<span>{count === 1 ? "item" : "items"}</span><i aria-hidden="true" />
          </button>
          {listOpen ? (
            <div className="session-analyst__artifact-menu" id={listId} role="listbox" aria-label="Published artifacts">
              {artifacts.map((artifact) => {
                const selected = artifact.id === active?.id;
                return (
                  <button type="button" role="option" key={artifact.id} aria-selected={selected} className={selected ? "is-active" : undefined} title={artifact.title} onClick={() => { setActiveId(artifact.id); setListOpen(false); }}>
                    <span className="session-analyst__artifact-list-mark" aria-hidden="true">◇</span>
                    <strong>{artifact.title}</strong>
                    <ArtifactTime createdAt={artifact.createdAt} />
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <button type="button" className="session-analyst__clear" onClick={() => { setListOpen(false); dispatch({ type: "clear-artifacts" }); }} disabled={!count}>Clear</button>
      </header>
      {count === 0 ? (
        <div className="session-analyst__artifacts-empty"><strong>No artifacts yet</strong>Artifacts the analyst publishes will appear here.</div>
      ) : (
        <div className="session-analyst__artifact-content">
          {active ? <ActiveArtifact key={active.id} artifact={active} /> : null}
        </div>
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
    <article aria-label="Selected artifact preview">
      <header><span className="session-analyst__artifact-title">{artifact.title}</span><ArtifactTime createdAt={artifact.createdAt} /></header>
      {blocked
        ? <p role="alert">Artifact blocked after attempting navigation.</p>
        : <iframe title={artifact.title} srcDoc={srcdoc} sandbox="allow-scripts" onLoad={handleLoad} />}
    </article>
  );
}

function ArtifactTime({ createdAt }: { readonly createdAt: number }) {
  const date = new Date(createdAt);
  const valid = Number.isFinite(date.getTime());
  return <time dateTime={valid ? date.toISOString() : undefined}>{valid ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Unknown time"}</time>;
}
