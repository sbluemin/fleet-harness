import { useEffect } from "react";

import { loadAgentCliState, useAgentCliStore } from "../agent-cli-store.js";
import type { AgentCliStatus } from "../types.js";

interface AgentCliRowProps {
  readonly cli: AgentCliStatus;
}

export function AgentCliSection() {
  const store = useAgentCliStore();

  useEffect(() => {
    const controller = new AbortController();
    void loadAgentCliState(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <section className="global-settings-card" aria-label="Agent CLI availability">
      <div className="agent-cli-head">
        <p className="global-settings-resp-title">Agent CLI</p>
        <p className="global-settings-help">
          Whether each Agent CLI is installed and discoverable on this machine&apos;s PATH, with its detected version.
          Carriers can only run on an Agent CLI shown as available here.
        </p>
      </div>

      {store.error ? <p className="global-settings-error" role="alert">{store.error}</p> : null}
      {store.loading && !store.state ? <p className="global-settings-help">Checking Agent CLIs.</p> : null}

      {store.state?.clis.map((cli) => <AgentCliRow key={cli.id} cli={cli} />)}

      <p className="global-settings-foot">Install or update a CLI, then reopen this page to re-check availability.</p>
    </section>
  );
}

function AgentCliRow({ cli }: AgentCliRowProps) {
  return (
    <div className="agent-cli-row">
      <span className="agent-cli-name">{cli.displayName}</span>
      <span className="agent-cli-meta">
        {cli.available && cli.version ? <span className="agent-cli-version">{cli.version}</span> : null}
        <span className={`agent-cli-status ${cli.available ? "is-on" : ""}`}>
          {cli.available ? "Available" : "Not found"}
        </span>
      </span>
    </div>
  );
}
