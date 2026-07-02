import { useCallback, useEffect, useRef, useState } from "react";

import type { SkillListItem } from "../server/types.js";
import { SkillCard } from "./skill-card.js";
import {
  setFilterText,
  setInstalledState,
  setScope,
  type Scope,
  useSkillsStore,
} from "./skills-store.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface InstalledTabProps {
  readonly theaterId: string | null;
  readonly onReadMore: (skill: SkillListItem) => void;
}

interface UpdateState {
  readonly status: "running" | "done" | "error";
  readonly lines: string[];
  readonly scope: Scope;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function fetchInstalledList(theaterId: string | null): Promise<SkillListItem[]> {
  const query = theaterId ? `?theaterId=${encodeURIComponent(theaterId)}` : "";
  const res = await fetch(`/plugins/skills/list${query}`);
  if (!res.ok) return [];
  const data = await res.json() as { skills: SkillListItem[] };
  return data.skills ?? [];
}

// ─── InstalledTab ─────────────────────────────────────────────────────────────

export function InstalledTab({ theaterId, onReadMore }: InstalledTabProps) {
  const { scope, filterText, installedList, installedLoading } = useSkillsStore();
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadList = useCallback((tid: string | null) => {
    setInstalledState([], true);
    fetchInstalledList(tid)
      .then((skills) => setInstalledState(skills, false))
      .catch(() => setInstalledState([], false));
  }, []);

  useEffect(() => {
    loadList(theaterId);
  }, [theaterId, loadList]);

  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current);
  }, []);

  const handleUpdate = useCallback((updScope: string) => {
    const s = updScope as Scope;
    setUpdateState({ status: "running", lines: [], scope: s });

    const body: Record<string, unknown> = { scope: s };
    if (theaterId) body["theaterId"] = theaterId;

    void (async () => {
      const res = await fetch("/plugins/skills/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);

      if (!res?.ok) {
        setUpdateState((prev) => prev ? { ...prev, status: "error" } : null);
        return;
      }

      const { jobId } = await res.json() as { jobId: string };
      let cursor = 0;

      const poll = async () => {
        const jr = await fetch(
          `/plugins/skills/jobs?jobId=${encodeURIComponent(jobId)}&cursor=${cursor}`,
        ).catch(() => null);
        if (!jr?.ok) {
          setUpdateState((prev) => prev ? { ...prev, status: "error" } : null);
          return;
        }
        const data = await jr.json() as { lines: string[]; nextCursor: number; status: string };
        cursor = data.nextCursor;
        setUpdateState((prev) =>
          prev ? { ...prev, lines: [...prev.lines, ...data.lines] } : null,
        );
        if (data.status === "running") {
          pollRef.current = setTimeout(() => { void poll(); }, 750);
        } else {
          setUpdateState((prev) =>
            prev ? { ...prev, status: data.status as "done" | "error" } : null,
          );
          loadList(theaterId);
        }
      };
      pollRef.current = setTimeout(() => { void poll(); }, 750);
    })();
  }, [theaterId, loadList]);

  const handleRemove = useCallback((name: string, removeScope: string) => {
    const body: Record<string, unknown> = { scope: removeScope, skill: name };
    if (theaterId) body["theaterId"] = theaterId;

    void fetch("/plugins/skills/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(() => loadList(theaterId))
      .catch(() => null);
  }, [theaterId, loadList]);

  const visibleScope: Scope = scope === "project" && !theaterId ? "global" : scope;
  const filtered = installedList.filter((s) => {
    if (s.scope !== visibleScope) return false;
    if (filterText) return s.name.toLowerCase().includes(filterText.toLowerCase());
    return true;
  });

  const isUpdating = updateState?.status === "running" && updateState.scope === visibleScope;

  return (
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

      {updateState && (
        <div className={`skills-update-log skills-update-log--${updateState.status}`}>
          {updateState.lines.map((line, i) => (
            <div key={i} className="skills-update-log-line">{line}</div>
          ))}
          {updateState.status === "done" && (
            <div className="skills-update-log-line skills-update-log-done">✓ Update complete</div>
          )}
          {updateState.status === "error" && (
            <div className="skills-update-log-line skills-update-log-error">✗ Update failed</div>
          )}
        </div>
      )}

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
  );
}
