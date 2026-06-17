import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { AgentCliMetadata, ConsoleState } from "../types.js";

interface OperationLaunchMenuProps {
  readonly state: ConsoleState;
  readonly onSelect: (cli: AgentCliMetadata) => void | Promise<void>;
  readonly mode?: "button" | "menu";
  readonly anchor?: { readonly x: number; readonly y: number };
  readonly viewportBounds?: { readonly width: number; readonly height: number };
  readonly onClose?: () => void;
}

const DEFAULT_MODE = "button";
const CANVAS_MENU_WIDTH = 184;
const CANVAS_MENU_MAX_HEIGHT = 320;
const CANVAS_MENU_MARGIN = 12;

export function OperationLaunchMenu({ state, onSelect, mode = DEFAULT_MODE, anchor, viewportBounds, onClose }: OperationLaunchMenuProps) {
  const [open, setOpen] = useState(mode === "menu");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const disabled = state.creatingTerminalSession || state.addingTheater || !state.activeTheaterId || state.agentClis.length === 0;
  const menuOpen = mode === "menu" || open;

  useEffect(() => {
    if (mode !== "menu") return;
    setOpen(true);
  }, [mode, anchor?.x, anchor?.y]);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointer = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) closeMenu();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    // 메뉴를 열 때 첫 항목을 강제 포커스하지 않는다 — 마우스로 연 경우 첫 CLI(Claude)가 '이미 선택된 것처럼'
    // 강조되는 UX를 피한다. 대신 메뉴 컨테이너에 포커스를 둬 화살표 키 탐색만 가능하게 한다.
    menuRef.current?.focus();
  }, [menuOpen]);

  const closeMenu = () => {
    setOpen(false);
    onClose?.();
  };

  const handleSelect = async (cli: AgentCliMetadata) => {
    if (disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    await onSelect(cli);
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? []);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    // 아직 아무 항목도 포커스되지 않았으면(메뉴 컨테이너 포커스 상태) ArrowDown=첫 항목, ArrowUp=마지막 항목.
    const next = current === -1
      ? (event.key === "ArrowDown" ? 0 : items.length - 1)
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      className={`operation-launch-control ${mode === "menu" ? "operation-launch-control--canvas" : ""}`}
      ref={containerRef}
      style={anchor ? clampedAnchorStyle(anchor, viewportBounds) : undefined}
      data-canvas-blocker
    >
      {mode === "button" ? (
        <button
          type="button"
          ref={triggerRef}
          className={`workspace-add-button ${open ? "is-open" : ""}`}
          onClick={() => setOpen((value) => !value)}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Launch operation"
        >
          <PlusIcon />
        </button>
      ) : null}
      {menuOpen ? (
        <div className="operation-launch-menu theater-menu" role="menu" aria-label="Launch operation" tabIndex={-1} ref={menuRef} onKeyDown={handleMenuKeyDown}>
          {state.agentClis.length > 0 ? (
            <ul className="theater-menu-list">
              {state.agentClis.map((cli) => (
                <li key={cli.id}>
                  <button type="button" role="menuitem" className="theater-menu-item operation-launch-menu-item" disabled={disabled} onClick={() => { void handleSelect(cli); }}>
                    <span className="theater-menu-check" aria-hidden="true">{agentCliIcon(cli.id)}</span>
                    <span className="theater-menu-label">{cli.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="theater-menu-empty">No Agent CLI available.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function clampedAnchorStyle(anchor: { readonly x: number; readonly y: number }, bounds: { readonly width: number; readonly height: number } | undefined): { readonly left: number; readonly top: number } {
  if (!bounds) return { left: anchor.x, top: anchor.y };
  return {
    left: Math.max(CANVAS_MENU_MARGIN, Math.min(anchor.x, bounds.width - CANVAS_MENU_WIDTH - CANVAS_MENU_MARGIN)),
    top: Math.max(CANVAS_MENU_MARGIN, Math.min(anchor.y, bounds.height - CANVAS_MENU_MAX_HEIGHT - CANVAS_MENU_MARGIN)),
  };
}

function PlusIcon() {
  // Theater 박스 메뉴의 PlusIcon과 같은 가는 stroke·둥근 끝 마크를 공유한다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function agentCliIcon(id: string) {
  // Agent CLI별로 시각 구별 마크를 부여한다: Claude=스파크, Claude Kimi=초승달, Codex=꺾쇠.
  if (id === "claude") return <ClaudeMarkIcon />;
  if (id === "claude-kimi") return <ClaudeKimiMarkIcon />;
  if (id === "codex") return <CodexMarkIcon />;
  return <TerminalIcon />;
}

function ClaudeMarkIcon() {
  // Claude — 4각 스파크. 다른 아이콘과 같은 가는 stroke·둥근 join 언어를 공유한다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.6 9.15 6.85 13.4 8 9.15 9.15 8 13.4 6.85 9.15 2.6 8 6.85 6.85Z" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
    </svg>
  );
}

function ClaudeKimiMarkIcon() {
  // Claude Kimi — Moonshot Kimi 백엔드를 뜻하는 초승달 마크.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.7 3.2A5 5 0 1 0 9.7 12.8 4 4 0 1 1 9.7 3.2Z" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
    </svg>
  );
}

function CodexMarkIcon() {
  // Codex — 코드 꺾쇠(< >) 마크.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.2 4.8 3.2 8 6.2 11.2M9.8 4.8 12.8 8 9.8 11.2" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TerminalIcon() {
  // Operation launch — 선택한 Agent CLI로 새 터미널을 여는 작은 화면 마크(폴백).
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.8" y="3.4" width="10.4" height="8.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.15" />
      <path d="M5 6.2 6.7 8 5 9.8M7.8 9.8h3" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
