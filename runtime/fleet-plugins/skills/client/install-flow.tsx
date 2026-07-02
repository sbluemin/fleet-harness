import { useCallback, useEffect, useState } from "react";

import type { AgentId, Scope } from "../server/types.js";
import { useJobLog } from "./use-job-log.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface InstallFlowProps {
  readonly source: string;
  readonly skill: string;
  readonly theaterId: string | null;
  readonly onCancel: () => void;
  readonly onSuccess: (scope: Scope) => void;
}

// ─── constants ───────────────────────────────────────────────────────────────

const AGENT_IDS: AgentId[] = ["claude-code", "codex", "cursor", "opencode"];

const AGENT_LABELS: Record<AgentId, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

const PERMISSION_WARNING =
  "Skills run with full agent permissions. Review before use — open the name to read SKILL.md.";

const SUCCESS_LINGER_MS = 1200;

// ─── InstallFlow ──────────────────────────────────────────────────────────────

export function InstallFlow({ source, skill, theaterId, onCancel, onSuccess }: InstallFlowProps) {
  const [scope, setScope] = useState<Scope>(theaterId ? "project" : "global");
  const [allAgents, setAllAgents] = useState(true);
  const [selectedAgents, setSelectedAgents] = useState<Set<AgentId>>(new Set(AGENT_IDS));

  const { status, lines, start } = useJobLog();
  const isRunning = status === "running";
  const isDone = status === "done";
  const isError = status === "error";

  useEffect(() => {
    if (!isDone) return;
    const timer = setTimeout(() => onSuccess(scope), SUCCESS_LINGER_MS);
    return () => clearTimeout(timer);
  }, [isDone, onSuccess, scope]);

  const handleToggleAll = useCallback(() => {
    setAllAgents(true);
    setSelectedAgents(new Set(AGENT_IDS));
  }, []);

  const handleToggleAgent = useCallback((agentId: AgentId) => {
    setAllAgents(false);
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }, []);

  const handleInstall = useCallback(() => {
    const agents: AgentId[] = allAgents ? AGENT_IDS : Array.from(selectedAgents);
    if (agents.length === 0) return;

    const body: Record<string, unknown> = { source, skill, scope, agents };
    if (scope === "project" && theaterId) body["theaterId"] = theaterId;

    start("/plugins/skills/install", body);
  }, [allAgents, selectedAgents, source, skill, scope, theaterId, start]);

  return (
    <div className="skills-install-flow">
      <div className="skills-scope-toggle">
        <button
          type="button"
          className={`skills-scope-btn${scope === "project" ? " is-active" : ""}`}
          onClick={() => setScope("project")}
          disabled={!theaterId || isRunning || isDone}
          title={!theaterId ? "Select a Theater to install project skills" : undefined}
        >
          Project
        </button>
        <button
          type="button"
          className={`skills-scope-btn${scope === "global" ? " is-active" : ""}`}
          onClick={() => setScope("global")}
          disabled={isRunning || isDone}
        >
          Global
        </button>
      </div>

      <div className="skills-agents-row">
        <button
          type="button"
          className={`skills-agent-chip${allAgents ? " is-active" : ""}`}
          onClick={handleToggleAll}
          disabled={isRunning || isDone}
        >
          All agents
        </button>
        {AGENT_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={`skills-agent-chip${!allAgents && selectedAgents.has(id) ? " is-active" : ""}`}
            onClick={() => handleToggleAgent(id)}
            disabled={isRunning || isDone}
          >
            {AGENT_LABELS[id]}
          </button>
        ))}
      </div>

      <p className="skills-permission-warning">{PERMISSION_WARNING}</p>

      {!isRunning && !isDone && !isError && (
        <div className="skills-card-actions">
          <button
            type="button"
            className="skills-btn skills-btn--ghost"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="skills-btn skills-btn--primary"
            onClick={handleInstall}
            disabled={!allAgents && selectedAgents.size === 0}
          >
            Install now
          </button>
        </div>
      )}

      {(isRunning || isDone || isError) && (
        <div className="skills-update-log">
          {lines.map((line, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className="skills-update-log-line">{line}</div>
          ))}
          {isDone && (
            <div className="skills-update-log-line skills-update-log-done">✓ Installed</div>
          )}
          {isError && (
            <div className="skills-update-log-line skills-update-log-error">✗ Install failed</div>
          )}
        </div>
      )}
    </div>
  );
}
