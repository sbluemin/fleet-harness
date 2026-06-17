import { useEffect, useRef } from "react";

import { agentCliIcon } from "../components/operation-launch-menu.js";
import type { AgentCliMetadata, ConsoleState } from "../types.js";

interface CanvasContextMenuProps {
  readonly state: ConsoleState;
  // 캔버스(<main>) 기준 화면 좌표. 메뉴를 이 지점에 띄운다.
  readonly anchor: { readonly x: number; readonly y: number };
  readonly viewportBounds?: { readonly width: number; readonly height: number };
  readonly onLaunchCli: (cli: AgentCliMetadata) => void;
  readonly onOpenShell: () => void;
  readonly onResetView: () => void;
  readonly onClose: () => void;
}

const MENU_WIDTH = 208;
const MENU_MAX_HEIGHT = 360;
const MENU_MARGIN = 12;

export function CanvasContextMenu({ state, anchor, viewportBounds, onLaunchCli, onOpenShell, onResetView, onClose }: CanvasContextMenuProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const launchDisabled = state.creatingTerminalSession || state.addingTheater || !state.activeTheaterId || state.agentClis.length === 0;
  const shellDisabled = !state.activeTheaterId;

  useEffect(() => {
    const handlePointer = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  useEffect(() => {
    // 첫 항목을 강제 포커스하지 않고 컨테이너만 포커스해 '이미 선택된 듯한' UX를 피한다.
    menuRef.current?.focus();
  }, []);

  return (
    <div
      className="operation-launch-control operation-launch-control--canvas"
      ref={containerRef}
      style={clampedAnchorStyle(anchor, viewportBounds)}
      data-canvas-blocker
    >
      <div className="operation-launch-menu theater-menu canvas-context-menu" role="menu" aria-label="Canvas actions" tabIndex={-1} ref={menuRef}>
        <p className="canvas-context-menu-group">New Operation</p>
        {state.agentClis.length > 0 ? (
          <ul className="theater-menu-list">
            {state.agentClis.map((cli) => (
              <li key={cli.id}>
                <button
                  type="button"
                  role="menuitem"
                  className="theater-menu-item operation-launch-menu-item"
                  disabled={launchDisabled}
                  onClick={() => onLaunchCli(cli)}
                >
                  <span className="theater-menu-check" aria-hidden="true">{agentCliIcon(cli.id)}</span>
                  <span className="theater-menu-label">{cli.label}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="theater-menu-empty">No Agent CLI available.</p>
        )}
        <div className="theater-menu-divider" role="separator" />
        <button type="button" role="menuitem" className="theater-menu-item canvas-context-menu-item" disabled={shellDisabled} onClick={onOpenShell}>
          <span className="theater-menu-check" aria-hidden="true"><ShellGlyph /></span>
          <span className="theater-menu-label">Open Shell</span>
        </button>
        <div className="theater-menu-divider" role="separator" />
        <button type="button" role="menuitem" className="theater-menu-item canvas-context-menu-item" onClick={onResetView}>
          <span className="theater-menu-check" aria-hidden="true"><ResetGlyph /></span>
          <span className="theater-menu-label">Reset view</span>
        </button>
      </div>
    </div>
  );
}

function clampedAnchorStyle(
  anchor: { readonly x: number; readonly y: number },
  bounds: { readonly width: number; readonly height: number } | undefined,
): { readonly left: number; readonly top: number } {
  if (!bounds) return { left: anchor.x, top: anchor.y };
  return {
    left: Math.max(MENU_MARGIN, Math.min(anchor.x, bounds.width - MENU_WIDTH - MENU_MARGIN)),
    top: Math.max(MENU_MARGIN, Math.min(anchor.y, bounds.height - MENU_MAX_HEIGHT - MENU_MARGIN)),
  };
}

function ShellGlyph() {
  // 순정 셸 — topbar Shell 버튼과 같은 화면+프롬프트 stroke 언어를 공유한다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.8" y="3.4" width="10.4" height="9.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.15" />
      <path d="M5 6.6 6.8 8.4 5 10.2M8.4 10.2h2.8" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ResetGlyph() {
  // 뷰 리셋 — 원점 복귀를 뜻하는 되돌림 화살표 마크.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.4 7.2A4 4 0 1 1 4 9.2" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.4 4.6v2.8h2.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
