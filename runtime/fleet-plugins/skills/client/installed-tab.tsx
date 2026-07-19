import { useCallback, useEffect, useRef } from "react";

import type { SkillListItem } from "../server/types.js";
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

export function InstalledTab({ theaterId, onReadMore, refreshKey }: InstalledTabProps) {
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
            Project
          </button>
          <button
            type="button"
            className={`skills-scope-btn${visibleScope === "global" ? " is-active" : ""}`}
            onClick={() => setScope("global")}
          >
            Global
          </button>
        </div>

        <input
          type="search"
          className="skills-filter-input"
          placeholder="Filter installed skills…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          aria-label="Filter installed skills"
        />

        {installedLoading && <div className="skills-empty-state">Loading…</div>}

        {!installedLoading && filtered.length === 0 && (
          <div className="skills-empty-state">
            {filterText ? "No skills match the filter." : `No ${visibleScope} skills installed.`}
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
            />
          ))}
        </div>
      </div>

      <JobStatusDock
        status={updateLog.status}
        lines={updateLog.lines}
        runningLabel="Updating skills…"
        doneLabel="Updated"
        errorLabel="Update failed"
        onDismiss={updateLog.reset}
        onRetry={handleRetry}
      />
    </>
  );
}
