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
            <path d="M8 1.8 9.5 6.5 14.2 8 9.5 9.5 8 14.2 6.5 9.5 1.8 8 6.5 6.5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M8 4.7 8.7 7.3 11.3 8 8.7 8.7 8 11.3 7.3 8.7 4.7 8 7.3 7.3Z" fill="currentColor" />
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
