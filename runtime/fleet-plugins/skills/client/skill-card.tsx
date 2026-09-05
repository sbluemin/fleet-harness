import type { Translate } from "@fleet-console/sdk/i18n";

import { AGENT_LABELS } from "./install-flow.js";
import type { AgentId, SkillListItem } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";

interface SkillCardProps {
  readonly skill: SkillListItem;
  readonly shadowsOtherScope?: boolean;
  readonly onReadMore: (skill: SkillListItem) => void;
  readonly t: Translate<SkillsMessageKey>;
}

export function SkillCard({ skill, shadowsOtherScope, onReadMore, t }: SkillCardProps) {
  const provenance = skill.source ?? (skill.unmanaged ? t("skills.card.local") : null);
  return (
    <button type="button" className="skills-card skills-card-row" onClick={() => onReadMore(skill)} title={t("skills.action.readSkillMd")}>
      <span className="skills-card-header"><span className="skills-card-name">{skill.name}</span><span className="skills-card-chevron" aria-hidden="true">›</span></span>
      {skill.description && <span className="skills-card-desc">{skill.description}</span>}
      <span className="skills-card-footer">
        {provenance && <span className="skills-card-meta">{provenance}</span>}
        <span className="skills-card-meta">{skill.agents.map((agent) => AGENT_LABELS[agent as AgentId] ?? agent).join(" · ")}</span>
      </span>
      {shadowsOtherScope && <span className="skills-card-meta">{t(skill.scope === "project" ? "skills.card.shadowsGlobal" : "skills.card.shadowedByProject")}</span>}
    </button>
  );
}
