import type { Translate } from "@fleet-console/sdk/i18n";

import type { SkillListItem } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";

interface SkillCardProps {
  readonly skill: SkillListItem;
  readonly shadowsOtherScope?: boolean;
  readonly onReadMore: (skill: SkillListItem) => void;
  readonly t: Translate<SkillsMessageKey>;
}

/**
 * 카드 아래 줄은 "Fleet 세션이 이 스킬을 싣는가"를 먼저 말한다. 예전에는 CLI가 보고한 에이전트
 * 이름을 알파벳순으로 이어 붙여 Amp·Antigravity가 줄을 채우고 정작 Claude Code는 잘려 보이지
 * 않았다. 다른 CLI는 개수만 남기고 전체 이름은 읽기 창에 둔다. 출처는 제 줄을 가져 잘리지 않는다.
 */
export function SkillCard({ skill, shadowsOtherScope, onReadMore, t }: SkillCardProps) {
  const provenance = skill.source ?? (skill.unmanaged ? t("skills.card.local") : null);
  const otherCount = skill.agents.length;
  return (
    <button type="button" className="skills-card skills-card-row" onClick={() => onReadMore(skill)} title={t("skills.action.readSkillMd")}>
      <span className="skills-card-header"><span className="skills-card-name">{skill.name}</span><span className="skills-card-chevron" aria-hidden="true">›</span></span>
      {skill.description && <span className="skills-card-desc">{skill.description}</span>}
      {provenance && <span className="skills-card-source">{provenance}</span>}
      <span className="skills-card-footer">
        <span className={`skills-card-target${skill.claudeCode ? " is-on" : ""}`}>
          {t(skill.claudeCode ? "skills.card.claudeOn" : "skills.card.claudeOff")}
        </span>
        {otherCount > 0 && (
          <span className="skills-card-meta">
            {t(otherCount === 1 ? "skills.card.otherClis_one" : "skills.card.otherClis_other", { count: otherCount })}
          </span>
        )}
      </span>
      {shadowsOtherScope && <span className="skills-card-meta">{t(skill.scope === "project" ? "skills.card.shadowsGlobal" : "skills.card.shadowedByProject")}</span>}
    </button>
  );
}
