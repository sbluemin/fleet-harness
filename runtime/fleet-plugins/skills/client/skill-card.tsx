import { useCallback, useEffect, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { SkillListItem } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface SkillCardProps {
  readonly skill: SkillListItem;
  /** 같은 이름이 다른 scope에도 설치돼 있고, 이 카드가 가리는 쪽일 때만 참이다. */
  readonly shadowsOtherScope?: boolean;
  readonly onReadMore?: (skill: SkillListItem) => void;
  readonly onRemove?: (name: string, scope: string) => void;
  readonly t: Translate<SkillsMessageKey>;
}

// ─── constants ───────────────────────────────────────────────────────────────

const REMOVE_ARM_MS = 2600;

// ─── SkillCard ────────────────────────────────────────────────────────────────

export function SkillCard({ skill, shadowsOtherScope, onReadMore, onRemove, t }: SkillCardProps) {
  const [removeArmed, setRemoveArmed] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearArmTimer = useCallback(() => {
    if (armTimerRef.current) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
  }, []);

  const handleRemoveClick = useCallback(() => {
    if (!removeArmed) {
      setRemoveArmed(true);
      armTimerRef.current = setTimeout(() => setRemoveArmed(false), REMOVE_ARM_MS);
    } else {
      clearArmTimer();
      setRemoveArmed(false);
      onRemove?.(skill.name, skill.scope);
    }
  }, [removeArmed, clearArmTimer, onRemove, skill.name, skill.scope]);

  useEffect(() => () => clearArmTimer(), [clearArmTimer]);

  // 출처가 없는 스킬은 레지스트리에서 온 것이 아니라 손으로 쓴 것이다. 빈 줄로 두면 "아직
  // 못 읽었다"로 읽히므로, 아는 사실(이 Theater에서 작성된 파일)을 그대로 적는다.
  const provenance = skill.source ?? t("skills.card.local");
  const metaParts = [
    t(skill.agents.length === 1 ? "skills.card.agents_one" : "skills.card.agents_other", {
      count: skill.agents.length,
    }),
    provenance,
  ];
  // 가림은 방향이 있는 사실이다 — project 사본이 global을 가리는 것이지, 그 반대가 아니다.
  if (shadowsOtherScope) {
    metaParts.push(t(
      skill.scope === "project" ? "skills.card.shadowsGlobal" : "skills.card.shadowedByProject",
    ));
  }

  return (
    <div className="skills-card">
      <div className="skills-card-header">
        <button
          type="button"
          className="skills-card-name-btn"
          onClick={() => onReadMore?.(skill)}
          title={t("skills.action.readSkillMd")}
        >
          {skill.name}
        </button>
      </div>
      {/* 설명은 있을 때만 자리를 차지한다 — 없는 스킬에 "설명 없음"을 적으면 두 줄을 들여
          아무것도 말하지 않는 카드가 된다. */}
      {skill.description && (
        <p className="skills-card-desc">{skill.description}</p>
      )}
      <div className="skills-card-footer">
        <span className="skills-card-meta">{metaParts.join(" · ")}</span>
        {onRemove && (
          <button
            type="button"
            className={`skills-btn skills-btn--remove${removeArmed ? " is-armed" : ""}`}
            onClick={handleRemoveClick}
            aria-label={
              removeArmed
                ? t("skills.action.removeConfirmAria", { name: skill.name })
                : t("skills.action.removeAria", { name: skill.name })
            }
          >
            {removeArmed ? t("skills.action.removeConfirm") : t("skills.action.remove")}
          </button>
        )}
      </div>
    </div>
  );
}
