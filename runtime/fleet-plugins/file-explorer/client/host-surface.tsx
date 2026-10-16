import { useCallback, useEffect, useMemo, useState } from "react";
import type { HostSurfaceContext, HostSurfaceDescriptor } from "@fleet-console/sdk/host-context";
import { hostStorageKey } from "@fleet-console/sdk/host-context/browser";
import type { FileReadResult } from "../server/types.js";
import { FileTree } from "./tree.js";
import { makeFilesClient } from "./files-client.js";
import { nameOfPath, readDocumentFile } from "./doc-loader.js";
import { getT, translateServerError } from "./i18n/index.js";
import { CodeViewer } from "./viewer/code.js";
import { ImageViewer } from "./viewer/image.js";
import { BinaryViewer } from "./viewer/binary.js";
import { MarkdownViewer, resolveFileExplorerWikiLink } from "./viewer/markdown.js";
import { parseFileLocation, resolveFilePath } from "./file-navigation.js";
import type { ClientNavigateCapability } from "@fleet-console/sdk/navigation";
import { parentDirOf } from "./viewer/stale.js";
import "./explorer.css";
import "./host-surface.css";

/** 기존 트리/코드/이미지 renderer를 재사용하며 선택·본문 상태만 host가 주입한 수명에 둔다. */
function HostFiles({ context }: { readonly context: HostSurfaceContext }) {
  const { transport } = context;
  const theaterId = context.selection.theaterId;
  const t = getT(context.language);
  const stateKey = `file:${theaterId ?? ""}`;
  const [path, setPath] = useState<string | null>(() => context.state.read(stateKey, null));
  const [file, setFile] = useState<FileReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const files = useMemo(() => makeFilesClient(theaterId, transport), [theaterId, transport]);
  const image = path !== null && /\.(png|jpe?g|gif|webp)$/i.test(path);
  const pick = useCallback((next: string | null) => {
    if (transport.scope.signal.aborted) return;
    context.state.write(stateKey, next);
    setPath(next);
  }, [context, stateKey, transport]);
  const navigate = useMemo<ClientNavigateCapability>(() => ({
    openFile: async (request) => {
      if (!theaterId || request.theaterId !== theaterId || transport.scope.signal.aborted) return { ok: false, reason: "outside_theater" };
      const location = parseFileLocation(request.path);
      if (!location) return { ok: false, reason: "unsupported" };
      const resolved = await resolveFilePath(theaterId, location.path, request.pathKind, transport.scope.signal, transport);
      if (resolved.kind !== "file") return { ok: false, reason: "unsupported" };
      pick(resolved.path);
      return { ok: true };
    },
    openWikiEntry: async () => ({ ok: false, reason: "no_handler" }),
  }), [theaterId, transport, pick]);
  useEffect(() => {
    setFile(null); setError(null);
    if (!theaterId || !path || image) return;
    const abort = new AbortController();
    void readDocumentFile(theaterId, path, { mode: "head" }, abort.signal, transport).then((result) => {
      if (!abort.signal.aborted && !transport.scope.signal.aborted) setFile(result);
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted && !transport.scope.signal.aborted) setError(translateServerError(cause instanceof Error ? cause.message : "read_failed", t));
    });
    return () => abort.abort();
  }, [theaterId, path, image, revision, transport, t]);
  useEffect(() => {
    if (!theaterId || !path) return;
    const source = transport.events(`/plugins/file-explorer/files/watch?theaterId=${encodeURIComponent(theaterId)}&directory=${encodeURIComponent(parentDirOf(path))}`);
    let active = true;
    const refresh = () => { if (active && !transport.scope.signal.aborted) setRevision((value) => value + 1); };
    source.addEventListener("change", refresh);
    source.onopen = refresh;
    return () => { active = false; source.close(); };
  }, [theaterId, path, transport]);
  if (!theaterId) return null;
  const imagePath = path && image ? transport.resourceUrl(`/plugins/file-explorer/files/image?theaterId=${encodeURIComponent(theaterId)}&path=${encodeURIComponent(path)}&v=${revision}`) : null;
  return <div className="fexp-host-surface" data-host-key={context.selection.hostKey}>
    {path === null ? <FileTree contextKey={hostStorageKey(context.selection.hostKey, theaterId)} files={files} transport={transport}
      theaterId={theaterId} selectedPath={null} onSelect={(entry) => pick(entry.relativePath)}
      onSearchSelect={(entry) => pick(entry.relativePath)} onContextMenu={() => undefined} language={context.language} t={t} /> : <>
      <div className="fexp-host-caption"><button type="button" onClick={() => pick(null)}>{t("fileExplorer.viewer.back")}</button><span>{nameOfPath(path)}</span></div>
      {error ? <p role="alert">{error}</p> : imagePath ? <ImageViewer src={imagePath} name={nameOfPath(path)} t={t} /> : file
        ? file.binary ? <BinaryViewer name={nameOfPath(path)} t={t} /> : /\.(md|markdown)$/i.test(path)
          ? <MarkdownViewer content={file.content} navigate={navigate} resolveWikiLink={resolveFileExplorerWikiLink} resourceUrl={transport.resourceUrl} relativePath={path} theaterId={theaterId} language={context.language} truncated={file.truncated} onNavigationError={(reason) => { if (!transport.scope.signal.aborted) setError(translateServerError(reason, t)); }} />
          : <CodeViewer content={file.content} lang={file.lang} truncated={file.truncated} readWindow={file.window} t={t} />
        : <p role="status">{t("fileExplorer.status.loading")}</p>}
    </>}
  </div>;
}

export const hostFileSurface: HostSurfaceDescriptor = { id: "files", slot: "files", render: (context) => <HostFiles context={context} /> };
