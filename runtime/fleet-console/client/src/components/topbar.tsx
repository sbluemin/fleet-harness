import { Link, NavLink } from "react-router-dom";

import { toggleShell } from "../store.js";
import type { ConnectionState } from "../types.js";

interface TopbarProps {
  readonly connection: ConnectionState;
  readonly connectionError: string | null;
}

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly end: boolean;
  readonly icon: "operations" | "codex";
}

const CONNECTION_LABELS: Readonly<Record<ConnectionState, string>> = {
  connecting: "connecting",
  live: "live",
};

// GNB 항목 — Welcome으로의 이동은 브랜드 로고 클릭이 담당하므로 여기서는 제외한다.
const NAV_ITEMS: readonly NavItem[] = [
  { to: "/operations", label: "Operations", end: false, icon: "operations" },
  { to: "/codex", label: "Codex", end: false, icon: "codex" },
];

export function Topbar({ connection, connectionError }: TopbarProps) {
  return (
    <header className="topbar">
      <Link className="topbar-brand" to="/" aria-label="Welcome으로 이동">
        <span className="topbar-sigil" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="16" height="16">
            <path d="M8 1.8 9.5 6.5 14.2 8 9.5 9.5 8 14.2 6.5 9.5 1.8 8 6.5 6.5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M8 4.7 8.7 7.3 11.3 8 8.7 8.7 8 11.3 7.3 8.7 4.7 8 7.3 7.3Z" fill="currentColor" />
          </svg>
        </span>
        <h1 className="topbar-title">
          Fleet<span className="topbar-title-thin">Console</span>
        </h1>
      </Link>
      <nav className="topbar-nav" aria-label="주 내비게이션">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `topbar-nav-link ${isActive ? "is-active" : ""}`}
          >
            <span className="topbar-nav-icon" aria-hidden="true">
              {item.icon === "operations" ? <OperationsIcon /> : <CodexIcon />}
            </span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="topbar-meta">
        <button type="button" className="topbar-shell-button" onMouseDown={(event) => event.preventDefault()} onClick={toggleShell} aria-label="Shell" title="Shell (⌘`)">
          <ShellIcon />
          <span>Shell</span>
        </button>
        <span className={`connection-chip connection-chip--${connection}`} title={connectionError ?? undefined}>
          <span className="connection-dot" aria-hidden="true" />
          {connectionError ? `${CONNECTION_LABELS[connection]} · ${connectionError}` : CONNECTION_LABELS[connection]}
        </span>
      </div>
    </header>
  );
}

function OperationsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 3.7v2.1M8 10.2v2.1M3.7 8h2.1M10.2 8h2.1M8 8l3.1-2.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
    </svg>
  );
}

function CodexIcon() {
  // Codex는 Maritime 항법 지식의 표상 — 문서가 아니라 나침반(컴퍼스 로즈)으로 표현한다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 2.9 9.6 8 8 13.1 6.4 8Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 2.9 9.6 8 6.4 8Z" fill="currentColor" />
      <circle cx="8" cy="8" r="0.85" fill="currentColor" />
    </svg>
  );
}

function ShellIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.8 4.2h10.4v7.6H2.8z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M5 6.7 6.8 8 5 9.3M8.2 9.4h2.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
