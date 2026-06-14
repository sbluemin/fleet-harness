import { useEffect, useState } from "react";

import { fetchCarriers, fetchObserverStatus } from "../api.js";
import { buildBridgeView, type BridgeView, type TheaterReadiness } from "../dashboard.js";
import { fetchKnowledgeReadiness, type KnowledgeReadinessSummary } from "../dashboard-knowledge.js";
import type { CarrierReadinessEntry, ConsoleState, ObserverStatus } from "../types.js";

interface WelcomeProps {
  readonly state: ConsoleState;
}

interface Metric {
  readonly label: string;
  readonly value: string;
  readonly caption: string;
  readonly tone?: "live" | "good" | "bad" | "warn";
}

interface AsyncPanelState<T> {
  readonly loading: boolean;
  readonly value: T | null;
  readonly error: string | null;
}

const EMPTY_ASYNC_STATE = {
  loading: false,
  value: null,
  error: null,
} satisfies AsyncPanelState<never>;

const CARRIER_READINESS_REFRESH_MS = 15_000;

export function Welcome({ state }: WelcomeProps) {
  const view = buildBridgeView(state);
  const active = view.activeTheater;
  const [knowledge, setKnowledge] = useState<AsyncPanelState<KnowledgeReadinessSummary>>(EMPTY_ASYNC_STATE);
  const [health, setHealth] = useState<AsyncPanelState<ObserverStatus>>(EMPTY_ASYNC_STATE);
  const [carriers, setCarriers] = useState<AsyncPanelState<readonly CarrierReadinessEntry[]>>(EMPTY_ASYNC_STATE);

  useEffect(() => {
    if (!active?.hasWiki) {
      setKnowledge(EMPTY_ASYNC_STATE);
      return;
    }
    const controller = new AbortController();
    setKnowledge({ loading: true, value: null, error: null });
    fetchKnowledgeReadiness(active.id, controller.signal)
      .then((value) => setKnowledge({ loading: false, value, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setKnowledge({ loading: false, value: null, error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [active?.hasWiki, active?.id]);

  useEffect(() => {
    const controller = new AbortController();
    setHealth((current) => ({ loading: true, value: current.value, error: null }));
    fetchObserverStatus(active?.id ?? null, controller.signal)
      .then((value) => setHealth({ loading: false, value, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setHealth({ loading: false, value: null, error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [active?.id]);

  useEffect(() => {
    const controller = new AbortController();
    const loadCarriers = () => {
      setCarriers((current) => ({ loading: true, value: current.value, error: null }));
      fetchCarriers(controller.signal)
        .then((value) => setCarriers({ loading: false, value, error: null }))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setCarriers((current) => ({
            loading: false,
            value: current.value,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    };
    loadCarriers();
    const intervalId = window.setInterval(loadCarriers, CARRIER_READINESS_REFRESH_MS);
    return () => {
      window.clearInterval(intervalId);
      controller.abort();
    };
  }, []);

  return (
    <main className="welcome-page">
      <section className="bridge-matrix" aria-labelledby="bridge-matrix-title">
        <div className="bridge-section-heading">
          <p className="bridge-kicker">Theater Capability Matrix</p>
          <h3 id="bridge-matrix-title">Registered Theaters</h3>
        </div>
        <div className="bridge-matrix-table" role="table" aria-label="Theater capability matrix">
          <div className="bridge-matrix-row bridge-matrix-head" role="row">
            <span role="columnheader">Theater</span>
            <span role="columnheader">Codex</span>
            <span role="columnheader">Active</span>
            <span role="columnheader">Terminals</span>
            <span role="columnheader">Updated</span>
          </div>
          {view.theaters.length > 0 ? view.theaters.map((theater) => <TheaterRow key={theater.id} theater={theater} />) : (
            <p className="bridge-matrix-empty">No Theaters registered.</p>
          )}
        </div>
      </section>

      <section className="bridge-carriers" aria-labelledby="bridge-carriers-title">
        <div className="bridge-section-heading">
          <p className="bridge-kicker">Carrier Readiness Matrix</p>
          <h3 id="bridge-carriers-title">Carrier roster</h3>
        </div>
        <CarrierMatrix carriers={carriers} />
      </section>

      <section className="bridge-knowledge" aria-labelledby="bridge-knowledge-title">
        <div className="bridge-section-heading">
          <p className="bridge-kicker">Knowledge Readiness Panel</p>
          <h3 id="bridge-knowledge-title">Codex readiness</h3>
        </div>
        <KnowledgePanel activeTheater={active} knowledge={knowledge} />
      </section>

      <section className="bridge-health" aria-labelledby="bridge-health-title">
        <div className="bridge-section-heading">
          <p className="bridge-kicker">System Information</p>
          <h3 id="bridge-health-title">Runtime status</h3>
        </div>
        <HealthStrip health={health} />
      </section>
    </main>
  );
}

function KnowledgePanel({
  activeTheater,
  knowledge,
}: {
  readonly activeTheater: BridgeView["activeTheater"];
  readonly knowledge: AsyncPanelState<KnowledgeReadinessSummary>;
}) {
  if (!activeTheater) {
    return (
      <div className="bridge-empty">
        <p>Add a Theater to inspect Codex readiness.</p>
      </div>
    );
  }
  if (!activeTheater.hasWiki) {
    return (
      <div className="bridge-empty">
        <p>Codex unavailable for this Theater.</p>
      </div>
    );
  }
  if (knowledge.error) {
    return (
      <div className="bridge-empty bridge-empty--warn">
        <p>Codex summary degraded.</p>
      </div>
    );
  }
  const summary = knowledge.value;
  const metrics: readonly Metric[] = [
    { label: "Entries", value: summary ? String(summary.entryCount) : "…", caption: "Indexed knowledge entries" },
    { label: "Pending", value: summary ? String(summary.pendingQueueCount) : "…", caption: "Drydock queue" },
    { label: "Archived", value: summary ? String(summary.archivedQueueCount) : "…", caption: "Archived decisions" },
    { label: "Conflicts", value: summary ? String(summary.openConflictCount) : "…", caption: "Open conflict files", tone: summary && summary.openConflictCount > 0 ? "warn" : undefined },
    { label: "Log", value: summary ? summary.latestLogStatus : knowledge.loading ? "loading" : "empty", caption: summary ? `${summary.logEntryCount} total entries` : "Latest log tail", tone: summary?.latestLogStatus === "available" ? "good" : undefined },
  ];
  return (
    <div className="bridge-knowledge-grid">
      {metrics.map((metric) => <MetricCard key={metric.label} metric={metric} />)}
    </div>
  );
}

function HealthStrip({ health }: { readonly health: AsyncPanelState<ObserverStatus> }) {
  const value = health.value;
  const metrics: readonly Metric[] = [
    { label: "Version", value: value?.version ?? "…", caption: "Console runtime" },
    { label: "Channel", value: value?.channel ?? "…", caption: "Release channel" },
    { label: "Port", value: value ? String(value.port) : "…", caption: "Loopback listener" },
    { label: "Codex", value: value?.wikiServerStatus ?? "unknown", caption: "Active Theater status", tone: value?.wikiServerStatus === "available" ? "good" : value?.wikiServerStatus === "unavailable" ? "bad" : undefined },
    { label: "Observer", value: value ? `${value.workspaces}/${value.jobs}` : health.loading ? "loading" : "unknown", caption: "Workspaces / jobs" },
  ];
  return (
    <>
      <div className="bridge-health-strip">
        {metrics.map((metric) => <MetricCard key={metric.label} metric={metric} />)}
      </div>
      {health.error ? <p className="bridge-health-error">System health unavailable.</p> : null}
    </>
  );
}

function CarrierMatrix({ carriers }: { readonly carriers: AsyncPanelState<readonly CarrierReadinessEntry[]> }) {
  if (carriers.error) {
    return (
      <div className="bridge-empty bridge-empty--warn">
        <p>Carrier readiness degraded.</p>
      </div>
    );
  }
  const entries = carriers.value ?? [];
  if (entries.length === 0) {
    return (
      <div className="bridge-empty">
        <p>{carriers.loading ? "Loading carrier readiness." : "No carrier readiness entries available."}</p>
      </div>
    );
  }
  return (
    <div className="bridge-carrier-table" role="table" aria-label="Carrier readiness matrix">
      <div className="bridge-carrier-row bridge-carrier-head" role="row">
        <span role="columnheader">Carrier</span>
        <span role="columnheader">Role</span>
        <span role="columnheader">Model</span>
        <span role="columnheader">Effort</span>
        <span role="columnheader">Task Force</span>
        <span role="columnheader">Mode</span>
      </div>
      {entries.map((carrier) => (
        <div className="bridge-carrier-row" role="row" key={carrier.carrierId}>
          <span role="cell" className="bridge-carrier-name" data-signature={carrierSignatureKey(carrier)}>
            <strong>{carrier.displayName}</strong>
            <small>{carrier.category ?? "unknown"}</small>
          </span>
          <span role="cell">{carrier.role ?? carrier.category ?? "unknown"}</span>
          <span role="cell">{carrier.model || "unknown"}</span>
          <span role="cell">{carrier.effort ?? "default"}</span>
          <span role="cell">{carrier.taskForceBackendCount}</span>
          <span role="cell">{carrier.subagentMode ? "subagent" : carrier.cliType || "cli"}</span>
        </div>
      ))}
    </div>
  );
}

function MetricCard({ metric }: { readonly metric: Metric }) {
  return (
    <article className={`bridge-card ${metric.tone ? `bridge-card--${metric.tone}` : ""}`}>
      <p className="bridge-card-label">{metric.label}</p>
      <strong>{metric.value}</strong>
      <p>{metric.caption}</p>
    </article>
  );
}

function TheaterRow({ theater }: { readonly theater: TheaterReadiness }) {
  return (
    <div className={`bridge-matrix-row ${theater.active ? "is-active" : ""}`} role="row">
      <span role="cell">
        <span className={`bridge-theater-live ${theater.liveJobCount > 0 ? "is-live" : ""}`} aria-hidden="true" />
        {theater.label}
      </span>
      <span role="cell">{theater.hasWiki ? "available" : "unavailable"}</span>
      <span role="cell">{theater.activeAdmiralCount}</span>
      <span role="cell">{theater.terminalSessionCount}</span>
      <span role="cell">{formatActivity(theater.lastActivityAt)}</span>
    </div>
  );
}

function formatActivity(at: number | null): string {
  if (!at) return "none";
  return new Date(at).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 캐리어 이름색 시그니처 키 — fleet-cli getEntryColor 패리티:
// Task Force 백엔드 2개 이상이면서 subagent가 아니면 taskforce 색, 그 외에는 CLI 타입 시그니처색.
function carrierSignatureKey(carrier: CarrierReadinessEntry): string {
  if (!carrier.subagentMode && carrier.taskForceBackendCount >= 2) return "taskforce";
  return carrier.cliType;
}
