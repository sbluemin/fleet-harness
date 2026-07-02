import { useCallback, useEffect, useRef } from "react";

import type { SkillListItem, SkillSearchItem } from "../server/types.js";
import {
  setInstallFormOpenId,
  setSearchQuery,
  setSearchState,
  useSkillsStore,
} from "./skills-store.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface FindTabProps {
  readonly theaterId: string | null;
  readonly onReadMore: (skill: SkillListItem) => void;
}

interface FindResultCardProps {
  readonly result: SkillSearchItem;
  readonly theaterId: string | null;
  readonly isFormOpen: boolean;
  readonly onInstallClick: () => void;
  readonly onReadMore: (skill: SkillListItem) => void;
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

async function doSearch(q: string): Promise<void> {
  if (q.length < MIN_QUERY_LEN) { setSearchState([], false); return; }
  setSearchState([], true);
  try {
    const res = await fetch(`/plugins/skills/search?q=${encodeURIComponent(q)}&limit=10`);
    if (!res.ok) { setSearchState([], false); return; }
    const data = await res.json() as { skills: SkillSearchItem[] };
    setSearchState(data.skills ?? [], false);
  } catch {
    setSearchState([], false);
  }
}

// ─── FindResultCard ───────────────────────────────────────────────────────────

function FindResultCard({ result, isFormOpen, onInstallClick, onReadMore }: FindResultCardProps) {
  const previewSkill: SkillListItem = {
    name: result.name,
    scope: "project",
    agents: [],
    source: result.source,
    displayPath: "",
  };

  return (
    <div className={`skills-card skills-card--find${isFormOpen ? " is-expanded" : ""}`}>
      <div className="skills-card-header">
        <button
          type="button"
          className="skills-card-name-btn"
          onClick={() => onReadMore(previewSkill)}
          title="Read SKILL.md preview"
        >
          {result.name}
        </button>
        {result.installs > 0 && (
          <span className="skills-card-installs">{formatInstalls(result.installs)}</span>
        )}
      </div>
      <span className="skills-card-meta">{result.source}</span>
      <div className="skills-card-actions">
        <button
          type="button"
          className="skills-btn skills-btn--primary"
          onClick={onInstallClick}
        >
          {isFormOpen ? "Cancel" : "Install"}
        </button>
      </div>
      {/* InstallFlow renders inside the card in W3 */}
    </div>
  );
}

// ─── FindTab ─────────────────────────────────────────────────────────────────

export function FindTab({ theaterId, onReadMore }: FindTabProps) {
  const { searchQuery, searchResults, searchLoading, installFormOpenId } = useSkillsStore();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleQueryChange = useCallback((q: string) => {
    setSearchQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length < MIN_QUERY_LEN) { setSearchState([], false); return; }
    debounceRef.current = setTimeout(() => { void doSearch(q); }, SEARCH_DEBOUNCE_MS);
  }, []);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  return (
    <div className="skills-tab-body">
      <input
        type="search"
        className="skills-filter-input"
        placeholder="Search skills.sh registry…"
        value={searchQuery}
        onChange={(e) => handleQueryChange(e.target.value)}
        aria-label="Search skills registry"
      />

      {searchLoading && <div className="skills-empty-state">Searching…</div>}

      {!searchLoading && searchQuery.length >= MIN_QUERY_LEN && searchResults.length === 0 && (
        <div className="skills-empty-state">No results for "{searchQuery}".</div>
      )}

      {!searchLoading && searchQuery.length > 0 && searchQuery.length < MIN_QUERY_LEN && (
        <div className="skills-empty-state">Type at least 2 characters to search.</div>
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
          />
        ))}
      </div>
    </div>
  );
}
