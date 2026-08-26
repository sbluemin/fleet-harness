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

  // 출처는 세 상태다: 기록이 있음(레지스트리), lock을 읽었지만 없음(관리 밖 = 로컬),
  // 그리고 lock 자체를 읽지 못함(미상). 마지막을 "로컬"로 적으면 손으로 쓴 적 없는 스킬을
  // 손으로 썼다고 단언하게 되므로, 그때는 아무 말도 하지 않는다.
  const provenance = skill.source ?? (skill.unmanaged ? t("skills.card.local") : null);
  const metaParts = [
    t(skill.agents.length === 1 ? "skills.card.agents_one" : "skills.card.agents_other", {
      count: skill.agents.length,
    }),
  ];
  if (provenance) metaParts.push(provenance);
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
          aria-label={t("skills.action.readSkillPackageAria", { name: skill.name })}
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
            onKeyDown={(event) => {
              if ((event.key === "Enter" || event.key === " ") && event.repeat) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
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
