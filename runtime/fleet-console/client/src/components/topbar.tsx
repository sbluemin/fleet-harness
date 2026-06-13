import { Link, NavLink } from "react-router-dom";

import type { ConnectionState } from "../types.js";

interface TopbarProps {
  readonly connection: ConnectionState;
  readonly connectionError: string | null;
  readonly tenantCount: number;
}

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly end: boolean;
}

const CONNECTION_LABELS: Readonly<Record<ConnectionState, string>> = {
  connecting: "connecting",
  live: "live",
};

// GNB 항목 — Welcome으로의 이동은 브랜드 로고 클릭이 담당하므로 여기서는 제외한다.
const NAV_ITEMS: readonly NavItem[] = [
  { to: "/operations", label: "Operations", end: false },
];

export function Topbar({ connection, connectionError, tenantCount }: TopbarProps) {
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
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="topbar-meta">
        <span className="topbar-stat">
          {tenantCount} workspace{tenantCount === 1 ? "" : "s"}
        </span>
        <span className={`connection-chip connection-chip--${connection}`} title={connectionError ?? undefined}>
          <span className="connection-dot" aria-hidden="true" />
          {connectionError ? `${CONNECTION_LABELS[connection]} · ${connectionError}` : CONNECTION_LABELS[connection]}
        </span>
      </div>
    </header>
  );
}
