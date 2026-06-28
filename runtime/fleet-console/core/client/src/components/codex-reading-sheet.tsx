import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { mountReaderInto, teardownReader } from "../codex-host.js";
import { useConsoleState } from "../hooks/use-store.js";
import { closeCodexReader, openCodexReader } from "../store.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ─── Component ────────────────────────────────────────────────────────────────

export function CodexReadingSheet() {
  const { codexReader: reader, activeTheaterId: theaterId } = useConsoleState();

  const sheetRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLDivElement>(null);

  // 안정적인 effect key: kind + 진입 식별자
  const readerKey = reader
    ? `${reader.kind}:${
        reader.kind === "entry"
          ? reader.entryId
          : reader.kind === "drydock"
          ? (reader.patchId ?? "")
          : (reader.id ?? "")
      }`
    : null;

  useEffect(() => {
    if (!reader || !readRef.current || !tocRef.current) return;

    const trigger = document.activeElement as HTMLElement | null;
    document.body.setAttribute("data-codex-reading", "true");

    const kind = reader.kind;
    const subId =
      kind === "drydock" ? reader.patchId : kind === "conflicts" ? reader.id : undefined;

    mountReaderInto(readRef.current, {
      initialEntryId: kind === "entry" ? reader.entryId : "",
      kind,
      subId,
      theaterId,
      onRelatedClick: (id) => openCodexReader({ kind: "entry", entryId: id }),
      onClose: () => closeCodexReader(),
      tocContainer: tocRef.current!,
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeCodexReader();
        return;
      }
      if (e.key === "Tab") {
        trapTab(sheetRef.current, e);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        sheetRef.current?.classList.toggle("is-wide");
      }
    };

    window.addEventListener("keydown", onKey, true);

    requestAnimationFrame(() => {
      sheetRef.current
        ?.querySelector<HTMLElement>("[data-sheet-initial-focus]")
        ?.focus();
    });

    return () => {
      teardownReader();
      window.removeEventListener("keydown", onKey, true);
      document.body.removeAttribute("data-codex-reading");
      trigger?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerKey]);

  if (!reader) return null;

  return createPortal(
    <>
      <div
        className="codex-reading-scrim"
        onClick={closeCodexReader}
        aria-hidden="true"
      />
      <div
        ref={sheetRef}
        className="codex-reading-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Codex reading"
      >
        <div className="codex-reading-sheet-head">
          <span className="codex-reading-sheet-eyebrow">Codex · Reading</span>
          <span className="codex-reading-sheet-hint">Esc · ⌘\</span>
          <button
            data-sheet-initial-focus
            className="codex-reading-sheet-close"
            type="button"
            aria-label="Close reading"
            onClick={closeCodexReader}
          >
            ✕
          </button>
        </div>
        <div className="codex-reading-sheet-body">
          <div ref={readRef} className="codex-reading-sheet-read" />
          <aside
            ref={tocRef}
            className="codex-reading-sheet-toc"
            aria-label="On this page"
          />
        </div>
      </div>
    </>,
    document.body,
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function trapTab(sheet: HTMLDivElement | null, event: KeyboardEvent): void {
  if (!sheet) return;
  const focusable = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest("[inert]"),
  );
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey) {
    if (document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
