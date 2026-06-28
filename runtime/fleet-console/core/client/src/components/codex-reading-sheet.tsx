import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { mountReaderInto } from "../codex-host.js";
import { useConsoleState } from "../hooks/use-store.js";
import { collapseCodexReader, openCodexReader } from "../store.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ─── Component ────────────────────────────────────────────────────────────────

export function CodexReadingSheet() {
  const {
    codexReader: reader,
    codexReaderExpanded: expanded,
    activeTheaterId: theaterId,
  } = useConsoleState();

  const sheetRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLDivElement>(null);

  const readerKey = reader
    ? `${reader.kind}:${
        reader.kind === "entry"
          ? reader.entryId
          : reader.kind === "drydock"
          ? (reader.patchId ?? "")
          : (reader.id ?? "")
      }`
    : null;

  // W2: expand 전용 — reader != null && expanded의 경우에만 시트 표시
  const isOpen = reader !== null && expanded;

  // 시트 열기/닫기 effect: inert·keydown(Esc·Tab)·focus 복귀
  useEffect(() => {
    if (!isOpen) return;
    const opener = reader;
    document.body.setAttribute("data-codex-reading", "true");

    const canvas = document.querySelector<HTMLElement>(".operations-canvas");
    const sidebar = document.querySelector<HTMLElement>(".operations-side-bar");
    canvas?.setAttribute("inert", "");
    sidebar?.setAttribute("inert", "");

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        collapseCodexReader();
        return;
      }
      if (e.key === "Tab") {
        trapTab(sheetRef.current, e);
      }
    };

    window.addEventListener("keydown", onKey, true);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.removeAttribute("data-codex-reading");
      canvas?.removeAttribute("inert");
      sidebar?.removeAttribute("inert");
      // focus 복귀: Expand 버튼 우선 → is-current entry → 검색 폴백
      const entryId = opener?.kind === "entry" ? opener.entryId : null;
      const restore =
        document.querySelector<HTMLElement>('[data-codex-expand="true"]') ??
        (entryId
          ? document.querySelector<HTMLElement>(
              `.codex-nav-entry.is-current[data-entry-id="${entryId}"]`,
            )
          : null) ??
        document.querySelector<HTMLElement>(".codex-navigator .codex-nav-search-input");
      restore?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opener는 열림 시점 1회 캡처
  }, [isOpen]);

  // 콘텐츠 effect: reader 호스트 노드를 시트 슬롯으로 relocate
  useEffect(() => {
    if (!isOpen || !readRef.current || !tocRef.current || !reader) return;

    const kind = reader.kind;
    const subId =
      kind === "drydock" ? reader.patchId : kind === "conflicts" ? reader.id : undefined;

    mountReaderInto(readRef.current, tocRef.current, {
      initialEntryId: kind === "entry" ? reader.entryId : "",
      kind,
      subId,
      theaterId,
      onRelatedClick: (id) => openCodexReader({ kind: "entry", entryId: id }),
      onClose: () => collapseCodexReader(),
    });

    requestAnimationFrame(() => {
      sheetRef.current
        ?.querySelector<HTMLElement>("[data-sheet-initial-focus]")
        ?.focus();
    });
  }, [isOpen, readerKey]);

  if (!isOpen) return null;

  return createPortal(
    <>
      <div
        className="codex-reading-scrim"
        onClick={collapseCodexReader}
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
          <button
            data-sheet-initial-focus
            className="codex-reading-sheet-close"
            type="button"
            aria-label="Close reading"
            onClick={collapseCodexReader}
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
