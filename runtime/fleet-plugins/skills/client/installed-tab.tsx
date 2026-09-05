import { useCallback, useEffect, useRef, useState } from "react";

import { FailureNotice } from "@fleet-console/sdk/components/failure-notice";
import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";

import type { SkillListItem } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";
import { filterInstalled, namesInOtherScope } from "./installed-view.js";
import { JobStatusDock } from "./skill-feedback.js";
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
  if (!res.ok) throw new Error("list_failed");
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
  const [listFailed, setListFailed] = useState(false);
  const listRequestRef = useRef(0);
  useEffect(() => () => { listRequestRef.current += 1; }, []);

  const loadList = useCallback((tid: string | null) => {
    const requestContextKey = skillsContextKey(tid);
    const requestId = ++listRequestRef.current;
    setListFailed(false);
    setInstalledState(requestContextKey, [], true);
    fetchInstalledList(tid)
      .then((skills) => { if (requestId === listRequestRef.current) setInstalledState(requestContextKey, skills, false); })
      .catch(() => {
        if (requestId !== listRequestRef.current) return;
        setInstalledState(requestContextKey, [], false);
        setListFailed(true);
      });
  }, []);

  useEffect(() => {
    loadList(theaterId);
  }, [theaterId, loadList, refreshKey]);

  useEffect(() => {
    if (updateLog.status === "done" || updateLog.status === "error") {
      loadList(theaterId);
    }
  }, [updateLog.status, theaterId, loadList]);

  const handleUpdate = useCallback((updScope: Scope) => {
    if (updateLog.status === "running") return;
    updateScopeRef.current = updScope;
    const body: Record<string, unknown> = { scope: updScope };
    if (updScope === "project" && theaterId) {
      body["theaterId"] = theaterId;
    }
    updateLog.start("/plugins/skills/update", body);
  }, [theaterId, updateLog]);

  const handleRetry = useCallback(() => {
    if (updateScopeRef.current) handleUpdate(updateScopeRef.current);
  }, [handleUpdate]);

  const visibleScope: Scope = scope === "project" && !theaterId ? "global" : scope;
  const inScope = installedList.filter((s) => s.scope === visibleScope);
  const filtered = filterInstalled(inScope, filterText);
  const otherScopeNames = namesInOtherScope(installedList, visibleScope);

  const isUpdating =
    updateLog.status === "running" && updateScopeRef.current === visibleScope;

  // en 빈 상태는 소문자 scope 토큰을 유지하고, ko는 번역 라벨을 넣는다.
  const scopeToken = (language ?? "en") === "en"
    ? visibleScope
    : t(visibleScope === "project" ? "skills.scope.project" : "skills.scope.global");

  return (
    <>
      <div className="skills-tab-body">
        <div className="skills-scope-toggle" role="group" aria-label={t("skills.scope.label")}>
          <button
            type="button"
            className={`skills-scope-btn${visibleScope === "project" ? " is-active" : ""}`}
            aria-pressed={visibleScope === "project"}
            onClick={() => setScope("project")}
            disabled={!theaterId}
            title={!theaterId ? t("skills.scope.viewProjectTitle") : undefined}
          >
            {t("skills.scope.project")}
          </button>
          <button
            type="button"
            className={`skills-scope-btn${visibleScope === "global" ? " is-active" : ""}`}
            aria-pressed={visibleScope === "global"}
            onClick={() => setScope("global")}
          >
            {t("skills.scope.global")}
          </button>
        </div>

        <p className="skills-scope-description">{t(!theaterId ? "skills.install.selectTheater" : visibleScope === "project" ? "skills.scope.projectHint" : "skills.scope.globalHint")}</p>

        <input
          type="search"
          className="skills-filter-input"
          placeholder={t("skills.filter.installedPlaceholder")}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          aria-label={t("skills.filter.installedAria")}
        />

        {/* scope 전체를 건드리는 동사는 scope가 사는 자리에 하나만 둔다 — 카드마다 같은
            버튼을 복제하면 어느 것이 이 카드의 동사인지 알 수 없게 된다. */}
        {inScope.length > 0 && (
          <div className="skills-scope-shelf">
            <span className="skills-scope-shelf-label">
              {t("skills.update.scopeLabel", {
                count: inScope.length,
                scope: t(visibleScope === "project" ? "skills.scope.project" : "skills.scope.global"),
              })}
            </span>
            <button
              type="button"
              className="skills-btn skills-btn--ghost"
              onClick={() => handleUpdate(visibleScope)}
              disabled={updateLog.status === "running"}
            >
              {isUpdating ? t("skills.action.updating") : t("skills.action.update")}
            </button>
          </div>
        )}

        {installedLoading && <div className="skills-empty-state">{t("skills.empty.loading")}</div>}

        {!installedLoading && !listFailed && filtered.length === 0 && (
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
              shadowsOtherScope={otherScopeNames.has(skill.name)}
              onReadMore={onReadMore}
              t={t}
            />
          ))}
        </div>
      </div>

      {listFailed && (
        <FailureNotice title={t("skills.failure.list.title")} cause={t("skills.failure.list.cause")}
          actions={[{ label: t("skills.action.retry"), onSelect: () => loadList(theaterId), primary: true }]} tone="coral" />
      )}

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
