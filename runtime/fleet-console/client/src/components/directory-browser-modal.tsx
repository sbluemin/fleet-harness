import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ApiError, listTerminalFolders, type TerminalFolderListResponse } from "../api.js";

interface DirectoryBrowserModalProps {
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (path: string) => void;
}

export function DirectoryBrowserModal({ open, onCancel, onConfirm }: DirectoryBrowserModalProps) {
  const [listing, setListing] = useState<TerminalFolderListResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const controller = new AbortController();
    void loadPath(null, controller.signal);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      controller.abort();
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  if (!open) return null;

  const loadPath = async (path: string | null, signal?: AbortSignal) => {
    setLoadingPath(path);
    setError(null);
    try {
      const next = await listTerminalFolders(path, signal);
      setListing(next);
      setSelectedPath(next.path);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(loadError instanceof ApiError ? loadError.message : String(loadError));
    } finally {
      setLoadingPath(null);
    }
  };

  const confirmPath = selectedPath ?? listing?.path ?? null;

  return createPortal(
    <div className="directory-browser-overlay" role="dialog" aria-modal="true" aria-label="Choose Theater folder">
      <button type="button" className="directory-browser-scrim" aria-label="Close" onClick={onCancel} />
      <section className="directory-browser-card">
        <header className="directory-browser-header">
          <span className="directory-browser-kicker">Theater Folder</span>
          <h2>Choose Folder</h2>
          <button type="button" ref={closeRef} className="directory-browser-close" onClick={onCancel} aria-label="Close">×</button>
        </header>
        <div className="directory-browser-body">
          <div className="directory-browser-path" title={listing?.path ?? ""}>{listing?.path ?? "Loading..."}</div>
          <div className="directory-browser-roots" aria-label="Roots">
            {listing?.roots.map((root) => (
              <button type="button" key={root} className="directory-browser-root" onClick={() => void loadPath(root)}>{root}</button>
            ))}
          </div>
          <div className="directory-browser-toolbar">
            <button type="button" className="directory-browser-button" disabled={!listing?.parentPath || loadingPath !== null} onClick={() => void loadPath(listing?.parentPath ?? null)}>
              Parent
            </button>
            <button type="button" className="directory-browser-button" disabled={!listing || loadingPath !== null} onClick={() => void loadPath(listing?.path ?? null)}>
              Retry
            </button>
          </div>
          {error ? <p className="directory-browser-error">{error}</p> : null}
          <div className="directory-browser-list" aria-busy={loadingPath !== null}>
            {loadingPath !== null ? <p className="directory-browser-empty">Loading...</p> : null}
            {listing && loadingPath === null && listing.entries.length === 0 ? <p className="directory-browser-empty">No child folders.</p> : null}
            {listing?.entries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className={`directory-browser-row ${selectedPath === entry.path ? "is-selected" : ""}`}
                disabled={!entry.accessible}
                title={entry.path}
                onClick={() => setSelectedPath(entry.path)}
                onDoubleClick={() => entry.accessible && void loadPath(entry.path)}
              >
                <span className="directory-browser-row-icon" aria-hidden="true">▸</span>
                <span className="directory-browser-row-name">{entry.name}</span>
                {!entry.accessible ? <span className="directory-browser-row-state">Locked</span> : null}
              </button>
            ))}
          </div>
          {listing?.truncated ? <p className="directory-browser-note">Showing first 500 folders.</p> : null}
        </div>
        <footer className="directory-browser-actions">
          <button type="button" className="directory-browser-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="directory-browser-button is-primary" disabled={!confirmPath || loadingPath !== null} onClick={() => confirmPath && onConfirm(confirmPath)}>
            Choose
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
