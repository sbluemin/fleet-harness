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
  if (!res.ok) throw new Error(String(res.status));
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
  const [removeFailed, setRemoveFailed] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  // 실패한 제거의 대상 Theater까지 들고 있어야 한다. Theater를 바꾼 뒤 재시도를 누르면
  // 지금 보고 있는 Theater에서 같은 이름의 스킬을 지우게 되기 때문이다.
  const lastRemoveRef = useRef<{ readonly name: string; readonly scope: string; readonly theaterId: string | null } | null>(null);
  // 나간 요청을 세어 그 번호로 완료를 맞춰 본다. Theater를 옮기는 동안 날아가던 요청이
  // 뒤늦게 실패로 돌아오면, 그 실패는 지금 화면의 사실이 아니다.
  const removeRequestRef = useRef(0);
  const listRequestRef = useRef(0);

  const loadList = useCallback((tid: string | null) => {
    const requestContextKey = skillsContextKey(tid);
    const requestId = listRequestRef.current + 1;
    listRequestRef.current = requestId;
    setListFailed(false);
    setInstalledState(requestContextKey, [], true);
    fetchInstalledList(tid)
      .then((skills) => {
        if (listRequestRef.current !== requestId) return;
        setInstalledState(requestContextKey, skills, false);
      })
      .catch(() => {
        if (listRequestRef.current !== requestId) return;
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
    updateScopeRef.current = updScope;
    const body: Record<string, unknown> = { scope: updScope };
    if (updScope === "project" && theaterId) {
      body["theaterId"] = theaterId;
    }
    updateLog.start("/plugins/skills/update", body);
  }, [theaterId, updateLog]);

  const removeSkill = useCallback((name: string, removeScope: string, targetTheaterId: string | null) => {
    const body: Record<string, unknown> = { scope: removeScope, skill: name };
    if (removeScope === "project" && targetTheaterId) {
      body["theaterId"] = targetTheaterId;
    }
    const requestId = removeRequestRef.current + 1;
    removeRequestRef.current = requestId;
    lastRemoveRef.current = { name, scope: removeScope, theaterId: targetTheaterId };
    setRemoveFailed(false);

    void fetch("/plugins/skills/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((response) => {
        // fetch는 4xx·5xx에도 resolve한다. ok를 보지 않으면 서버가 거절한 제거가 성공으로
        // 처리되고, 목록만 다시 불러와 아무 일도 없던 것처럼 보인다 — 스킬은 그대로 남는다.
        if (!response.ok) throw new Error(String(response.status));
        loadList(targetTheaterId);
      })
      .catch(() => {
        // 이 요청이 더 이상 화면이 기다리는 요청이 아니면(Theater 전환이나 새 제거가 뒤이었다면)
        // 그 실패는 지금 보이는 목록의 사실이 아니다 — 재시도할 대상도 이미 사라졌다.
        if (removeRequestRef.current !== requestId) return;
        setRemoveFailed(true);
      });
  }, [loadList]);

  const handleRemove = useCallback((name: string, removeScope: string) => {
    removeSkill(name, removeScope, theaterId);
  }, [removeSkill, theaterId]);

  const retryRemove = useCallback(() => {
    const last = lastRemoveRef.current;
    // 실패했던 그 Theater를 다시 겨눈다 — 지금 보고 있는 Theater가 아니다.
    if (last) removeSkill(last.name, last.scope, last.theaterId);
  }, [removeSkill]);

  // Theater를 옮기면 앞선 실패의 맥락이 화면에서 사라진다. 남은 재시도 카드가 다른 Theater의
  // 목록 위에 떠 있지 않도록 함께 거두고, 아직 날아가는 요청의 번호도 무효로 만든다.
  useEffect(() => {
    removeRequestRef.current += 1;
    setRemoveFailed(false);
    lastRemoveRef.current = null;
  }, [theaterId]);

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
        <div className="skills-scope-toggle">
          <button
            type="button"
            className={`skills-scope-btn${visibleScope === "project" ? " is-active" : ""}`}
            onClick={() => setScope("project")}
            disabled={!theaterId}
            title={!theaterId ? t("skills.scope.viewProjectTitle") : undefined}
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
              disabled={isUpdating}
            >
              {isUpdating ? t("skills.action.updating") : t("skills.action.update")}
            </button>
          </div>
        )}

        {installedLoading && <div className="skills-empty-state" role="status" aria-live="polite">{t("skills.empty.loading")}</div>}

        {!installedLoading && listFailed ? (
          <FailureNotice
            title={t("skills.failure.list.title")}
            cause={t("skills.failure.list.cause")}
            actions={[{ label: t("skills.action.retry"), onSelect: () => loadList(theaterId), primary: true }]}
            tone="coral"
          />
        ) : null}

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
              onRemove={handleRemove}
              t={t}
            />
          ))}
        </div>
      </div>

      {removeFailed ? (
        <FailureNotice
          title={t("skills.failure.remove.title")}
          cause={t("skills.failure.remove.cause")}
          actions={[{ label: t("skills.failure.remove.retry"), onSelect: retryRemove, primary: true }]}
          tone="coral"
          className="skills-remove-failure"
        />
      ) : null}

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
