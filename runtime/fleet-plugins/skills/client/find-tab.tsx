import { useEffect, useState } from "react";

import { FailureNotice } from "@fleet-console/sdk/components/failure-notice";
import type { Translate } from "@fleet-console/sdk/i18n";

import type { SkillListItem, SkillSearchItem } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";
import { setSearchQuery, setSearchState, useSkillsStore } from "./skills-store.js";

interface FindTabProps {
  readonly onReadMore: (skill: SkillListItem, registryId: string) => void;
  readonly t: Translate<SkillsMessageKey>;
}

export function FindTab({ onReadMore, t }: FindTabProps) {
  const { searchQuery, searchResults, searchLoading } = useSkillsStore();
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const query = searchQuery.trim();

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    setSearchState([], query.length >= 2);
    if (query.length < 2) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/plugins/skills/search?q=${encodeURIComponent(query)}&limit=10`, { signal: controller.signal });
          if (!res.ok) throw new Error("search_failed");
          const data = await res.json() as { skills: SkillSearchItem[] };
          if (!controller.signal.aborted) setSearchState(data.skills ?? [], false);
        } catch {
          if (controller.signal.aborted) return;
          setSearchState([], false);
          setFailed(true);
        }
      })();
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, retryKey]);

  return (
    <div className="skills-tab-body">
      <input type="search" className="skills-filter-input" placeholder={t("skills.filter.searchPlaceholder")}
        value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} aria-label={t("skills.filter.searchAria")} />
      {!query && (
        <div className="skills-search-intro">
          <strong>{t("skills.find.intro")}</strong>
          <p>{t("skills.find.hint")}</p>
          <div className="skills-search-examples" aria-label={t("skills.find.examples")}>
            {["react", "testing", "browser"].map((example) => (
              <button key={example} type="button" className="skills-btn skills-btn--ghost" onClick={() => setSearchQuery(example)}>{example}</button>
            ))}
          </div>
        </div>
      )}
      {query.length === 1 && <div className="skills-empty-state">{t("skills.empty.minQuery")}</div>}
      {searchLoading && <div className="skills-empty-state" role="status">{t("skills.empty.searching")}</div>}
      {failed ? (
        <FailureNotice title={t("skills.failure.search.title")} cause={t("skills.failure.search.cause")}
          actions={[{ label: t("skills.action.retry"), onSelect: () => setRetryKey((key) => key + 1), primary: true }]} tone="coral" />
      ) : !searchLoading && query.length >= 2 && searchResults.length === 0 ? (
        <div className="skills-empty-state">{t("skills.empty.noResults", { query })}</div>
      ) : null}
      <div className="skills-card-list">
        {searchResults.map((result) => (
          <button key={result.id} type="button" className="skills-card skills-card-row"
            onClick={() => onReadMore({ name: result.name, scope: "project", agents: [], source: result.source, displayPath: "" }, result.id)}
            title={t("skills.action.readSkillMdPreview")}>
            <span className="skills-card-header"><span className="skills-card-name">{result.name}</span><span className="skills-card-chevron" aria-hidden="true">›</span></span>
            <span className="skills-card-footer"><span className="skills-card-meta">{result.source}</span>
              {result.installs > 0 && <span className="skills-card-installs">{t("skills.card.installs", { count: result.installs.toLocaleString() })}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
