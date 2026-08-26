import { useCallback, useEffect, useRef, useState } from "react";

import { FailureNotice } from "@fleet-console/sdk/components/failure-notice";
import type { Translate } from "@fleet-console/sdk/i18n";

import type { Scope, SkillListItem, SkillSearchItem } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";
import { InstallFlow } from "./install-flow.js";
import { JobStatusDock } from "./skill-feedback.js";
import {
  setInstallFormOpenId,
  setSearchQuery,
  setSearchState,
  useSkillsStore,
} from "./skills-store.js";
import { useJobLog, type UseJobLogReturn } from "./use-job-log.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface FindTabProps {
  readonly theaterId: string | null;
  readonly onReadMore: (skill: SkillListItem, registryId: string) => void;
  readonly onInstallSuccess: (skillName: string, scope: Scope) => void;
  readonly t: Translate<SkillsMessageKey>;
}

interface FindResultCardProps {
  readonly result: SkillSearchItem;
  readonly theaterId: string | null;
  readonly isFormOpen: boolean;
  readonly onInstallClick: () => void;
  readonly onReadMore: (skill: SkillListItem, registryId: string) => void;
  readonly onInstallStarted: (skillName: string, scope: Scope) => void;
  readonly jobLog: UseJobLogReturn;
  readonly t: Translate<SkillsMessageKey>;
}

// ─── constants ───────────────────────────────────────────────────────────────

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

async function doSearch(q: string, signal: AbortSignal): Promise<void> {
  if (q.length < MIN_QUERY_LEN) { setSearchState([], false); return; }
  setSearchState([], true);
  try {
    const res = await fetch(`/plugins/skills/search?q=${encodeURIComponent(q)}&limit=10`, { signal });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json() as { skills: SkillSearchItem[] };
    if (!signal.aborted) setSearchState(data.skills ?? [], false);
  } catch {
    if (!signal.aborted) setSearchState([], false, true);
  }
}

// ─── FindResultCard ───────────────────────────────────────────────────────────

function FindResultCard({
  result,
  theaterId,
  isFormOpen,
  onInstallClick,
  onReadMore,
  onInstallStarted,
  jobLog,
  t,
}: FindResultCardProps) {
  const previewSkill: SkillListItem = {
    name: result.name,
    scope: "project",
    agents: [],
    source: result.source,
    displayPath: "",
  };

  return (
    <div className={`skills-card${isFormOpen ? " is-expanded" : ""}`}>
      <div className="skills-card-header">
        <button
          type="button"
          className="skills-card-name-btn"
          onClick={() => onReadMore(previewSkill, result.id)}
          title={t("skills.action.readSkillMdPreview")}
        >
          {result.name}
        </button>
        {result.installs > 0 && (
          <span className="skills-card-installs">{t("skills.card.installs", { count: formatInstalls(result.installs) })}</span>
        )}
      </div>
      <span className="skills-card-meta">{result.source}</span>
      <div className="skills-card-actions">
        <button
          type="button"
          className="skills-btn skills-btn--primary"
          onClick={onInstallClick}
        >
          {isFormOpen ? t("skills.action.cancel") : t("skills.action.install")}
        </button>
      </div>
      {isFormOpen && (
        <InstallFlow
          source={result.source}
          skill={result.name}
          theaterId={theaterId}
          onCancel={onInstallClick}
          onStarted={(installedScope) => onInstallStarted(result.name, installedScope)}
          jobLog={jobLog}
          t={t}
        />
      )}
    </div>
  );
}

// ─── FindTab ─────────────────────────────────────────────────────────────────

export function FindTab({ theaterId, onReadMore, onInstallSuccess, t }: FindTabProps) {
  const { searchQuery, searchResults, searchLoading, searchFailed, installFormOpenId } = useSkillsStore();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const installJobLog = useJobLog();
  const [installTarget, setInstallTarget] = useState<{ name: string; scope: Scope } | null>(null);

  const runSearch = useCallback((q: string) => {
    searchAbortRef.current?.abort();
    const abort = new AbortController();
    searchAbortRef.current = abort;
    void doSearch(q, abort.signal);
  }, []);

  const handleQueryChange = useCallback((q: string) => {
    setSearchQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    searchAbortRef.current?.abort();
    if (q.length < MIN_QUERY_LEN) { setSearchState([], false); return; }
    debounceRef.current = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE_MS);
  }, [runSearch]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    searchAbortRef.current?.abort();
  }, []);

  // 설치 완료 전파(설치 목록 새로고침·Installed 탭 전환·토스트)는 잡 소유자인 FindTab이
  // 소유한다. 설치 도중 사용자가 InstallFlow 폼을 접어 언마운트해도, 여기서 status==="done"을
  // 보고 확실히 전파한다(폼 내부 타이머에 의존해 완료가 고아가 되지 않는다).
  useEffect(() => {
    if (installJobLog.status !== "done" || !installTarget) return;
    onInstallSuccess(installTarget.name, installTarget.scope);
    setInstallFormOpenId(null);
    setInstallTarget(null);
  }, [installJobLog.status, installTarget, onInstallSuccess]);

  const installRunningLabel = installTarget
    ? t("skills.status.installingNamed", { name: installTarget.name })
    : t("skills.status.installing");

  return (
    <>
      <div className="skills-tab-body">
        <input
          type="search"
          className="skills-filter-input"
          placeholder={t("skills.filter.searchPlaceholder")}
          value={searchQuery}
          onChange={(e) => handleQueryChange(e.target.value)}
          aria-label={t("skills.filter.searchAria")}
        />

        {searchLoading && <div className="skills-empty-state" role="status" aria-live="polite">{t("skills.empty.searching")}</div>}

        {!searchLoading && searchFailed ? (
          <FailureNotice
            title={t("skills.failure.search.title")}
            cause={t("skills.failure.search.cause")}
            actions={[{ label: t("skills.action.retry"), onSelect: () => runSearch(searchQuery), primary: true }]}
            tone="coral"
          />
        ) : null}

        {!searchLoading && !searchFailed && searchQuery.length >= MIN_QUERY_LEN && searchResults.length === 0 && (
          <div className="skills-empty-state">{t("skills.empty.noResults", { query: searchQuery })}</div>
        )}

        {!searchLoading && searchQuery.length > 0 && searchQuery.length < MIN_QUERY_LEN && (
          <div className="skills-empty-state">{t("skills.empty.minQuery")}</div>
        )}

        <div className="skills-card-list">
          {searchResults.map((result) => (
            <FindResultCard
              key={result.id}
              result={result}
              theaterId={theaterId}
              isFormOpen={installFormOpenId === result.id}
              onInstallClick={() =>
                setInstallFormOpenId(installFormOpenId === result.id ? null : result.id)
              }
              onReadMore={onReadMore}
              onInstallStarted={(name, scope) => setInstallTarget({ name, scope })}
              jobLog={installJobLog}
              t={t}
            />
          ))}
        </div>
      </div>

      <JobStatusDock
        status={installJobLog.status}
        lines={installJobLog.lines}
        runningLabel={installRunningLabel}
        doneLabel={t("skills.status.installed")}
        errorLabel={t("skills.status.installFailed")}
        onDismiss={installJobLog.reset}
        t={t}
      />
    </>
  );
}
