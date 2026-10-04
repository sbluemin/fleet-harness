import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { MobileBarMenuItem, PaneContext } from "@fleet-console/sdk/pane";

import type { FolderEntry, FolderListResult } from "../server/types.js";
import { loadDocument, nameOfPath } from "./doc-loader.js";
import { DOCUMENT_PANE_ID } from "./file-navigation.js";
import { LIST_TIMEOUT_MS, makeFilesClient } from "./files-client.js";
import { getT } from "./i18n/index.js";
import { readShowHidden, sortEntries } from "./tree.js";
import { activateStoredDocument, getFileExplorerSnapshot, setDocumentPaneOpen, useFileExplorerViewState } from "./view-store.js";
import { BinaryViewer } from "./viewer/binary.js";
import { CodeViewer } from "./viewer/code.js";
import { ImageViewer } from "./viewer/image.js";
import { MarkdownViewer, resolveFileExplorerWikiLink } from "./viewer/markdown.js";
import { parentDirOf } from "./viewer/stale.js";
import "./mobile.css";

/**
 * 모바일 목적지 「파일」 — 트리(S-42)와 파일 상세(S-43). 호스트가 페인 컨텍스트에 `mobileBar`를 실을 때만 선다.
 * 막대는 호스트가 그리고 여기서는 제목·부제·깊이·뒤로·⋮ 만 선언한다. 목록·문서는 데스크톱과 같은 창구(`files/list`·
 * `loadDocument`)와 같은 뷰어를 쓴다 — 모양만 모바일 문법이다.
 */

const TOAST_MS = 6_000;

