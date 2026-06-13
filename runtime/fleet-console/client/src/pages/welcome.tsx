import { Link } from "react-router-dom";

import { statusTone } from "../format.js";
import type { ConnectionState, ConsoleState } from "../types.js";

interface WelcomeProps {
  readonly state: ConsoleState;
}

interface SummaryMetric {
  readonly label: string;
  readonly value: string;
  readonly caption: string;
  readonly tone?: "live";
}

const CONNECTION_LABELS: Readonly<Record<ConnectionState, string>> = {
  "auth-needed": "token required",
  connecting: "connecting",
  live: "live",
};

export function Welcome({ state }: WelcomeProps) {
  const workspaceCount = state.tenants.length || state.tenantOrder.length;
  const liveJobCount = countLiveJobs(state);
  const metrics: readonly SummaryMetric[] = [
    {
      label: "Workspaces",
      value: String(workspaceCount),
      caption: "Gateway observer tenants",
    },
    {
      label: "Live jobs",
      value: String(liveJobCount),
      caption: "Carrier jobs in motion",
      tone: "live",
    },
    {
      label: "Connection",
      value: CONNECTION_LABELS[state.connection],
      caption: state.connectionError ?? "Observer channel state",
      tone: state.connection === "live" ? "live" : undefined,
    },
  ];

  return (
    <main className="welcome-page">
      <section className="welcome-hero" aria-labelledby="welcome-title">
        <p className="welcome-kicker">Fleet Console</p>
        <h2 id="welcome-title">Fleet Harness</h2>
        <p className="welcome-tagline">Multi-LLM Orchestration Kit</p>
        <p className="welcome-copy">
          Observe gateway workspaces, carrier streams, and live orchestration signals from a single maritime console.
        </p>
        <Link className="welcome-cta" to="/operations">
          Enter Operations <span aria-hidden="true">&rarr;</span>
        </Link>
      </section>

      <section className="welcome-summary" aria-label="Live console summary">
        {metrics.map((metric) => (
          <article className={`welcome-card ${metric.tone === "live" ? "welcome-card--live" : ""}`} key={metric.label}>
            <p className="welcome-card-label">{metric.label}</p>
            <div className="welcome-card-value-row">
              {metric.label === "Connection" ? <span className={`welcome-live-dot welcome-live-dot--${state.connection}`} aria-hidden="true" /> : null}
              <strong>{metric.value}</strong>
            </div>
            <p>{metric.caption}</p>
          </article>
        ))}
      </section>

      {state.connection === "auth-needed" ? (
        <aside className="welcome-token-note" aria-label="Observer token guidance">
          Open this page through <code>fleet-gateway console</code> so the gateway can hand the observer token to this session.
        </aside>
      ) : null}
    </main>
  );
}

function countLiveJobs(state: ConsoleState): number {
  return Object.values(state.tenantJobs).reduce((total, tenant) => {
    const liveJobs = tenant.jobOrder.filter((jobId) => statusTone(tenant.jobs[jobId]?.status ?? "") === "live");
    return total + liveJobs.length;
  }, 0);
}
