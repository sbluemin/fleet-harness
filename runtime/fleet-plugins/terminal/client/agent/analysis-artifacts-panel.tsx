import type { ConsoleTheme, OperationRenderContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";
import type { AnalysisArtifact } from "./analysis-types.js";

import { analysisArtifactUrl, clearAnalysisArtifacts } from "./analysis-api.js";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { getT } from "../i18n/index.js";
import { useAnalysisStore } from "./analysis-store.js";

export function AnalystArtifactsPanel({ context }: { readonly context: OperationRenderContext }) {
  const { state, dispatch } = useAnalysisStore(context);
  const language = context.language ?? "en";
  const t = getT(language);
  const artifacts = React.useMemo(() => [...state.artifacts].reverse(), [state.artifacts]);
  const newestId = state.artifacts[0]?.id ?? null;
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [listOpen, setListOpen] = React.useState(false);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [exportCopied, setExportCopied] = React.useState(false);
  const listId = React.useId();
  const exportId = React.useId();
  const listShell = React.useRef<HTMLDivElement>(null);
  const exportShell = React.useRef<HTMLDivElement>(null);
  const copiedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
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
  React.useEffect(() => {
    if (!exportOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !exportShell.current?.contains(event.target)) setExportOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExportOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [exportOpen]);
  React.useEffect(() => {
    if (!active) setExportOpen(false);
  }, [active]);
  React.useEffect(() => () => {
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
  }, []);

  const downloadActive = () => {
    if (!active) return;
    setExportOpen(false);
    const blob = new Blob([active.html], { type: "text/html" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const filename = active.title.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "artifact";
    anchor.href = objectUrl;
    anchor.download = `${filename}.html`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  };
  const copyActive = async () => {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.html);
      setExportCopied(true);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        copiedTimer.current = null;
        setExportCopied(false);
      }, 1_500);
    } catch {
      setExportOpen(false);
    }
  };
  const openActiveInNewTab = () => {
    if (!active) return;
    setExportOpen(false);
    const { canvas, foreground } = getArtifactColors();
    window.open(analysisArtifactUrl(active.id, context.theme, canvas, foreground), "_blank", "noopener");
  };

  return (
    <section className="session-analyst__artifacts" aria-label={t("terminal.companion.artifacts")}>
      <header className="session-analyst__panel-head session-analyst__panel-head--artifacts">
        <span className="session-analyst__panel-mark session-analyst__panel-mark--artifact" aria-hidden="true">◇</span>
        <span className="session-analyst__panel-copy"><strong>{t("terminal.companion.artifacts")}</strong><small>{t("terminal.artifacts.subtitle")}</small></span>
        <div className="session-analyst__artifact-list-shell" ref={listShell}>
          <button type="button" className="session-analyst__artifact-count" aria-expanded={listOpen} aria-controls={listId} aria-haspopup="listbox" aria-label={t(listOpen ? (count === 1 ? "terminal.artifacts.hideCount_one" : "terminal.artifacts.hideCount_other") : (count === 1 ? "terminal.artifacts.showCount_one" : "terminal.artifacts.showCount_other"), { count })} onClick={() => setListOpen((open) => !open)} disabled={!count}>
            <strong>{count}</strong>{" "}<span>{language === "ko" ? "개" : count === 1 ? "item" : "items"}</span><i aria-hidden="true" />
          </button>
          {listOpen ? (
            <div className="session-analyst__artifact-menu" id={listId} role="listbox" aria-label={t("terminal.artifacts.published")}>
              {artifacts.map((artifact) => {
                const selected = artifact.id === active?.id;
                return (
                  <button type="button" role="option" key={artifact.id} aria-selected={selected} className={selected ? "is-active" : undefined} title={artifact.title} onClick={() => { setActiveId(artifact.id); setListOpen(false); }}>
                    <span className="session-analyst__artifact-list-mark" aria-hidden="true">◇</span>
                    <strong>{artifact.title}</strong>
                    <ArtifactTime createdAt={artifact.createdAt} language={language} />
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="session-analyst__export-shell" ref={exportShell}>
          <button type="button" className="session-analyst__export" aria-haspopup="menu" aria-expanded={exportOpen} aria-controls={exportId} disabled={!active} onClick={() => setExportOpen((open) => !open)}>{t("terminal.artifacts.export")}</button>
          {exportOpen ? (
            <div className="session-analyst__export-menu" id={exportId} role="menu">
              <button type="button" role="menuitem" onClick={downloadActive}>{t("terminal.artifacts.exportDownload")}</button>
              <button type="button" role="menuitem" onClick={() => { void copyActive(); }}>{t(exportCopied ? "terminal.artifacts.exportCopied" : "terminal.artifacts.exportCopy")}</button>
              <button type="button" role="menuitem" onClick={openActiveInNewTab}>{t("terminal.artifacts.exportOpenTab")}</button>
            </div>
          ) : null}
        </div>
        <button type="button" className="session-analyst__clear" onClick={() => { setListOpen(false); dispatch({ type: "clear-artifacts" }); void clearAnalysisArtifacts(context.api, context.operationId).catch(() => {}); }} disabled={!count}>{t("terminal.artifacts.clear")}</button>
      </header>
      {count === 0 ? (
        <div className="session-analyst__artifacts-empty"><strong>{t("terminal.artifacts.emptyTitle")}</strong>{t("terminal.artifacts.emptyBody")}</div>
      ) : (
        <div className="session-analyst__artifact-content">
          {active ? <ActiveArtifact key={active.id} artifact={active} theme={context.theme} language={language} /> : null}
        </div>
      )}
    </section>
  );
}

function ActiveArtifact({ artifact, theme, language }: { readonly artifact: AnalysisArtifact; readonly theme: ConsoleTheme; readonly language: ConsoleLocale }) {
  if (!artifact.id) return null;
  const t = getT(language);
  const { canvas, foreground } = getArtifactColors();
  return (
    <article aria-label={t("terminal.artifacts.selectedPreview")}>
      <header><span className="session-analyst__artifact-title">{artifact.title}</span><ArtifactTime createdAt={artifact.createdAt} language={language} /></header>
      <iframe title={artifact.title} src={analysisArtifactUrl(artifact.id, theme, canvas, foreground)} sandbox="allow-scripts" />
    </article>
  );
}

function getArtifactColors(): { readonly canvas: string; readonly foreground: string } {
  const consoleStyle = getComputedStyle(document.documentElement);
  return {
    canvas: consoleStyle.getPropertyValue("--ink-veil").trim() || "Canvas",
    foreground: consoleStyle.getPropertyValue("--ink-pearl").trim() || "CanvasText",
  };
}

function ArtifactTime({ createdAt, language }: { readonly createdAt: number; readonly language: ConsoleLocale }) {
  const t = getT(language);
  const date = new Date(createdAt);
  const valid = Number.isFinite(date.getTime());
  return <time dateTime={valid ? date.toISOString() : undefined}>{valid ? date.toLocaleTimeString(language === "ko" ? "ko-KR" : "en", { hour: "2-digit", minute: "2-digit" }) : t("terminal.artifacts.unknownTime")}</time>;
}