const Icon = ({ children, size = 20 }: { readonly children: ReactNode; readonly size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const FolderGlyph = () => <Icon size={18}><path d="M3 6h6l2 2h10v11H3z" /></Icon>;
const FileGlyph = () => <Icon size={18}><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></Icon>;
const Chevron = ({ open }: { readonly open: boolean }) => <Icon size={16}><path d={open ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} /></Icon>;
const TermIcon = () => <Icon><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 10l3 2-3 2M13 15h4" /></Icon>;
const CopyIcon = () => <Icon><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M5 16V6a2 2 0 0 1 2-2h9" /></Icon>;

function useTheaterLabel(ctx: PaneContext): string {
  const { consoleState, theaterId } = ctx;
  return useSyncExternalStore(consoleState.subscribe, () => consoleState.getTheaters().find((theater) => theater.id === theaterId)?.label ?? "", () => "");
}

type Folder = { readonly kind: "loaded"; readonly result: FolderListResult } | { readonly kind: "loading" } | { readonly kind: "failed" };

// ── 트리 ──

export function MobileFileTree(ctx: PaneContext) {
  const t = getT(ctx.language);
  const { theaterId, mobileBar, panes, visible } = ctx;
  const label = useTheaterLabel(ctx);
  const files = useMemo(() => makeFilesClient(theaterId), [theaterId]);
  const [folders, setFolders] = useState<ReadonlyMap<string, Folder>>(new Map());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const showHidden = useMemo(() => readShowHidden(), []);
  const title = t("fileExplorer.panel.title");

  useEffect(() => { if (visible) mobileBar?.set({ title, ...(label ? { subtitle: label } : {}), depth: 0 }); }, [mobileBar, visible, title, label]);

  const clientRef = useRef(files);
  clientRef.current = files;
  /**
   * 폴더 하나를 읽는다. `quiet`면 이미 그린 목록을 로딩 줄로 바꾸지 않고 응답이 오면 갈아 끼운다(다시 보일 때의 재검증).
   * 늦게 온 앞 Theater 의 응답은 버린다 — 응답이 자기 클라이언트가 아직 현재일 때만 지도에 오른다.
   */
  const load = useCallback((relativePath: string, quiet = false) => {
    if (!quiet) setFolders((current) => new Map(current).set(relativePath, { kind: "loading" }));
    const settle = (folder: Folder) => { if (clientRef.current === files) setFolders((current) => new Map(current).set(relativePath, folder)); };
    files.listFolder(relativePath || undefined, { timeoutMs: LIST_TIMEOUT_MS })
      .then((result) => settle({ kind: "loaded", result }))
      .catch(() => { if (!quiet) settle({ kind: "failed" }); });
  }, [files]);

  // Theater 가 바뀌면 처음부터 다시 연다.
  useEffect(() => {
    if (!theaterId) return;
    setFolders(new Map());
    setOpen(new Set());
    load("");
  }, [theaterId, load]);

  // 모바일 트리는 watch 연결을 열지 않는다(F3 — 브라우저의 출처당 연결 자리를 아낀다). 대신 이 화면에 다시 들어오거나
  // 앱이 다시 보일 때 루트와 펼친 폴더를 조용히 다시 읽어 낡은 트리가 남지 않게 한다.
  const openRef = useRef(open);
  openRef.current = open;
  const revalidate = useCallback(() => {
    if (!theaterId) return;
    for (const relativePath of ["", ...openRef.current]) load(relativePath, true);
  }, [theaterId, load]);
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) revalidate();
    wasVisible.current = visible;
  }, [visible, revalidate]);
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === "visible") revalidate(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [revalidate]);

  const toggle = (entry: FolderEntry) => {
    const next = new Set(open);
    if (next.has(entry.relativePath)) next.delete(entry.relativePath);
    else {
      next.add(entry.relativePath);
      if (folders.get(entry.relativePath)?.kind !== "loaded") load(entry.relativePath);
    }
    setOpen(next);
  };
  const openFile = (entry: FolderEntry) => {
    if (!theaterId) return;
    activateStoredDocument(theaterId, { relativePath: entry.relativePath, name: entry.name, preview: true });
    panes.open({ paneId: DOCUMENT_PANE_ID, params: { path: entry.relativePath, theaterId } });
  };

  const rows = (relativePath: string, depth: number): ReactNode[] => {
    const folder = folders.get(relativePath);
    const indent = { paddingLeft: `${16 + depth * 18}px` };
    if (!folder || folder.kind === "loading") return [<p key={`${relativePath}:loading`} className="fexp-m-note" style={indent} role="status">{t("fileExplorer.status.loading")}</p>];
    if (folder.kind === "failed") {
      return [<button key={`${relativePath}:failed`} type="button" className="fexp-m-note is-retry" style={indent} onClick={() => load(relativePath)}>{t("fileExplorer.status.loadFailedTitle")} · {t("fileExplorer.status.loadFailedRetry")}</button>];
    }
    const entries = sortEntries(folder.result.entries, "name").filter((entry) => showHidden || !entry.name.startsWith("."));
    if (entries.length === 0) return [<p key={`${relativePath}:empty`} className="fexp-m-note" style={indent}>{t("fileExplorer.status.emptyFolder")}</p>];
    return entries.flatMap((entry) => {
      const isDir = entry.kind === "dir";
      const expanded = isDir && open.has(entry.relativePath);
      const row = (
        <button key={entry.relativePath} type="button" className="fexp-m-row" style={indent} aria-expanded={isDir ? expanded : undefined} onClick={() => (isDir ? toggle(entry) : openFile(entry))}>
          <span className="fexp-m-row-icon">{isDir ? <FolderGlyph /> : <FileGlyph />}</span>
          <span className="fexp-m-row-name">{entry.name}</span>
          {isDir ? <span className="fexp-m-row-chev"><Chevron open={expanded} /></span> : null}
        </button>
      );
      return expanded ? [row, ...rows(entry.relativePath, depth + 1)] : [row];
    });
  };

  return <div className="fexp-m fexp-m-tree" role="tree" aria-label={title}>{theaterId ? rows("", 0) : null}</div>;
}

// ── 파일 상세 ──

