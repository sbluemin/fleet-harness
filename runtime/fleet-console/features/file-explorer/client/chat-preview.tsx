import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ConsoleLocale } from "@fleet-console/i18n";
import type { OpenFileRequest, OpenResult } from "../../workspace/shared/navigation.js";
import type { FileReadResult } from "../shared/types.js";
import { FileIcon } from "./components/file-icon.js";
import { nameOfPath } from "./doc-loader.js";
import { fileRequestOwner, parseFileLocation, resolveFilePath, FileNavigationError } from "./file-navigation.js";
import { getT, translateServerError } from "./i18n/index.js";
import { CodeViewer } from "./viewer/code.js";
import { MarkdownViewer } from "./viewer/markdown.js";
import { ImageViewer } from "./viewer/image.js";
import { BinaryViewer } from "./viewer/binary.js";
import "./explorer.css";

interface PreviewFocusOrigin {
  readonly link: HTMLElement | null;
  readonly messageArea: HTMLElement | null;
}

interface PreviewRequest {
  readonly id: string;
  readonly request: OpenFileRequest;
  readonly focusOrigin: PreviewFocusOrigin;
}

// 파일 기능의 요청과 상시 렌더만 잇는다. 도구의 Theater·탭·문서 캐시와는 독립이다.
let preview: PreviewRequest | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => preview;
function closePreview() { preview = null; for (const listener of listeners) listener(); }

export function openChatFilePreview(request: OpenFileRequest): OpenResult {
  if (!parseFileLocation(request.path)) return { ok: false, reason: "unsupported" };
  // autoFocus보다 먼저 잡는다. 미리보기 안의 파일 링크를 따라가도 원래 대화로 돌아간다.
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusOrigin = active?.closest(".fexp-chat-preview") && preview
    ? preview.focusOrigin
    : { link: active, messageArea: active?.closest<HTMLElement>('[role="log"]') ?? null };
  preview = { id: crypto.randomUUID(), request, focusOrigin };
  for (const listener of listeners) listener();
  return { ok: true };
}

export function FileExplorerChatPreview({ language }: { readonly language?: ConsoleLocale }) {
  const current = useSyncExternalStore(subscribe, snapshot, () => null);
  if (!current) return null;
  return createPortal(<ChatPreview key={current.id} request={current.request} focusOrigin={current.focusOrigin} language={language} />, document.body);
}

type PreviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "file"; readonly path: string; readonly result: FileReadResult }
  | { readonly kind: "image"; readonly path: string; readonly src: string }
  | { readonly kind: "binary"; readonly path: string }
  | { readonly kind: "error"; readonly message: string };

function ChatPreview({ request, focusOrigin, language }: { readonly request: OpenFileRequest; readonly focusOrigin: PreviewFocusOrigin; readonly language?: ConsoleLocale }) {
  const t = getT(language);
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const location = parseFileLocation(request.path)!;
  const path = "path" in state ? state.path : location.path;
  const name = nameOfPath(path);

  useLayoutEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    return () => {
      // 바깥 대화가 inert인 동안에는 포커스를 돌릴 수 없다. 먼저 top layer에서 내린다.
      modal?.close();
      if (preview !== null) return;
      const target = focusOrigin.link?.isConnected ? focusOrigin.link : focusOrigin.messageArea;
      if (!target?.isConnected) return;
      if (target === focusOrigin.messageArea && !target.hasAttribute("tabindex")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    };
  }, [focusOrigin]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const resolved = await resolveFilePath(request.theaterId, location.path, request.pathKind, signal, request.objectiveId, request.commodoreId);
        if (signal.aborted) return;
        if (resolved.kind !== "file") throw new Error("not_a_file");
        if (/\.(png|jpe?g|webp|gif)$/i.test(resolved.path)) {
          const query = new URLSearchParams({ ...fileRequestOwner(request.objectiveId, request.commodoreId), ...(request.objectiveId ? {} : { theaterId: request.theaterId }), path: resolved.path });
          setState({ kind: "image", path: resolved.path, src: `/api/v1/file-explorer/files/image?${query}` });
          return;
        }
        const response = await fetch("/api/v1/file-explorer/files/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...fileRequestOwner(request.objectiveId, request.commodoreId), ...(request.objectiveId ? {} : { theaterId: request.theaterId }), relativePath: resolved.path, window: { mode: "head" } }),
          signal,
        });
        const result = await response.json() as FileReadResult & { error?: string };
        if (!response.ok) {
          if (result.error === "binary_file") {
            if (!signal.aborted) setState({ kind: "binary", path: resolved.path });
            return;
          }
          throw new Error(result.error ?? "read_failed");
        }
        if (!signal.aborted) setState({ kind: "file", path: resolved.path, result });
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof FileNavigationError
          ? t(`fileExplorer.navigation.${error.reason}`)
          : translateServerError(error instanceof Error ? error.message : "read_failed", t);
        setState({ kind: "error", message });
      }
    })();
    return () => controller.abort();
  }, [attempt, language, request]);

  const target = state.kind === "file" ? {
    relativePath: state.path,
    requestId: `${request.path}:${attempt}`,
    lineNumber: request.line ?? location.line,
    column: request.column ?? location.column,
    anchor: location.anchor,
    ranges: [],
  } : undefined;
  const line = request.line ?? location.line;
  const result = state.kind === "file" ? state.result : null;

  return (
    <dialog ref={dialog} className="fexp-chat-preview" aria-label={t("fileExplorer.peek.aria", { name })}
      onCancel={(event) => { event.preventDefault(); closePreview(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePreview(); } }}
      onClick={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePreview(); } }}>
      <header className="fexp-chat-preview-head">
        <FileIcon name={name} />
        <div className="fexp-chat-preview-address"><strong>{name}</strong>{path.includes("/") && <span>{path}</span>}</div>
        <button type="button" autoFocus aria-label={t("fileExplorer.peek.close")} onClick={closePreview}>✕</button>
      </header>
      <div className="fexp-chat-preview-body">
        {state.kind === "loading" && <div className="fexp-skeleton" role="status" aria-label={t("fileExplorer.status.loading")}><span className="fexp-skeleton-bar" /></div>}
        {state.kind === "error" && <div className="fexp-state-card is-error" role="alert"><span>{state.message}</span><button type="button" className="fexp-state-action" onClick={() => setAttempt((value) => value + 1)}>{t("fileExplorer.status.loadFailedRetry")}</button></div>}
        {state.kind === "image" && <ImageViewer src={state.src} name={name} t={t} />}
        {state.kind === "binary" && <BinaryViewer name={name} t={t} />}
        {result && state.kind === "file" && (result.binary
            ? <BinaryViewer name={name} t={t} />
            : result.lang === "markdown" && !line
              ? <MarkdownViewer content={result.content} relativePath={state.path} theaterId={request.theaterId} objectiveId={request.objectiveId} commodoreId={request.commodoreId} truncated={result.truncated} language={language} target={target}
                  navigate={{ openFile: async (next) => openChatFilePreview({ ...next, objectiveId: request.objectiveId, commodoreId: request.commodoreId, source: "agent-chat" }) }} />
              : <CodeViewer content={result.content} lang={result.lang} truncated={result.truncated} readWindow={result.window} wrap target={target?.lineNumber ? { ...target, lineNumber: target.lineNumber } : undefined} t={t} />)}
      </div>
    </dialog>
  );
}
