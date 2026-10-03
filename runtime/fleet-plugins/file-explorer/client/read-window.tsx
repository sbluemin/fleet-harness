import { useEffect, useState } from "react";
import type { Translate } from "@fleet-console/sdk/i18n";
import { FILE_READ_BYTE_CAP, type FileReadRequest, type FileReadWindow } from "../server/types.js";
import { formatByteSize } from "./format.js";
import type { FileExplorerMessageKey } from "./i18n/index.js";

export function ReadWindowControls({ window, sizeBytes, pending, onRead, t }: {
  readonly window: FileReadWindow;
  readonly sizeBytes: number;
  readonly pending: boolean;
  readonly onRead: (request: FileReadRequest) => void;
  readonly t: Translate<FileExplorerMessageKey>;
}) {
  const [offset, setOffset] = useState(String(window.startByte));
  useEffect(() => { setOffset(String(window.startByte)); }, [window.startByte]);
  const requested = Number(offset);
  const valid = /^\d+$/.test(offset) && Number.isSafeInteger(requested) && requested >= 0 && requested < sizeBytes;
  const key = window.startByte === 0 ? "fileExplorer.viewer.windowHead" : window.mode === "tail" ? "fileExplorer.viewer.windowTail" : "fileExplorer.viewer.windowRange";
  return (
    <div className="fexp-read-window" role="region" aria-label={t("fileExplorer.viewer.windowAria")}>
      <span>{t(key, { shown: formatByteSize(window.endByte - window.startByte), start: window.startByte.toLocaleString(), end: window.endByte.toLocaleString(), total: formatByteSize(sizeBytes) })}</span>
      <div className="fexp-read-window-actions">
        <button type="button" disabled={pending || window.startByte === 0} onClick={() => onRead({ mode: "head" })}>{t("fileExplorer.viewer.windowStart")}</button>
        <button type="button" disabled={pending || window.endByte >= sizeBytes} onClick={() => onRead({ mode: "tail" })}>{t("fileExplorer.viewer.windowEnd")}</button>
        <button type="button" disabled={pending || window.startByte === 0} onClick={() => onRead({ mode: "range", offset: Math.max(0, window.startByte - FILE_READ_BYTE_CAP) })}>{t("fileExplorer.viewer.windowPrevious")}</button>
        <button type="button" disabled={pending || window.endByte >= sizeBytes} onClick={() => onRead({ mode: "range", offset: window.endByte })}>{t("fileExplorer.viewer.windowNext")}</button>
      </div>
      <form className="fexp-read-window-range" onSubmit={(event) => { event.preventDefault(); if (valid && !pending) onRead({ mode: "range", offset: requested }); }}>
        <label>{t("fileExplorer.viewer.windowOffset")}<input type="number" min="0" max={sizeBytes - 1} step="1" value={offset} disabled={pending} onChange={(event) => setOffset(event.target.value)} /></label>
        <button type="submit" disabled={pending || !valid}>{t("fileExplorer.viewer.windowReadRange")}</button>
      </form>
      {window.startByte > 0 && <span className="fexp-read-window-line-note">{t("fileExplorer.viewer.windowLocalLines")}</span>}
    </div>
  );
}