export function MobileFileDocument(ctx: PaneContext) {
  const t = getT(ctx.language);
  const { mobileBar, panes, visible, shell, language, signal, navigate } = ctx;
  const theaterId = ctx.params.theaterId || ctx.theaterId;
  const path = ctx.params.path ?? "";
  const { docStates } = useFileExplorerViewState(theaterId);
  const viewState = path ? docStates.get(path) ?? { kind: "loading" as const } : { kind: "none" as const };
  const [source, setSource] = useState(false);
  const [toast, setToast] = useState<{ readonly text: string; readonly at: number } | null>(null);
  const name = path ? nameOfPath(path) : "";

  useEffect(() => { setSource(false); }, [path]);
  useEffect(() => {
    if (!theaterId || !path) return;
    // 문서를 바꿀 때만 읽는다 — 캐시가 있으면 로딩 화면 없이 배경에서 다시 확인한다.
    void loadDocument(theaterId, path, { silent: getFileExplorerSnapshot(theaterId).docStates.has(path), language, signal });
  }, [theaterId, path, language, signal]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const latest = useRef({ theaterId, path, t });
  latest.current = { theaterId, path, t };
  const openShell = useCallback(() => {
    const { theaterId: id, path: current, t: translate } = latest.current;
    if (!id || !current) return;
    void shell.openAt({ theaterId: id, path: parentDirOf(current) })
      .then((result) => { if (!result.ok) setToast({ text: translate(`fileExplorer.shell.${result.reason}`), at: Date.now() }); })
      .catch(() => setToast({ text: translate("fileExplorer.shell.failed"), at: Date.now() }));
  }, [shell]);
  // 폰의 클립보드에 넣는다 — 서버 클립보드(절대 경로 복사)는 Console 이 도는 컴퓨터의 클립보드라 폰에서는 쓸모가 없다.
  const copyPath = useCallback(() => {
    const { path: current, t: translate } = latest.current;
    void navigator.clipboard.writeText(current)
      .then(() => setToast({ text: translate("fileExplorer.menu.relativePathCopied"), at: Date.now() }))
      .catch(() => setToast({ text: translate("fileExplorer.menu.actionUnavailable"), at: Date.now() }));
  }, []);

  useEffect(() => {
    if (!visible || !mobileBar) return;
    const items: MobileBarMenuItem[] = [
      { id: "shell", label: t("fileExplorer.shell.open"), icon: <TermIcon />, run: openShell },
      { id: "copy", label: t("fileExplorer.mobile.copyPath"), icon: <CopyIcon />, run: copyPath },
    ];
    mobileBar.set({
      title: name,
      depth: 1,
      onBack: () => { if (theaterId) setDocumentPaneOpen(theaterId, false); panes.close(); },
      menu: { caption: name, items },
    });
  }, [mobileBar, visible, name, t, panes, theaterId, openShell, copyPath]);

  const isCode = viewState.kind === "code";
  const isMarkdown = isCode && viewState.lang === "markdown";
  return (
    <div className="fexp-m fexp-m-doc">
      {isCode ? (
        <div className="fexp-m-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!source} className={source ? "" : "is-on"} onClick={() => setSource(false)}>{t("fileExplorer.viewer.previewMode")}</button>
          <button type="button" role="tab" aria-selected={source} className={source ? "is-on" : ""} onClick={() => setSource(true)}>{t("fileExplorer.viewer.sourceMode")}</button>
        </div>
      ) : null}
      <div className="fexp-m-doc-body">
        {viewState.kind === "loading" ? <p className="fexp-m-note" role="status">{t("fileExplorer.status.loading")}</p> : null}
        {viewState.kind === "error" ? <p className="fexp-m-note is-error">{viewState.message}</p> : null}
        {isCode && isMarkdown && !source ? (
          <div className="fexp-m-reading">
            <MarkdownViewer content={viewState.content} navigate={navigate} resolveWikiLink={resolveFileExplorerWikiLink} relativePath={viewState.relativePath} theaterId={theaterId} truncated={viewState.truncated} language={language} />
          </div>
        ) : null}
        {isCode && (!isMarkdown || source) ? (
          <div className="fexp-m-code">
            <CodeViewer content={viewState.content} lang={viewState.lang} truncated={viewState.truncated && !viewState.window} readWindow={viewState.window} wrap t={t} />
          </div>
        ) : null}
        {viewState.kind === "image" ? <ImageViewer src={viewState.src} name={viewState.name} sizeBytes={viewState.sizeBytes} t={t} /> : null}
        {viewState.kind === "binary" ? <BinaryViewer name={viewState.name} t={t} /> : null}
      </div>
      {toast ? createPortal(<div key={toast.at} className="fexp-m-toast" role="status">{toast.text}</div>, document.body) : null}
    </div>
  );
}
