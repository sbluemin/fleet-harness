import { useCallback, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { AgentId, Scope } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";
import type { UseJobLogReturn } from "./use-job-log.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface InstallFlowProps {
  readonly source: string;
  readonly skill: string;
  readonly theaterId: string | null;
  readonly onCancel: () => void;
  readonly onStarted: (scope: Scope) => void;
  readonly jobLog: UseJobLogReturn;
  readonly t: Translate<SkillsMessageKey>;
}

// ─── constants ───────────────────────────────────────────────────────────────

const AGENT_IDS: AgentId[] = ["claude-code", "codex", "cursor", "opencode"];

const AGENT_LABELS: Record<AgentId, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

// ─── InstallFlow ──────────────────────────────────────────────────────────────

export function InstallFlow({ source, skill, theaterId, onCancel, onStarted, jobLog, t }: InstallFlowProps) {
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
    }

    start("/plugins/skills/install", body);
    // 완료 전파(설치 목록 새로고침·탭 전환)는 잡 소유자(FindTab)가 status로 구동하므로,
    // 이 transient 폼은 설치 대상 scope만 시작 시점에 상위로 알린다.
    onStarted(scope);
  }, [allAgents, selectedAgents, source, skill, scope, theaterId, start, onStarted]);

  return (
    <div className="skills-install-flow">
      <div className="skills-scope-toggle">
        <button
          type="button"
          className={`skills-scope-btn${scope === "project" ? " is-active" : ""}`}
          onClick={() => setScope("project")}
          disabled={!theaterId || isRunning || isDone}
          title={!theaterId ? t("skills.install.selectTheater") : undefined}
        >
          {t("skills.scope.project")}
        </button>
        <button
          type="button"
          className={`skills-scope-btn${scope === "global" ? " is-active" : ""}`}
          onClick={() => setScope("global")}
          disabled={isRunning || isDone}
        >
          {t("skills.scope.global")}
        </button>
      </div>

      <div className="skills-agents-row">
        <button
          type="button"
          className={`skills-agent-chip${allAgents ? " is-active" : ""}`}
          onClick={handleToggleAll}
          disabled={isRunning || isDone}
        >
          {t("skills.install.allAgents")}
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

      <p className="skills-permission-warning">{t("skills.install.permissionWarning")}</p>

      {!isRunning && !isDone && !isError && (
        <div className="skills-card-actions">
          <button
            type="button"
            className="skills-btn skills-btn--ghost"
            onClick={onCancel}
          >
            {t("skills.action.cancel")}
          </button>
          <button
            type="button"
            className="skills-btn skills-btn--primary"
            onClick={handleInstall}
            disabled={!allAgents && selectedAgents.size === 0}
          >
            {t("skills.install.installNow")}
          </button>
        </div>
      )}
    </div>
  );
}
