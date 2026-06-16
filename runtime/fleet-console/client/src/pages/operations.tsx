import { useEffect, useRef } from "react";

import { OperationsCanvas } from "../canvas/canvas.js";
import { ensureDefaultGeometry, focusPanel, loadForTheater, prunePanels } from "../canvas/canvas-store.js";
import { FloatingJobOverlay } from "../components/floating-job-overlay.js";
import { FloatingSidebar } from "../components/floating-sidebar.js";
import { useOperationsMode } from "../operations-mode.js";
import { OperationsClassic } from "./operations-classic.js";
import { consumeOperationFocus, theaterSessionOrder } from "../store.js";
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

  // 검색 등에서 들어온 일회성 이동 요청을 처리한다. 위의 loadForTheater/ensureDefaultGeometry
  // effect가 먼저 선언되어 해당 Theater의 패널이 로드·보장된 뒤 실행되므로 focusPanel이 안전하다.
  // Helm(classic)은 사이드바 선택만으로 해당 Operation이 보이므로 확대 없이 신호만 비운다.
  useEffect(() => {
    const sessionId = state.pendingOperationFocus;
    if (sessionId === null) return;
    if (mode !== "classic") {
      const viewportSize = viewportSizeFor(bodyRef.current);
      if (viewportSize) focusPanel(sessionId, viewportSize);
    }
    consumeOperationFocus();
  }, [state.pendingOperationFocus, mode]);

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
