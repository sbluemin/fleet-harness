import { useEffect, useRef } from "react";

import { mountCodexApp } from "../codex/main.js";
import type { CodexAppController } from "../codex/main.js";
import type { ConsoleState } from "../types.js";

interface CodexProps {
  readonly state: ConsoleState;
}

export function Codex({ state }: CodexProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<CodexAppController | null>(null);
  const activeTheater = state.theaters.find((theater) => theater.id === state.activeTheaterId) ?? null;
  const activeTheaterId = activeTheater?.id ?? null;
  const shouldMountCodex = Boolean(activeTheater?.hasWiki);

  useEffect(() => {
    if (!shouldMountCodex) {
      controllerRef.current?.destroy();
      controllerRef.current = null;
      return;
    }
    const root = rootRef.current;
    if (!root || !activeTheaterId || controllerRef.current) return;
    const controller: CodexAppController = mountCodexApp(root, { initialWorkspaceId: activeTheaterId });
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [shouldMountCodex]);

  useEffect(() => {
    if (!shouldMountCodex || !activeTheaterId) return;
    controllerRef.current?.navigateToWorkspace(activeTheaterId);
  }, [activeTheaterId, shouldMountCodex]);

  if (!state.activeTheaterId || state.theaters.length === 0) {
    return (
      <section className="codex-empty-state">
        <p className="codex-empty-eyebrow">Codex</p>
        <h1>Add a Theater</h1>
        <p>Use the top bar Theater control to choose a project root before opening Codex.</p>
      </section>
    );
  }

  if (!activeTheater?.hasWiki) {
    return (
      <section className="codex-empty-state">
        <p className="codex-empty-eyebrow">Codex unavailable</p>
        <h1>{activeTheater?.label ?? "This Theater"}</h1>
        <p>This Theater does not have Fleet Wiki data mounted.</p>
      </section>
    );
  }

  return <div className="codex-host" ref={rootRef} />;
}
