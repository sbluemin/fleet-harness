import { useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { InstallTarget, Scope } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";

interface InstallFlowProps {
  readonly theaterId: string | null;
  readonly onCancel: () => void;
  readonly onInstall: (scope: Scope, targets: InstallTarget[]) => void;
  readonly disabled: boolean;
  readonly t: Translate<SkillsMessageKey>;
}

/**
 * 고르는 것은 에이전트가 아니라 설치될 **폴더**다. 예전에는 CLI 넷을 체크박스로 나열했지만,
 * Codex·Cursor·OpenCode는 같은 공용 폴더를 읽어 어느 것을 골라도 결과가 같았고, 목록에는
 * 고르지 않은 CLI 수십 개가 함께 나타났다. Fleet 세션은 Claude Code이므로 그쪽이 기본이다.
 */
const TARGETS: readonly {
  readonly id: InstallTarget;
  readonly label: SkillsMessageKey;
  readonly projectHint: SkillsMessageKey;
  readonly globalHint: SkillsMessageKey;
}[] = [
  { id: "claude-code", label: "skills.target.claude", projectHint: "skills.target.claudeProjectHint", globalHint: "skills.target.claudeGlobalHint" },
  { id: "universal", label: "skills.target.shared", projectHint: "skills.target.sharedProjectHint", globalHint: "skills.target.sharedGlobalHint" },
];

export function InstallFlow({ theaterId, onCancel, onInstall, disabled, t }: InstallFlowProps) {
  const [scope, setScope] = useState<Scope>(theaterId ? "project" : "global");
  const [selected, setSelected] = useState<InstallTarget[]>(["claude-code"]);

  return (
    <form className="skills-install-flow" onSubmit={(event) => {
      event.preventDefault();
      if (disabled || selected.length === 0) return;
      onInstall(scope, selected);
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
        <legend>{t("skills.target.label")}</legend>
        <div className="skills-install-choices">
          {TARGETS.map((target) => (
            <label className="skills-install-choice" key={target.id}>
              <input type="checkbox" checked={selected.includes(target.id)} onChange={(event) => {
                setSelected((prev) => event.target.checked ? [...prev, target.id] : prev.filter((id) => id !== target.id));
              }} />
              <span>{t(target.label)}
                <small>{t(scope === "project" ? target.projectHint : target.globalHint)}</small>
              </span>
            </label>
          ))}
        </div>
        {!selected.includes("claude-code") && selected.length > 0 && (
          <p className="skills-scope-description">{t("skills.target.notForFleet")}</p>
        )}
      </fieldset>
      <p className="skills-permission-warning">{t("skills.overlay.permissionWarning")}</p>
      <div className="skills-card-actions">
        <button type="button" className="skills-btn skills-btn--ghost" onClick={onCancel}>{t(disabled ? "skills.overlay.close" : "skills.action.cancel")}</button>
        <button type="submit" className="skills-btn skills-btn--primary" disabled={disabled || selected.length === 0}>
          {t("skills.install.confirm", { scope: t(scope === "project" ? "skills.scope.project" : "skills.scope.global") })}
        </button>
      </div>
    </form>
  );
}
