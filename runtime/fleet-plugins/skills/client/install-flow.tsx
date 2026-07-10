import { useCallback, useState } from "react";

import type { AgentId, Scope } from "../server/types.js";
import type { UseJobLogReturn } from "./use-job-log.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface InstallFlowProps {
  readonly source: string;
  readonly skill: string;
  readonly theaterId: string | null;
  readonly relPath: string | null;
  readonly onCancel: () => void;
  readonly onStarted: (scope: Scope) => void;
  readonly jobLog: UseJobLogReturn;
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

// ─── InstallFlow ──────────────────────────────────────────────────────────────

export function InstallFlow({ source, skill, theaterId, relPath, onCancel, onStarted, jobLog }: InstallFlowProps) {
  const [scope, setScope] = useState<Scope>(theaterId ? "project" : "global");
  const [allAgents, setAllAgents] = useState(true);
  const [selectedAgents, setSelectedAgents] = useState<Set<AgentId>>(new Set(AGENT_IDS));

  const { status, start } = jobLog;
  const isRunning = status === "running";
  const isDone = status === "done";
  const isError = status === "error";

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
    if (scope === "project" && theaterId) {
      body["theaterId"] = theaterId;
      body["relPath"] = relPath;
    }

    start("/plugins/skills/install", body);
    // 완료 전파(설치 목록 새로고침·탭 전환)는 잡 소유자(FindTab)가 status로 구동하므로,
    // 이 transient 폼은 설치 대상 scope만 시작 시점에 상위로 알린다.
    onStarted(scope);
  }, [allAgents, selectedAgents, source, skill, scope, theaterId, relPath, start, onStarted]);

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
    </div>
  );
}
