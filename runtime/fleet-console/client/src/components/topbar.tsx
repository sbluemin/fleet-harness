import type { ConnectionState } from "../types.js";

interface TopbarProps {
  readonly connection: ConnectionState;
  readonly connectionError: string | null;
  readonly tenantCount: number;
}

const CONNECTION_LABELS: Readonly<Record<ConnectionState, string>> = {
  "auth-needed": "token required",
  connecting: "connecting",
  live: "live",
};

export function Topbar({ connection, connectionError, tenantCount }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-sigil" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="16" height="16">
            <path d="M2 12 8 2l6 10H10.8L8 7.2 5.2 12Z" fill="currentColor" />
          </svg>
        </span>
        <h1 className="topbar-title">
          Fleet<span className="topbar-title-thin">Console</span>
        </h1>
      </div>
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
