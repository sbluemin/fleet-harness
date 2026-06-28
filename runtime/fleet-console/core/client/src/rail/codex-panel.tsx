import { useEffect, useRef } from "react";

import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { useConsoleState } from "../hooks/use-store.js";
import {
  mountNavigatorInto,
  setNavigatorTheater,
  setOnRequestOpenReader,
  teardownCodex,
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

  const reader = state.codexReader;
  const hasReader = reader !== null;
  const activeTheater = state.theaters.find((t) => t.id === state.activeTheaterId) ?? null;
  const activeTheaterId = activeTheater?.id ?? null;
  const shouldMountCodex = Boolean(activeTheater?.hasWiki);
  const hasTheaters = state.theaters.length > 0;

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
        {/* W1: placeholder stub — W2에서 실 reader 마운트로 교체 */}
        <div className="codex-doc-scroll">
          <p className="codex-reader-loading">문서를 여는 중…</p>
        </div>
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
