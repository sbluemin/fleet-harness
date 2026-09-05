import { useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { AgentId, Scope } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";

interface InstallFlowProps {
  readonly theaterId: string | null;
  readonly onCancel: () => void;
  readonly onInstall: (scope: Scope, agents: AgentId[]) => void;
  readonly disabled: boolean;
  readonly t: Translate<SkillsMessageKey>;
}

export const AGENT_LABELS: Record<AgentId, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};
const AGENT_IDS = Object.keys(AGENT_LABELS) as AgentId[];

export function InstallFlow({ theaterId, onCancel, onInstall, disabled, t }: InstallFlowProps) {
  const [scope, setScope] = useState<Scope>(theaterId ? "project" : "global");
  const [selectedAgents, setSelectedAgents] = useState<AgentId[]>(AGENT_IDS);

  return (
    <form className="skills-install-flow" onSubmit={(event) => {
      event.preventDefault();
      if (disabled || selectedAgents.length === 0) return;
      onInstall(scope, selectedAgents);
    }}>
      <fieldset disabled={disabled}>
        <legend>{t("skills.scope.label")}</legend>
        <div className="skills-install-choices">
          {(["project", "global"] as const).map((value) => (
            <label className="skills-install-choice" key={value}>
              <input type="radio" name="skills-install-scope" value={value} checked={scope === value}
                disabled={value === "project" && !theaterId} onChange={() => setScope(value)} />
              <span>{t(value === "project" ? "skills.scope.project" : "skills.scope.global")}
                <small>{t(value === "project" ? "skills.scope.projectHint" : "skills.scope.globalHint")}</small>
              </span>
            </label>
          ))}
        </div>
        {!theaterId && <p className="skills-scope-description">{t("skills.install.selectTheater")}</p>}
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>{t("skills.install.agents")}</legend>
        <div className="skills-install-choices">
          {AGENT_IDS.map((id) => (
            <label className="skills-install-choice" key={id}>
              <input type="checkbox" checked={selectedAgents.includes(id)} onChange={(event) => {
                setSelectedAgents((prev) => event.target.checked ? [...prev, id] : prev.filter((agent) => agent !== id));
              }} />
              {AGENT_LABELS[id]}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="skills-permission-warning">{t("skills.overlay.permissionWarning")}</p>
      <div className="skills-card-actions">
        <button type="button" className="skills-btn skills-btn--ghost" onClick={onCancel}>{t(disabled ? "skills.overlay.close" : "skills.action.cancel")}</button>
        <button type="submit" className="skills-btn skills-btn--primary" disabled={disabled || selectedAgents.length === 0}>
          {t("skills.install.confirm", { scope: t(scope === "project" ? "skills.scope.project" : "skills.scope.global"), count: selectedAgents.length })}
        </button>
      </div>
    </form>
  );
}
