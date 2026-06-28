import { useEffect, useRef } from "react";

import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { useConsoleState } from "../hooks/use-store.js";
import {
  mountNavigatorInto,
  setNavigatorTheater,
  setOnRequestOpenReader,
  teardownCodex,
} from "../codex-host.js";

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
  const bodyRef = useRef<HTMLDivElement>(null);

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

  // shouldMountCodex true이고 activeTheaterId 있을 때 마운트 + no-op onRequest 등록
  useEffect(() => {
    if (!shouldMountCodex || !bodyRef.current || !activeTheaterId) return;
    mountNavigatorInto(bodyRef.current, activeTheaterId);
    // W2에서 store action(openCodexReader)으로 연결 예정
    setOnRequestOpenReader((_r) => { /* W2에서 연결 */ });
    return () => {
      setOnRequestOpenReader(null);
    };
  }, [shouldMountCodex, activeTheaterId]);

  // Theater 전환 시 navigator theater 업데이트
  useEffect(() => {
    if (shouldMountCodex && activeTheaterId) {
      setNavigatorTheater(activeTheaterId);
    }
  }, [activeTheaterId, shouldMountCodex]);

  if (!shouldMountCodex) {
    return <CodexEmpty activeTheater={activeTheater} hasTheaters={hasTheaters} />;
  }

  return <div ref={bodyRef} className="codex-rail-host" />;
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
