import { useEffect, useMemo, useState } from "react";

import { loadApiCatalog, useApiCatalogStore } from "../backend-api-catalog-store.js";
import { useT, type CoreMessageKey } from "../i18n/index.js";
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
  const t = useT();
  const store = useApiCatalogStore();
  const [expanded, setExpanded] = useState(true);
  const groups = useMemo(() => groupApiCatalog(store.state ?? [], t("chrome.backendApi.uncategorized")), [store.state, t]);
  const count = store.state?.length ?? 0;
  const categoryCount = groups.length;

  useEffect(() => {
    const controller = new AbortController();
    void loadApiCatalog(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <section className="global-settings-card backend-api-section" aria-label={t("chrome.backendApi.sectionAria")}>
      <div className={`backend-api-control settings-disclosure-control ${expanded ? "is-expanded" : ""}`}>
        <div className="settings-disclosure-head">
          <div className="backend-api-head">
            <p className="global-settings-resp-title">{t("chrome.backendApi.title")}</p>
            <p className="global-settings-help">
              {count > 0
                ? t(routeSummaryKey(count, categoryCount), { count, categoryCount })
                : t("chrome.backendApi.emptyHelp")}
            </p>
          </div>
          <div className="settings-disclosure-actions">
            <button
              type="button"
              className="settings-disclosure-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t("chrome.backendApi.hide") : t("chrome.backendApi.show")}
            </button>
          </div>
        </div>
      </div>

      {store.error ? <p className="global-settings-error" role="alert">{store.error}</p> : null}
      {store.loading && !store.state ? <p className="global-settings-help">{t("chrome.backendApi.loading")}</p> : null}

      {expanded ? (
        <div className="backend-api-groups">
          {groups.length > 0 ? groups.map((group) => <ApiCatalogGroupView key={group.category} group={group} />) : null}
          {store.state && groups.length === 0 ? <p className="global-settings-help">{t("chrome.backendApi.noRoutes")}</p> : null}
        </div>
      ) : null}

      <p className="global-settings-foot">{t("chrome.backendApi.foot")}</p>
    </section>
  );
}

function routeSummaryKey(count: number, categoryCount: number): CoreMessageKey {
  const routes = count === 1 ? "one" : "other";
  const categories = categoryCount === 1 ? "one" : "other";
  return `chrome.backendApi.routeSummary_${routes}_${categories}` as CoreMessageKey;
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

function groupApiCatalog(entries: readonly ApiCatalogEntry[], uncategorizedLabel: string): readonly ApiCatalogGroup[] {
  const groups = new Map<string, ApiCatalogEntry[]>();
  for (const entry of entries) {
    const category = entry.category.trim() || uncategorizedLabel;
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
