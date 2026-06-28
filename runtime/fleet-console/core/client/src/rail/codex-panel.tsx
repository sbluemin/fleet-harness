import { useEffect, useRef } from "react";

import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { useConsoleState } from "../hooks/use-store.js";
import {
  mountNavigatorInto,
  mountReaderInto,
  setNavigatorTheater,
  setOnRequestOpenReader,
  teardownCodex,
  teardownReaderNodes,
} from "../codex-host.js";
import { closeCodexReader, expandCodexReader, openCodexReader } from "../store.js";

// ─── Rail panel descriptor ────────────────────────────────────────────────────

export const codexPanel: RailPanelDescriptor = {
  id: "codex",
  title: "Codex",
  icon: () => <CodexIcon />,
  render: () => <CodexRailPanel />,
};

// ─── Components ───────────────────────────────────────────────────────────────

function CodexRailPanel() {
  const state = useConsoleState();
  const navRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLDivElement>(null);

  const reader = state.codexReader;
  const hasReader = reader !== null;
  const expanded = state.codexReaderExpanded;
  const activeTheater = state.theaters.find((t) => t.id === state.activeTheaterId) ?? null;
  const activeTheaterId = activeTheater?.id ?? null;
  const shouldMountCodex = Boolean(activeTheater?.hasWiki);
  const hasTheaters = state.theaters.length > 0;

  const readerKey = reader
    ? `${reader.kind}:${
        reader.kind === "entry"
          ? reader.entryId
          : reader.kind === "drydock"
          ? (reader.patchId ?? "")
          : (reader.id ?? "")
      }`
    : null;

  // shouldMountCodex false 전환 시 teardown; unmount 시에도 teardown
  useEffect(() => {
    if (!shouldMountCodex) {
      teardownCodex();
      return;
    }
    return () => {
      teardownCodex();
    };
  }, [shouldMountCodex]);

  // navigator 마운트 + onRequest 등록 — hasReader 전환 시 navRef 컨테이너가 바뀌므로 재배치
  useEffect(() => {
    if (!shouldMountCodex || !activeTheaterId) return;
    const node = navRef.current;
    if (!node) return;
    mountNavigatorInto(node, activeTheaterId);
    setOnRequestOpenReader((r) => {
      if (r.kind === "entry") openCodexReader({ kind: "entry", entryId: r.id });
      else if (r.kind === "drydock") openCodexReader({ kind: "drydock", patchId: r.patchId });
      else if (r.kind === "conflicts") openCodexReader({ kind: "conflicts", id: r.id });
    });
    return () => {
      setOnRequestOpenReader(null);
    };
  }, [shouldMountCodex, activeTheaterId, hasReader]);

  // Theater 전환 시 navigator theater 업데이트
  useEffect(() => {
    if (shouldMountCodex && activeTheaterId) {
      setNavigatorTheater(activeTheaterId);
    }
  }, [activeTheaterId, shouldMountCodex]);

  // split reader mount — expanded=true면 오버레이가 처리 중이므로 건너뜀
  useEffect(() => {
    if (!shouldMountCodex || !activeTheaterId || !hasReader || expanded) return;
    if (!readRef.current || !tocRef.current || !reader) return;
    const kind = reader.kind;
    const subId = kind === "drydock" ? reader.patchId : kind === "conflicts" ? reader.id : undefined;
    mountReaderInto(readRef.current, tocRef.current, {
      initialEntryId: kind === "entry" ? reader.entryId : "",
      kind,
      subId,
      theaterId: activeTheaterId,
      onRelatedClick: (id) => openCodexReader({ kind: "entry", entryId: id }),
      onClose: () => closeCodexReader(),
    });
  }, [shouldMountCodex, activeTheaterId, hasReader, expanded, readerKey]);

  // hasReader=false 시 reader 호스트 노드 정리
  useEffect(() => {
    if (!hasReader) teardownReaderNodes();
  }, [hasReader]);

  if (!shouldMountCodex) {
    return <CodexEmpty activeTheater={activeTheater} hasTheaters={hasTheaters} />;
  }

  if (!hasReader) {
    return <div ref={navRef} className="codex-rail-host" />;
  }

  return (
    <div className="codex-rail-host is-split">
      <div className="codex-doc-pane">
        <div className="codex-doc-pane-head">
          <button
            className="codex-doc-expand"
            type="button"
            aria-label="Expand reading sheet"
            data-codex-expand="true"
            onClick={expandCodexReader}
          >
            ⤢ Expand
          </button>
          <button
            className="codex-reading-sheet-close"
            type="button"
            aria-label="Close document pane"
            onClick={closeCodexReader}
          >
            ✕
          </button>
        </div>
        <div ref={readRef} className="codex-doc-scroll" />
        <div ref={tocRef} className="codex-doc-toc-inline" />
      </div>
      <div ref={navRef} className="codex-nav-pane" />
    </div>
  );
}

function CodexEmpty({
  activeTheater,
  hasTheaters,
}: {
  readonly activeTheater: { readonly label: string } | null;
  readonly hasTheaters: boolean;
}) {
  if (!hasTheaters) {
    return (
      <section className="codex-empty-state">
        <p className="codex-empty-eyebrow">Codex</p>
        <h1>Add a Theater</h1>
        <p>Use the top bar Theater control to choose a project root before opening Codex.</p>
      </section>
    );
  }
  return (
    <section className="codex-empty-state">
      <p className="codex-empty-eyebrow">Codex unavailable</p>
      <h1>{activeTheater?.label ?? "This Theater"}</h1>
      <p>This Theater does not have Fleet Wiki data mounted.</p>
    </section>
  );
}

function CodexIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" opacity="0.16" />
      <path d="M12 3v3.6M12 17.4V21M3 12h3.6M17.4 12H21" />
      <path d="M12 8.6 14.2 12 12 15.4 9.8 12Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
