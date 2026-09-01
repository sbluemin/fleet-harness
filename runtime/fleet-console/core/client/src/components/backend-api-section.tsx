import { useEffect, useId, useMemo, useState } from "react";

import { loadApiCatalog, useApiCatalogStore } from "../backend-api-catalog.js";
import { useT, type CoreMessageKey } from "../i18n/index.js";
import type { ApiCatalogEntry } from "../types.js";

import { SettingsHelp } from "./settings-help.js";

export interface ApiCatalogGroup {
  readonly label: string;
  readonly entries: readonly ApiCatalogEntry[];
}

export interface ApiCatalogHierarchy {
  readonly coreGroups: readonly ApiCatalogGroup[];
  readonly pluginGroups: readonly ApiCatalogGroup[];
}

interface ApiCatalogGroupProps {
  readonly group: ApiCatalogGroup;
}

interface PluginApiCatalogGroupProps extends ApiCatalogGroupProps {
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

interface ApiCatalogRowProps {
  readonly entry: ApiCatalogEntry;
}

export function BackendApiSection() {
  const t = useT();
  const store = useApiCatalogStore();
  const [expanded, setExpanded] = useState(true);
  const hierarchy = useMemo(
    () => groupApiCatalog(store.state ?? [], t("chrome.backendApi.uncategorized")),
    [store.state, t],
  );
  const routeCount = store.state?.length ?? 0;
  const visibleGroupCount = hierarchy.coreGroups.length + hierarchy.pluginGroups.length;

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
            <p className="global-settings-resp-title">
              {t("chrome.backendApi.title")}
              <SettingsHelp title={t("chrome.backendApi.title")}>{t("chrome.backendApi.foot")}</SettingsHelp>
            </p>
            {/* 라우트·그룹 수는 설명이 아니라 카탈로그의 현재 값이다 — 읽어 낸 데이터는 인라인에 남는다. */}
            <p className="global-settings-help">
              {routeCount > 0
                ? t(routeSummaryKey(routeCount, visibleGroupCount), { count: routeCount, groupCount: visibleGroupCount })
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
          {hierarchy.coreGroups.length > 0 ? (
            <section className="backend-api-hierarchy-section" aria-labelledby="backend-api-core-heading">
              <h3 id="backend-api-core-heading" className="backend-api-section-heading">{t("chrome.backendApi.core")}</h3>
              <CoreApiCatalogGroups groups={hierarchy.coreGroups} />
            </section>
          ) : null}
          {hierarchy.pluginGroups.length > 0 ? (
            <section className="backend-api-hierarchy-section" aria-labelledby="backend-api-plugins-heading">
              <h3 id="backend-api-plugins-heading" className="backend-api-section-heading">{t("chrome.backendApi.plugins")}</h3>
              <PluginApiCatalogGroups groups={hierarchy.pluginGroups} />
            </section>
          ) : null}
          {store.state && visibleGroupCount === 0 ? <p className="global-settings-help">{t("chrome.backendApi.noRoutes")}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function routeSummaryKey(routeCount: number, groupCount: number): CoreMessageKey {
  const routes = routeCount === 1 ? "one" : "other";
  const groups = groupCount === 1 ? "one" : "other";
  return `chrome.backendApi.routeSummary_${routes}_${groups}` as CoreMessageKey;
}

export function CoreApiCatalogGroups({ groups }: { readonly groups: readonly ApiCatalogGroup[] }) {
  const [expandedGroups, toggleGroup] = useExpandedApiCatalogGroups(groups);

  return (
    <div className="backend-api-section-groups backend-api-core-groups">
      {groups.map((group) => (
        <CoreApiCatalogGroup
          key={group.label}
          group={group}
          expanded={expandedGroups[group.label] ?? true}
          onToggle={() => toggleGroup(group.label)}
        />
      ))}
    </div>
  );
}

export function PluginApiCatalogGroups({ groups }: { readonly groups: readonly ApiCatalogGroup[] }) {
  const [expandedGroups, toggleGroup] = useExpandedApiCatalogGroups(groups);

  return (
    <div className="backend-api-section-groups backend-api-plugin-groups">
      {groups.map((group) => (
        <PluginApiCatalogGroup
          key={group.label}
          group={group}
          expanded={expandedGroups[group.label] ?? true}
          onToggle={() => toggleGroup(group.label)}
        />
      ))}
    </div>
  );
}

function useExpandedApiCatalogGroups(
  groups: readonly ApiCatalogGroup[],
): readonly [Readonly<Record<string, boolean>>, (label: string) => void] {
  const [expandedGroups, setExpandedGroups] = useState<Readonly<Record<string, boolean>>>({});

  useEffect(() => {
    setExpandedGroups((current) => {
      const freshLabels = groups.filter((group) => current[group.label] === undefined);
      if (freshLabels.length === 0) return current;
      return Object.fromEntries([
        ...Object.entries(current),
        ...freshLabels.map((group) => [group.label, true] as const),
      ]);
    });
  }, [groups]);

  return [expandedGroups, (label: string) => setExpandedGroups((current) => ({
    ...current,
    [label]: !(current[label] ?? true),
  }))];
}

function CoreApiCatalogGroup({ group, expanded, onToggle }: PluginApiCatalogGroupProps) {
  const t = useT();
  const listId = useId();

  return (
    <div className={`backend-api-group backend-api-core-group ${expanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        className="backend-api-core-toggle"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={onToggle}
      >
        <span className="backend-api-core-label">{group.label}</span>
        <span className="backend-api-core-meta">
          <span className="backend-api-core-count">{group.entries.length}</span>
          <span>{expanded ? t("chrome.backendApi.coreHide") : t("chrome.backendApi.coreShow")}</span>
        </span>
      </button>
      {expanded ? <ApiCatalogList id={listId} entries={group.entries} /> : null}
    </div>
  );
}

function PluginApiCatalogGroup({ group, expanded, onToggle }: PluginApiCatalogGroupProps) {
  const t = useT();
  const listId = useId();

  return (
    <div className={`backend-api-group backend-api-plugin-group ${expanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        className="backend-api-plugin-toggle"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={onToggle}
      >
        <span className="backend-api-plugin-label">{group.label}</span>
        <span className="backend-api-plugin-meta">
          <span className="backend-api-plugin-count">{group.entries.length}</span>
          <span>{expanded ? t("chrome.backendApi.pluginHide") : t("chrome.backendApi.pluginShow")}</span>
        </span>
      </button>
      {expanded ? <ApiCatalogList id={listId} entries={group.entries} /> : null}
    </div>
  );
}

function ApiCatalogList({ id, entries }: { readonly id?: string; readonly entries: readonly ApiCatalogEntry[] }) {
  return (
    <div id={id} className="backend-api-list">
      {entries.map((entry) => <ApiCatalogRow key={`${entry.method}:${entry.path}:${entry.transport}`} entry={entry} />)}
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
      <span className="backend-api-transport">{entry.transport}</span>
    </div>
  );
}

export function groupApiCatalog(entries: readonly ApiCatalogEntry[], uncategorizedLabel: string): ApiCatalogHierarchy {
  const coreGroups = new Map<string, ApiCatalogEntry[]>();
  const pluginGroups = new Map<string, ApiCatalogEntry[]>();

  for (const entry of entries) {
    const pluginId = pluginIdFromPath(entry.path);
    const groups = pluginId === null ? coreGroups : pluginGroups;
    const label = pluginId ?? (entry.category.trim() || uncategorizedLabel);
    const group = groups.get(label);
    if (group) {
      group.push(entry);
    } else {
      groups.set(label, [entry]);
    }
  }

  return {
    coreGroups: toApiCatalogGroups(coreGroups),
    pluginGroups: toApiCatalogGroups(pluginGroups),
  };
}

export function pluginIdFromPath(path: string): string | null {
  return path.match(/^\/plugins\/([^/]+)(?:\/|$)/)?.[1]
    ?? path.match(/^\/api\/v1\/plugins\/([^/]+)(?:\/|$)/)?.[1]
    ?? null;
}

function toApiCatalogGroups(groups: ReadonlyMap<string, ApiCatalogEntry[]>): readonly ApiCatalogGroup[] {
  return Array.from(groups.entries()).map(([label, entries]) => ({ label, entries }));
}
