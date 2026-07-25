import { useCallback, useEffect, useRef } from "react";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";

import type { SkillListItem } from "../server/types.js";
import type { SkillsMessageKey } from "./i18n/index.js";
import { JobStatusDock } from "./job-status-dock.js";
import { SkillCard } from "./skill-card.js";
import {
  hasInstalledStateForContext,
  setFilterText,
  setInstalledState,
  setScope,
  skillsContextKey,
  type Scope,
  useSkillsStore,
} from "./skills-store.js";
import { useJobLog } from "./use-job-log.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface InstalledTabProps {
  readonly theaterId: string | null;
  readonly onReadMore: (skill: SkillListItem) => void;
  readonly refreshKey?: number;
  readonly t: Translate<SkillsMessageKey>;
  readonly language?: ConsoleLocale;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function fetchInstalledList(theaterId: string | null): Promise<SkillListItem[]> {
  const query = theaterId
    ? `?theaterId=${encodeURIComponent(theaterId)}`
    : "";
  const res = await fetch(`/plugins/skills/list${query}`);
  if (!res.ok) return [];
  const data = await res.json() as { skills: SkillListItem[] };
  return data.skills ?? [];
}

// ─── InstalledTab ─────────────────────────────────────────────────────────────

export function InstalledTab({ theaterId, onReadMore, refreshKey, t, language }: InstalledTabProps) {
  const state = useSkillsStore();
  const { scope, filterText } = state;
  const contextKey = skillsContextKey(theaterId);
  const installedList = hasInstalledStateForContext(state, contextKey) ? state.installedList : [];
  const installedLoading = hasInstalledStateForContext(state, contextKey) && state.installedLoading;
  const updateLog = useJobLog();
  const updateScopeRef = useRef<Scope | null>(null);

  const loadList = useCallback((tid: string | null) => {
    const requestContextKey = skillsContextKey(tid);
    setInstalledState(requestContextKey, [], true);
    fetchInstalledList(tid)
      .then((skills) => setInstalledState(requestContextKey, skills, false))
      .catch(() => setInstalledState(requestContextKey, [], false));
  }, []);

  useEffect(() => {
    loadList(theaterId);
  }, [theaterId, loadList, refreshKey]);

  useEffect(() => {
    if (updateLog.status === "done" || updateLog.status === "error") {
      loadList(theaterId);
    }
  }, [updateLog.status, theaterId, loadList]);

  const handleUpdate = useCallback((updScope: string) => {
    const s = updScope as Scope;
    updateScopeRef.current = s;
    const body: Record<string, unknown> = { scope: s };
    if (s === "project" && theaterId) {
      body["theaterId"] = theaterId;
    }
    updateLog.start("/plugins/skills/update", body);
  }, [theaterId, updateLog]);

  const handleRemove = useCallback((name: string, removeScope: string) => {
    const body: Record<string, unknown> = { scope: removeScope, skill: name };
    if (removeScope === "project" && theaterId) {
      body["theaterId"] = theaterId;
    }

    void fetch("/plugins/skills/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(() => loadList(theaterId))
      .catch(() => null);
  }, [theaterId, loadList]);

  const handleRetry = useCallback(() => {
    if (updateScopeRef.current) handleUpdate(updateScopeRef.current);
  }, [handleUpdate]);

  const visibleScope: Scope = scope === "project" && !theaterId ? "global" : scope;
  const filtered = installedList.filter((s) => {
    if (s.scope !== visibleScope) return false;
    if (filterText) return s.name.toLowerCase().includes(filterText.toLowerCase());
    return true;
  });

  const isUpdating =
    updateLog.status === "running" && updateScopeRef.current === visibleScope;

  // en 빈 상태는 소문자 scope 토큰을 유지하고, ko는 번역 라벨을 넣는다.
  const scopeToken = (language ?? "en") === "en"
    ? visibleScope
    : t(visibleScope === "project" ? "skills.scope.project" : "skills.scope.global");

  return (
    <>
      <div className="skills-tab-body">
        <div className="skills-scope-toggle">
          <button
            type="button"
            className={`skills-scope-btn${visibleScope === "project" ? " is-active" : ""}`}
            onClick={() => setScope("project")}
            disabled={!theaterId}
            title={!theaterId ? "Select a Theater to view project skills" : undefined}
          >
            {t("skills.scope.project")}
          </button>
          <button
            type="button"
            className={`skills-scope-btn${visibleScope === "global" ? " is-active" : ""}`}
            onClick={() => setScope("global")}
          >
            {t("skills.scope.global")}
          </button>
        </div>

        <input
          type="search"
          className="skills-filter-input"
          placeholder={t("skills.filter.installedPlaceholder")}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          aria-label="Filter installed skills"
        />

        {installedLoading && <div className="skills-empty-state">{t("skills.empty.loading")}</div>}

        {!installedLoading && filtered.length === 0 && (
          <div className="skills-empty-state">
            {filterText
              ? t("skills.empty.noMatch")
              : t("skills.empty.noneInstalled", { scope: scopeToken })}
          </div>
        )}

        <div className="skills-card-list">
          {filtered.map((skill) => (
            <SkillCard
              key={`${skill.scope}:${skill.name}`}
              skill={skill}
              onReadMore={onReadMore}
              onUpdate={handleUpdate}
              onRemove={handleRemove}
              isUpdating={isUpdating}
              t={t}
            />
          ))}
        </div>
      </div>

      <JobStatusDock
        status={updateLog.status}
        lines={updateLog.lines}
        runningLabel={t("skills.status.updatingSkills")}
        doneLabel={t("skills.status.updated")}
        errorLabel={t("skills.status.updateFailed")}
        onDismiss={updateLog.reset}
        onRetry={handleRetry}
        t={t}
      />
    </>
  );
}
