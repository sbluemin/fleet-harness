import { useCallback, useMemo, useRef, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { FileReadResult, FolderEntry, FolderListResult } from "../server/types.js";
import "./explorer.css";
import { FileTree, type PluginFilesClient } from "./tree.js";
import { BinaryViewer } from "./viewer/binary.js";
import { CodeViewer } from "./viewer/code.js";
import { ImageViewer } from "./viewer/image.js";
import { MarkdownViewer } from "./viewer/markdown.js";

type ViewState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "code"; relativePath: string; content: string; lang: string; truncated?: boolean }
  | { kind: "image"; relativePath: string; name: string; src: string }
  | { kind: "binary"; name: string }
  | { kind: "error"; message: string };

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const PREFS_SPLIT_RATIO = "fleet-console.fileExplorer.splitRatio";
const MIN_VIEWER_PX = 200;
const MIN_TREE_PX = 160;
const DEFAULT_SPLIT_RATIO = 0.55;

function readSplitRatio(): number {
  try {
    const v = localStorage.getItem(PREFS_SPLIT_RATIO);
    if (v !== null) {
      const n = parseFloat(v);
      if (!isNaN(n) && n > 0 && n < 1) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_SPLIT_RATIO;
}

function makeFilesClient(theaterId: string | null): PluginFilesClient {
  return {
    listFolder: async (relativePath?) => {
      if (!theaterId) throw new Error("no_theater");
      const res = await fetch("/plugins/file-explorer/files/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId, relativePath: relativePath ?? "" }),
      });
      if (!res.ok) {
        const payload = await res.json() as { error?: string };
        throw new Error(payload.error ?? "list_failed");
      }
      return res.json() as Promise<FolderListResult>;
    },
  };
}

function FileExplorerPanel({ theaterId }: RailPanelContext) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewState, setViewState] = useState<ViewState>({ kind: "none" });
  const [splitRatio, setSplitRatioState] = useState(readSplitRatio);
  const splitRatioRef = useRef(splitRatio);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // theaterId 변경마다 새 클라이언트 인스턴스를 생성한다(PluginFilesClient는 stateless).
  const files = useMemo(() => makeFilesClient(theaterId), [theaterId]);

  const handleSelect = useCallback(async (entry: FolderEntry) => {
    if (entry.kind !== "file") return;
    setSelectedPath(entry.relativePath);
    const name = entry.name;
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();

    if (IMAGE_EXTS.has(ext)) {
      const src = theaterId
        ? `/plugins/file-explorer/files/image?theaterId=${encodeURIComponent(theaterId)}&path=${encodeURIComponent(entry.relativePath)}`
        : "";
      setViewState({ kind: "image", relativePath: entry.relativePath, name, src });
      return;
    }

    setViewState({ kind: "loading" });
    try {
      // files/read는 422(binary_file)를 error 바디로 반환하므로 raw fetch로 직접 처리한다.
      const res = await fetch("/plugins/file-explorer/files/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId, relativePath: entry.relativePath }),
      });
      if (!res.ok) {
        const payload = await res.json() as { error?: string };
        throw new Error(payload.error ?? "read_failed");
      }
      const result = await res.json() as FileReadResult;
      if (result.binary) {
        setViewState({ kind: "binary", name });
        return;
      }
      setViewState({ kind: "code", relativePath: result.relativePath, content: result.content, lang: result.lang, truncated: result.truncated });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "파일을 불러올 수 없습니다";
      if (msg === "binary_file") {
        setViewState({ kind: "binary", name });
      } else {
        setViewState({ kind: "error", message: msg });
      }
    }
  }, [theaterId]);

  const handleCloseViewer = useCallback(() => {
    setViewState({ kind: "none" });
    setSelectedPath(null);
  }, []);

  const handleDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = rootRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const startX = e.clientX;
    const startRatio = splitRatioRef.current;
    setIsDragging(true);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const newRatio = Math.max(
        MIN_VIEWER_PX / containerWidth,
        Math.min(1 - MIN_TREE_PX / containerWidth, startRatio + dx / containerWidth),
      );
      splitRatioRef.current = newRatio;
      setSplitRatioState(newRatio);
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setIsDragging(false);
      try { localStorage.setItem(PREFS_SPLIT_RATIO, String(splitRatioRef.current)); } catch { /* ignore */ }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  const hasViewer = viewState.kind !== "none";

  return (
    <div
      ref={rootRef}
      className={`fexp-root${hasViewer ? " has-viewer" : ""}${isDragging ? " is-dragging" : ""}`}
      style={hasViewer ? {
        gridTemplateColumns: `minmax(${MIN_VIEWER_PX}px, ${splitRatio}fr) 4px minmax(${MIN_TREE_PX}px, ${1 - splitRatio}fr)`,
      } : undefined}
    >
      {hasViewer && (
        <div className="fexp-viewer-pane">
          <div className="fexp-viewer-head">
            <span className="fexp-viewer-filename">
              {viewState.kind !== "none" && viewState.kind !== "loading" && viewState.kind !== "error"
                ? "relativePath" in viewState ? viewState.relativePath : viewState.name
                : ""}
            </span>
            <button className="fexp-viewer-close" type="button" onClick={handleCloseViewer} aria-label="뷰어 닫기">
              ✕
            </button>
          </div>
          <div className="fexp-viewer-body">
            {viewState.kind === "loading" && <div className="fexp-viewer-loading">로딩 중…</div>}
            {viewState.kind === "error" && <div className="fexp-viewer-error">{viewState.message}</div>}
            {viewState.kind === "code" && viewState.lang === "markdown" && (
              <MarkdownViewer content={viewState.content} truncated={viewState.truncated} />
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
      )}
      {hasViewer && (
        <div
          className="fexp-divider"
          onPointerDown={handleDividerDown}
          aria-hidden="true"
        />
      )}
      <div className="fexp-tree-pane">
        <FileTree
          files={files}
          theaterId={theaterId}
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

export const fileExplorerPanel: RailPanelDescriptor = {
  id: "file-explorer",
  title: "Files",
  icon: FileExplorerIcon,
  render: (ctx) => <FileExplorerPanel {...ctx} />,
};
