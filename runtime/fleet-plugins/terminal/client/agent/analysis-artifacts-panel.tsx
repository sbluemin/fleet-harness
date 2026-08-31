import type { ConsoleTheme, OperationRenderContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";
import type { AnalysisArtifact } from "./analysis-types.js";

import { analysisArtifactUrl, clearAnalysisArtifacts, type ArtifactThemeColors } from "./analysis-api.js";
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
  const exportTrigger = React.useRef<HTMLButtonElement>(null);
  const exportMenu = React.useRef<HTMLDivElement>(null);
  const copiedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposed = React.useRef(false);
  // 메뉴 인스턴스 세대 — 열림/닫힘마다 증가한다. 진행 중이던 clipboard 완료는 자신이 출발한
  // 세대가 그대로일 때만 현재 메뉴를 만질 수 있어, 닫았다 재연 메뉴로의 오귀속을 막는다.
  const exportGeneration = React.useRef(0);
  React.useEffect(() => {
    if (newestId) setActiveId(newestId);
  }, [newestId]);
  const active = artifacts.find((artifact) => artifact.id === activeId) ?? artifacts.at(-1) ?? null;
  const count = artifacts.length;
  const clearCopied = () => {
    if (copiedTimer.current !== null) {
      clearTimeout(copiedTimer.current);
      copiedTimer.current = null;
    }
    setExportCopied(false);
  };
  const closeExport = (restoreFocus = false) => {
    exportGeneration.current += 1;
    setExportOpen(false);
    clearCopied();
    if (restoreFocus) exportTrigger.current?.focus();
  };
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
      if (event.target instanceof Node && !exportShell.current?.contains(event.target)) closeExport();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeExport(true);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [exportOpen]);
  React.useEffect(() => {
    if (!active) closeExport();
  }, [active?.id]);
  React.useEffect(() => {
    // active 아티팩트 교체는 메뉴를 닫지 않으므로, 여기서 세대를 올려 이전 아티팩트를
    // 대상으로 출발한 clipboard 완료가 새 아티팩트에 "Copied"로 오귀속되지 않게 한다.
    exportGeneration.current += 1;
    clearCopied();
  }, [exportOpen, active?.id]);
  React.useEffect(() => {
    if (exportOpen) exportMenu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [exportOpen]);
  React.useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      if (copiedTimer.current !== null) {
        clearTimeout(copiedTimer.current);
        copiedTimer.current = null;
      }
    };
  }, []);

  const downloadActive = async () => {
    if (!active) return;
    closeExport(true);
    // 내려받은 파일은 그 자체로 서야 한다 — 호스트가 테마 토큰과 바닥 스타일을 주입한 문서를
    // 받아 저장한다. 모델이 쓴 원본이 필요하면 "Copy source"가 그 몫이다. 문서를 못 받으면
    // 조용히 원본으로 물러난다: 내려받기 자체가 실패하는 것보다 낫다.
    const standalone = await fetch(analysisArtifactUrl(active.id, context.theme, getArtifactColors()))
      .then((response) => (response.ok ? response.text() : null))
      .catch(() => null);
    if (disposed.current) return;
    const blob = new Blob([standalone ?? active.html], { type: "text/html" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const sanitized = active.title.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").replace(/^\.+/, "");
    const filename = /[\p{L}\p{N}]/u.test(sanitized) ? sanitized : "artifact";
    anchor.href = objectUrl;
    anchor.download = `${filename}.html`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  };
  const copyActive = async () => {
    if (!active) return;
    const generation = exportGeneration.current;
    try {
      await navigator.clipboard.writeText(active.html);
      if (disposed.current || generation !== exportGeneration.current) return;
      setExportCopied(true);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        copiedTimer.current = null;
        if (disposed.current) return;
        setExportCopied(false);
      }, 1_500);
      exportTrigger.current?.focus();
    } catch {
      if (disposed.current || generation !== exportGeneration.current) return;
      closeExport(true);
    }
  };
  const openActiveInNewTab = () => {
    if (!active) return;
    closeExport(true);
    window.open(analysisArtifactUrl(active.id, context.theme, getArtifactColors()), "_blank", "noopener");
  };
  const handleExportMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeExport(true);
      return;
    }
    if (event.key === "Tab") {
      closeExport();
      return;
    }
    const items = [...(exportMenu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  return (
    <section className="session-analyst__artifacts" aria-label={t("terminal.companion.artifacts")}>
      <header className="session-analyst__panel-head--artifacts">
        <span className="session-analyst__panel-mark--artifact" aria-hidden="true">◆</span>
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
          <button type="button" className="session-analyst__export" ref={exportTrigger} aria-haspopup="menu" aria-expanded={exportOpen} aria-controls={exportId} disabled={!active} onClick={() => { if (exportOpen) { closeExport(); } else { exportGeneration.current += 1; setExportOpen(true); } }}>{t("terminal.artifacts.export")}</button>
          {exportOpen ? (
            <div className="session-analyst__export-menu" id={exportId} role="menu" ref={exportMenu} onKeyDown={handleExportMenuKeyDown}>
              <button type="button" role="menuitem" onClick={() => { void downloadActive(); }}>{t("terminal.artifacts.exportDownload")}</button>
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
  const frame = <iframe title={artifact.title} src={analysisArtifactUrl(artifact.id, theme, getArtifactColors())} sandbox="allow-scripts" />;
  return (
    <article aria-label={t("terminal.artifacts.selectedPreview")}>
      <header><span className="session-analyst__artifact-title">{artifact.title}</span><ArtifactTime createdAt={artifact.createdAt} language={language} /></header>
      {frame}
    </article>
  );
}

function getArtifactColors(): ArtifactThemeColors {
  const consoleStyle = getComputedStyle(document.documentElement);
  const token = (name: string) => consoleStyle.getPropertyValue(name).trim();
  return {
    canvas: token("--ink-veil") || "Canvas",
    foreground: token("--ink-pearl") || "CanvasText",
    surface: token("--ink-deep"),
    hairline: token("--hairline"),
    accent: token("--aurora"),
    muted: token("--ink-muted"),
    // 신호 3색은 ink 티어를 뽑는다 — 라이트 테마에서 본문 대비(AA)를 지키는 것은 base가 아니라 ink다.
    positive: token("--positive-ink"),
    warn: token("--warn-ink"),
    critical: token("--coral-ink"),
    // 포커스/위치 채널은 brass다 — signal 토큰을 포커스 링에 쓰면 채널이 섞인다.
    focus: token("--brass"),
  };
}

function ArtifactTime({ createdAt, language }: { readonly createdAt: number; readonly language: ConsoleLocale }) {
  const t = getT(language);
  const date = new Date(createdAt);
  const valid = Number.isFinite(date.getTime());
  return <time dateTime={valid ? date.toISOString() : undefined}>{valid ? date.toLocaleTimeString(language === "ko" ? "ko-KR" : "en", { hour: "2-digit", minute: "2-digit" }) : t("terminal.artifacts.unknownTime")}</time>;
}
