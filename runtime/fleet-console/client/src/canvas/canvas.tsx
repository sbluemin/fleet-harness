import { useRef, useState } from "react";

import { createTheaterTerminalSession } from "../api.js";
import { OperationLaunchMenu } from "../components/operation-launch-menu.js";
import { beginCreateTerminalSession, completeCreateTerminalSession, failCreateTerminalSession, selectTerminalSession, theaterSessions } from "../store.js";
import type { AgentCliMetadata, ConsoleState } from "../types.js";
import { setPanelGeometry, setViewport, toggleBackgroundAnimation, useBackgroundAnimation, useCanvasState, type PanelGeometry } from "./canvas-store.js";
import { CanvasPanel } from "./canvas-panel.js";
import { CanvasGrid } from "./canvas-grid.js";
import { RubberBand } from "./rubber-band.js";
import { useCanvasInteraction } from "./use-canvas-interaction.js";
import type { CanvasPoint, CanvasRect } from "./coordinates.js";

interface OperationsCanvasProps {
  readonly state: ConsoleState;
}

interface LaunchRequest {
  readonly rect: CanvasRect;
  readonly anchor: CanvasPoint;
}

const EMPTY_GUIDE = "Shift-drag to create an Operation. Drag to pan; scroll to zoom.";

export function OperationsCanvas({ state }: OperationsCanvasProps) {
  const canvasRef = useRef<HTMLElement | null>(null);
  const canvas = useCanvasState();
  const backgroundAnimationEnabled = useBackgroundAnimation();
  const sessions = theaterSessions(state);
  const [launchRequest, setLaunchRequest] = useState<LaunchRequest | null>(null);
  const disabled = !state.activeTheaterId || state.agentClis.length === 0 || state.creatingTerminalSession || state.addingTheater;
  const interaction = useCanvasInteraction({
    viewport: canvas.viewport,
    disabled,
    onViewportChange: setViewport,
    onCreate: (rect, anchor) => setLaunchRequest({ rect, anchor }),
    consumePointerDown: launchRequest !== null,
    onConsumePointerDown: () => setLaunchRequest(null),
    onClick: clearTerminalFocus,
  });

  const handleLaunch = async (cli: AgentCliMetadata) => {
    if (!state.activeTheaterId || !launchRequest) return;
    beginCreateTerminalSession();
    try {
      const session = await createTheaterTerminalSession(state.activeTheaterId, cli.id);
      setPanelGeometry(session.sessionId, rectToGeometry(launchRequest.rect));
      completeCreateTerminalSession(session);
      selectTerminalSession(session.sessionId);
      setLaunchRequest(null);
    } catch (error) {
      failCreateTerminalSession(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main
      className={`operations-canvas ${interaction.spaceActive ? "is-panning" : ""} ${interaction.shiftActive ? "is-creating" : ""}`}
      onPointerDown={interaction.onPointerDown}
      onPointerMove={interaction.onPointerMove}
      onPointerUp={interaction.onPointerUp}
      onPointerCancel={interaction.onPointerCancel}
      onWheel={interaction.onWheel}
      ref={canvasRef}
    >
      <CanvasGrid viewport={canvas.viewport} backgroundAnimationEnabled={backgroundAnimationEnabled} />
      <button
        type="button"
        className={`canvas-background-toggle ${backgroundAnimationEnabled ? "is-active" : ""}`}
        onClick={toggleBackgroundAnimation}
        data-canvas-blocker
        aria-label={backgroundAnimationEnabled ? "배경 애니메이션 끄기" : "배경 애니메이션 켜기"}
        title={backgroundAnimationEnabled ? "Background animation: on" : "Background animation: off"}
      >
        <RadarToggleIcon />
      </button>
      <div
        className="operations-canvas-world"
        style={{
          transform: `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.zoom})`,
        }}
      >
        {sessions.map((session) => {
          const geometry = canvas.panels[session.sessionId];
          if (!geometry) return null;
          return (
            <CanvasPanel
              key={session.sessionId}
              state={state}
              session={session}
              geometry={geometry}
              viewport={canvas.viewport}
              active={state.activeTerminalSessionId === session.sessionId}
              getCanvasRect={() => canvasRef.current?.getBoundingClientRect() ?? null}
            />
          );
        })}
      </div>
      {sessions.length === 0 ? (
        <div className="operations-canvas-empty" data-canvas-blocker>
          <span className="operations-canvas-empty-mark" aria-hidden="true" />
          <p>{state.activeTheaterId ? EMPTY_GUIDE : "Add a Theater from the top bar to start operations."}</p>
          {state.terminalSessionError ? <p className="operations-canvas-error">{state.terminalSessionError}</p> : null}
        </div>
      ) : null}
      {interaction.rubberBand ? <RubberBand rect={interaction.rubberBand} viewport={canvas.viewport} /> : null}
      {launchRequest ? (
        <OperationLaunchMenu
          key={`${launchRequest.anchor.x}:${launchRequest.anchor.y}`}
          state={state}
          mode="menu"
          anchor={launchRequest.anchor}
          viewportBounds={viewportBoundsFor(canvasRef.current)}
          onSelect={handleLaunch}
          onClose={() => setLaunchRequest(null)}
        />
      ) : null}
    </main>
  );
}

function RadarToggleIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.1" strokeDasharray="2 2" />
      <circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.72" />
      <path d="M8 8 12.2 5.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" />
    </svg>
  );
}

function viewportBoundsFor(element: HTMLElement | null): { readonly width: number; readonly height: number } | undefined {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

// 빈 캔버스 단일 클릭(캔버스 제어 의도): 포커스된 터미널을 blur하고 활성 선택을 해제한다.
function clearTerminalFocus(): void {
  if (typeof document !== "undefined") {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }
  selectTerminalSession(null);
}

function rectToGeometry(rect: CanvasRect): PanelGeometry {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    zIndex: Date.now(),
  };
}
