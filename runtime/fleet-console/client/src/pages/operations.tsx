import { useEffect, useRef } from "react";

import { OperationsCanvas } from "../canvas/canvas.js";
import { ensureDefaultGeometry, loadForTheater, prunePanels } from "../canvas/canvas-store.js";
import { FloatingJobOverlay } from "../components/floating-job-overlay.js";
import { FloatingSidebar } from "../components/floating-sidebar.js";
import { useOperationsMode } from "../operations-mode.js";
import { OperationsClassic } from "./operations-classic.js";
import { theaterSessionOrder } from "../store.js";
import type { ConsoleState } from "../types.js";

interface OperationsProps {
  readonly state: ConsoleState;
}

export function Operations({ state }: OperationsProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const mode = useOperationsMode();
  const sessionOrder = theaterSessionOrder(state);

  useEffect(() => {
    loadForTheater(state.activeTheaterId);
  }, [state.activeTheaterId]);

  useEffect(() => {
    for (const sessionId of sessionOrder) ensureDefaultGeometry(sessionId);
    prunePanels(sessionOrder);
  }, [sessionOrder]);

  if (mode === "classic") return <OperationsClassic state={state} />;

  return (
    <div className="console-body is-canvas" ref={bodyRef}>
      <OperationsCanvas state={state} />
      <FloatingSidebar state={state} getViewportSize={() => viewportSizeFor(bodyRef.current)} />
      <FloatingJobOverlay state={state} />
    </div>
  );
}

function viewportSizeFor(element: HTMLElement | null): { readonly width: number; readonly height: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}
