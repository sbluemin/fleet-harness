import { useCallback, useEffect, useRef, useState } from "react";

import type { SkillListItem } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface SkillCardProps {
  readonly skill: SkillListItem;
  readonly onReadMore?: (skill: SkillListItem) => void;
  readonly onUpdate?: (scope: string) => void;
  readonly onRemove?: (name: string, scope: string) => void;
  readonly isUpdating?: boolean;
}

// ─── constants ───────────────────────────────────────────────────────────────

const REMOVE_ARM_MS = 2600;

// ─── SkillCard ────────────────────────────────────────────────────────────────

export function SkillCard({ skill, onReadMore, onUpdate, onRemove, isUpdating }: SkillCardProps) {
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

  return (
    <div className="skills-card">
      <div className="skills-card-header">
        <button
          type="button"
          className="skills-card-name-btn"
          onClick={() => onReadMore?.(skill)}
          title="Read SKILL.md"
        >
          {skill.name}
        </button>
        <span className={`skills-card-scope-badge skills-card-scope-badge--${skill.scope}`}>
          {skill.scope}
        </span>
      </div>
      {skill.source && (
        <span className="skills-card-meta">{skill.source}</span>
      )}
      <span className="skills-card-meta skills-card-agents">{skill.agents.join(", ")}</span>
      <div className="skills-card-actions">
        {onUpdate && (
          <button
            type="button"
            className="skills-btn skills-btn--ghost"
            title={`Updates all ${skill.scope} skills`}
            onClick={() => onUpdate(skill.scope)}
            disabled={isUpdating}
          >
            {isUpdating ? "Updating…" : "Update all"}
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            className={`skills-btn skills-btn--remove${removeArmed ? " is-armed" : ""}`}
            onClick={handleRemoveClick}
            aria-label={removeArmed ? `Confirm remove ${skill.name}` : `Remove ${skill.name}`}
          >
            {removeArmed ? "Remove?" : "✕"}
          </button>
        )}
      </div>
    </div>
  );
}
