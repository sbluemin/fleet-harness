import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { FileReadResult, FolderEntry, FolderListResult } from "../server/types.js";
import "./explorer.css";
import { FileTree, type PluginFilesClient } from "./tree.js";
import { adaptFolderList, contextKey, prefixContextPath } from "./path-context.js";
import { BinaryViewer } from "./viewer/binary.js";
import { CodeViewer } from "./viewer/code.js";
import { ImageViewer } from "./viewer/image.js";
import { MarkdownViewer } from "./viewer/markdown.js";
import {
  buildSplitGridTemplate,
  canResizeTreePane,
  clampTreePaneWidth,
  resolveExtraWidth,
} from "./layout.js";
import { setSelectedPath, setTreePaneWidth, setViewState, useFileExplorerViewState } from "./view-store.js";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export const fileExplorerPanel: RailPanelDescriptor = {
  id: "file-explorer",
  title: "Files",
  icon: FileExplorerIcon,
  pathAware: true,
  render: (ctx) => <FileExplorerPanel {...ctx} />,
};

function makeFilesClient(theaterId: string | null, contextRelPath: string | null): PluginFilesClient {
  return {
    listFolder: async (relativePath?) => {
      if (!theaterId) throw new Error("no_theater");
      const res = await fetch("/plugins/file-explorer/files/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId, relativePath: prefixContextPath(contextRelPath, relativePath ?? "") }),
      });
      if (!res.ok) {
        const payload = await res.json() as { error?: string };
        throw new Error(payload.error ?? "list_failed");
      }
      const result = await res.json() as FolderListResult;
      const adapted = adaptFolderList(contextRelPath, result);
      if (!adapted) throw new Error("context_boundary");
      return adapted;
    },
  };
}

function FileExplorerPanel(ctx: RailPanelContext) {
  const { theaterId } = ctx;
  const contextRelPath = ctx.pathContext.relPath;
  const contextScope = contextKey(theaterId, contextRelPath);
  const { selectedPath, viewState, treePaneWidth } = useFileExplorerViewState(contextScope);
  const treePaneWidthRef = useRef(treePaneWidth);
  treePaneWidthRef.current = treePaneWidth;
  const rootRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // theaterId 변경마다 새 클라이언트 인스턴스를 생성한다(PluginFilesClient는 stateless).
  const files = useMemo(() => makeFilesClient(theaterId, contextRelPath), [theaterId, contextRelPath]);

  const openFilePath = useCallback(async (relativePath: string, displayName?: string) => {
    if (!theaterId) {
      setViewState(theaterId, { kind: "error", message: "no_theater" });
      return;
    }
    setSelectedPath(contextScope, relativePath);
    const name = displayName ?? relativePath.split("/").filter(Boolean).at(-1) ?? relativePath;
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();

    if (IMAGE_EXTS.has(ext)) {
      const src = theaterId
        ? `/plugins/file-explorer/files/image?theaterId=${encodeURIComponent(theaterId)}&path=${encodeURIComponent(prefixContextPath(contextRelPath, relativePath) ?? "")}`
        : "";
      setViewState(contextScope, { kind: "image", relativePath, name, src });
      return;
    }

    setViewState(contextScope, { kind: "loading" });
    try {
      // files/read는 422(binary_file)를 error 바디로 반환하므로 raw fetch로 직접 처리한다.
      const res = await fetch("/plugins/file-explorer/files/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId, relativePath: prefixContextPath(contextRelPath, relativePath) }),
      });
      if (!res.ok) {
        const payload = await res.json() as { error?: string };
        throw new Error(payload.error ?? "read_failed");
      }
      const result = await res.json() as FileReadResult;
      if (result.binary) {
        setViewState(contextScope, { kind: "binary", name });
        return;
      }
      const resultPath = adaptFolderList(contextRelPath, { relativePath: result.relativePath, parentRelativePath: null, entries: [] })?.relativePath;
      if (resultPath === undefined) throw new Error("context_boundary");
      setViewState(contextScope, { kind: "code", relativePath: resultPath, content: result.content, lang: result.lang, truncated: result.truncated });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unable to load file";
      if (msg === "binary_file") {
        setViewState(contextScope, { kind: "binary", name });
      } else {
        setViewState(contextScope, { kind: "error", message: msg });
      }
    }
  }, [contextRelPath, contextScope, theaterId]);
  const handleSelect = useCallback(async (entry: FolderEntry) => {
    if (entry.kind !== "file") return;
    await openFilePath(entry.relativePath, entry.name);
  }, [openFilePath]);

  const handleCloseViewer = useCallback(() => {
    setViewState(contextScope, { kind: "none" });
    setSelectedPath(contextScope, null);
  }, [contextScope]);

  const handleDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = rootRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    if (!canResizeTreePane(containerWidth)) return;
    const startX = e.clientX;
    const startWidth = treePaneWidthRef.current;
    setIsDragging(true);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const nextWidth = clampTreePaneWidth(startWidth, dx, containerWidth);
      treePaneWidthRef.current = nextWidth;
      setTreePaneWidth(nextWidth);
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setIsDragging(false);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  const isViewerActive = viewState.kind !== "none";

  useLayoutEffect(() => {
    ctx.requestExtraWidth?.(resolveExtraWidth(isViewerActive));
  }, [ctx, isViewerActive]);

  return (
    <div
      ref={rootRef}
      className={`fexp-root${isViewerActive ? " is-split" : " is-tree-only"}${isDragging ? " is-dragging" : ""}`}
      style={isViewerActive
        ? { gridTemplateColumns: buildSplitGridTemplate(treePaneWidth) }
        : undefined}
    >
      {isViewerActive && (
        <>
          <div className="fexp-viewer-pane">
            <div className="fexp-viewer-head">
              <span className="fexp-viewer-filename">
                {viewState.kind !== "loading" && viewState.kind !== "error"
                  ? "relativePath" in viewState ? viewState.relativePath : viewState.name
                  : ""}
              </span>
              <button className="fexp-viewer-close" type="button" onClick={handleCloseViewer} aria-label="Close viewer">
                ✕
              </button>
            </div>
            <div className="fexp-viewer-body">
              {viewState.kind === "loading" && <div className="fexp-viewer-loading">Loading…</div>}
              {viewState.kind === "error" && <div className="fexp-viewer-error">{viewState.message}</div>}
              {viewState.kind === "code" && viewState.lang === "markdown" && (
                <MarkdownViewer
                  content={viewState.content}
                  onOpenPath={openFilePath}
                  relativePath={viewState.relativePath}
                  theaterId={theaterId}
                  truncated={viewState.truncated}
                  contextRelPath={contextRelPath}
                />
              )}
              {viewState.kind === "code" && viewState.lang !== "markdown" && (
                <CodeViewer content={viewState.content} lang={viewState.lang} truncated={viewState.truncated} />
              )}
              {viewState.kind === "image" && (
                <ImageViewer src={viewState.src} name={viewState.name} />
              )}
              {viewState.kind === "binary" && (
                <BinaryViewer name={viewState.name} />
              )}
            </div>
          </div>
          <div
            className="fexp-divider"
            onPointerDown={handleDividerDown}
            aria-hidden="true"
          />
        </>
      )}
      <div className="fexp-tree-pane">
        <FileTree
          files={files}
          theaterId={theaterId}
          contextKey={contextScope}
          contextRelPath={contextRelPath}
          selectedPath={selectedPath}
          onSelect={handleSelect}
        />
      </div>
    </div>
  );
}

function FileExplorerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3 5a2 2 0 012-2h3.586a1 1 0 01.707.293L10.707 4.7A1 1 0 0011.414 5H15a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
