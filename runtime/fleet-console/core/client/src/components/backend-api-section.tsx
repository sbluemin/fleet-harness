import { useEffect, useMemo, useState } from "react";

import { loadApiCatalog, useApiCatalogStore } from "../backend-api-catalog-store.js";
import type { ApiCatalogEntry } from "../types.js";

interface ApiCatalogGroup {
  readonly category: string;
  readonly entries: readonly ApiCatalogEntry[];
}

interface ApiCatalogGroupProps {
  readonly group: ApiCatalogGroup;
}

interface ApiCatalogRowProps {
  readonly entry: ApiCatalogEntry;
}

export function BackendApiSection() {
  const store = useApiCatalogStore();
  const [expanded, setExpanded] = useState(true);
  const groups = useMemo(() => groupApiCatalog(store.state ?? []), [store.state]);
  const count = store.state?.length ?? 0;
  const categoryCount = groups.length;

  useEffect(() => {
    const controller = new AbortController();
    void loadApiCatalog(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <section className="global-settings-card backend-api-section" aria-label="Backend API catalog">
      <div className={`backend-api-control carrier-settings-control-group--taskforce ${expanded ? "is-expanded" : ""}`}>
        <div className="carrier-settings-section-head">
          <div className="backend-api-head">
            <p className="global-settings-resp-title">Backend API</p>
            <p className="global-settings-help">
              {count > 0
                ? `${count} loopback route${count === 1 ? "" : "s"} across ${categoryCount} categor${categoryCount === 1 ? "y" : "ies"} reported by backend introspection.`
                : "Backend introspection route list for this console."}
            </p>
          </div>
          <div className="carrier-settings-tf-head-actions">
            <button
              type="button"
              className="carrier-settings-tf-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Hide" : "Show"}
            </button>
          </div>
        </div>
      </div>

      {store.error ? <p className="global-settings-error" role="alert">{store.error}</p> : null}
      {store.loading && !store.state ? <p className="global-settings-help">Loading backend API catalog.</p> : null}

      {expanded ? (
        <div className="backend-api-groups">
          {groups.length > 0 ? groups.map((group) => <ApiCatalogGroupView key={group.category} group={group} />) : null}
          {store.state && groups.length === 0 ? <p className="global-settings-help">No backend API routes reported.</p> : null}
        </div>
      ) : null}

      <p className="global-settings-foot">Console backend routes are fetched from GET /settings/api-catalog, so newly registered routes appear here automatically. The Codex/Fleet Wiki API surface is not included.</p>
    </section>
  );
}

function ApiCatalogGroupView({ group }: ApiCatalogGroupProps) {
  return (
    <div className="backend-api-group">
      <div className="backend-api-group-head">
        <span>{group.category}</span>
        <span>{group.entries.length}</span>
      </div>
      <div className="backend-api-list">
        {group.entries.map((entry) => <ApiCatalogRow key={`${entry.method}:${entry.path}`} entry={entry} />)}
      </div>
    </div>
  );
}

function ApiCatalogRow({ entry }: ApiCatalogRowProps) {
  return (
    <div className="backend-api-row">
      <span className="backend-api-method">{entry.method.toUpperCase()}</span>
      <code className="backend-api-path">{entry.path}</code>
      <span className="backend-api-summary">{entry.summary}</span>
      <span className="backend-api-gate">{entry.gate}</span>
    </div>
  );
}

function groupApiCatalog(entries: readonly ApiCatalogEntry[]): readonly ApiCatalogGroup[] {
  const groups = new Map<string, ApiCatalogEntry[]>();
  for (const entry of entries) {
    const category = entry.category.trim() || "Uncategorized";
    const group = groups.get(category);
    if (group) {
      group.push(entry);
    } else {
      groups.set(category, [entry]);
    }
  }
  return Array.from(groups.entries()).map(([category, groupEntries]) => ({
    category,
    entries: groupEntries,
  }));
}
