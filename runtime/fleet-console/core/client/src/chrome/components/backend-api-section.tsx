import { useEffect, useId, useMemo, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import { loadApiCatalog, useApiCatalogStore } from "../../integration/backend-api-catalog.js";
import { useT, type CoreMessageKey } from "../../i18n/index.js";
import type { ApiCatalogEntry } from "../../integration/types.js";

import { SettingsHelp } from "./settings-help.js";

/**
 * 카탈로그는 선언된 라우트가 늘수록 길어지기만 했다 — 190개를 모두 펼친 채 열려 14화면을
 * 만들고, 그 안에서 경로 하나를 찾을 수단이 없었다. 그래서 이 표면은 두 상태만 갖는다.
 *
 * - **찾지 않을 때**는 그룹 색인이다. 그룹 줄만 서고, 필요한 그룹만 펼친다.
 * - **찾을 때**는 결과 목록이다. 경로·설명·게이트·그룹을 훑어 맞은 것만 남긴다.
 *
 * 게이트와 전송은 기본값이 압도적이라(origin-write 63%, http 93%) 열로 세우면 같은 글자가
 * 세로로 반복되며 정작 예외를 덮는다. 기본값은 침묵하고 예외만 행 끝에서 말한다.
 */
export interface ApiCatalogGroup {
  readonly label: string;
  readonly entries: readonly ApiCatalogEntry[];
}

export interface ApiCatalogHierarchy {
  readonly coreGroups: readonly ApiCatalogGroup[];
  readonly pluginGroups: readonly ApiCatalogGroup[];
}

/** 표식 없는 행이 뜻하는 값. 이 둘만 침묵하고 나머지 게이트·전송은 행에 나타난다. */
const SILENT_GATE: ApiCatalogEntry["gate"] = "origin-write";
const SILENT_TRANSPORT: ApiCatalogEntry["transport"] = "http";

const METHOD_FACETS: readonly ApiCatalogEntry["method"][] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

type FacetKey = `method:${string}` | `gate:${string}` | `transport:${string}`;

export function BackendApiSection() {
  const t = useT();
  const store = useApiCatalogStore();
  const [query, setQuery] = useState("");
  const [facets, setFacets] = useState<ReadonlySet<FacetKey>>(() => new Set());
  const entries = store.state ?? [];

  const hierarchy = useMemo(
    () => groupApiCatalog(entries, t("chrome.backendApi.uncategorized")),
    [entries, t],
  );
  const available = useMemo(() => availableFacets(entries), [entries]);
  const trimmed = query.trim();
  const filtering = trimmed !== "" || facets.size > 0;
  const matches = useMemo(
    () => (filtering ? filterApiCatalog(entries, trimmed, facets) : []),
    [entries, trimmed, facets, filtering],
  );

  const routeCount = entries.length;
  const visibleGroupCount = hierarchy.coreGroups.length + hierarchy.pluginGroups.length;

  useEffect(() => {
    const controller = new AbortController();
    void loadApiCatalog(controller.signal);
    return () => controller.abort();
  }, []);

  const toggleFacet = (facet: FacetKey) => {
    setFacets((current) => {
      const next = new Set(current);
      if (!next.delete(facet)) next.add(facet);
      return next;
    });
  };

  return (
    <section className="global-settings-card backend-api-section" aria-label={t("chrome.backendApi.sectionAria")}>
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

      <div className="settings-search backend-api-search">
        <SearchIcon />
        <input
          type="search"
          value={query}
          placeholder={t("chrome.backendApi.findPlaceholder")}
          aria-label={t("chrome.backendApi.findAria")}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {available.length > 0 ? (
        <div className="backend-api-facets" role="group" aria-label={t("chrome.backendApi.facetsAria")}>
          {available.map((facet) => (
            <button
              key={facet}
              type="button"
              className={`settings-chip backend-api-facet ${facets.has(facet) ? "is-active" : ""}`}
              aria-pressed={facets.has(facet)}
              onClick={() => toggleFacet(facet)}
            >
              {facetLabel(facet)}
            </button>
          ))}
        </div>
      ) : null}

      {store.error ? <p className="global-settings-error" role="alert">{store.error}</p> : null}
      {store.loading && !store.state ? <p className="global-settings-help">{t("chrome.backendApi.loading")}</p> : null}

      {filtering
        ? <ApiCatalogResults entries={matches} total={routeCount} query={trimmed} t={t} />
        : (
          <>
            {hierarchy.coreGroups.length > 0 ? (
              <ApiCatalogIndex heading={t("chrome.backendApi.core")} groups={hierarchy.coreGroups} />
            ) : null}
            {hierarchy.pluginGroups.length > 0 ? (
              <ApiCatalogIndex heading={t("chrome.backendApi.plugins")} groups={hierarchy.pluginGroups} />
            ) : null}
            {store.state && visibleGroupCount === 0 ? <p className="global-settings-help">{t("chrome.backendApi.noRoutes")}</p> : null}
          </>
        )}

      {routeCount > 0 ? <p className="backend-api-legend">{t("chrome.backendApi.legend")}</p> : null}
    </section>
  );
}

function routeSummaryKey(routeCount: number, groupCount: number): CoreMessageKey {
  const routes = routeCount === 1 ? "one" : "other";
  const groups = groupCount === 1 ? "one" : "other";
  return `chrome.backendApi.routeSummary_${routes}_${groups}` as CoreMessageKey;
}

/**
 * 그룹 색인. 접힘이 기본이고, 펼친 그룹만 자기 라우트를 그린다 — 열지 않은 그룹의 행은
 * DOM에도 없다. 카탈로그가 두 배가 되어도 첫 화면은 그룹 줄 수만큼만 길어진다.
 */
export function ApiCatalogIndex({ heading, groups }: { readonly heading: string; readonly groups: readonly ApiCatalogGroup[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const headingId = useId();

  const toggle = (label: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(label)) next.add(label);
      return next;
    });
  };

  return (
    <section className="backend-api-hierarchy-section" aria-labelledby={headingId}>
      <h3 id={headingId} className="backend-api-section-heading">{heading}</h3>
      <div className="backend-api-index">
        {groups.map((group) => (
          <ApiCatalogIndexGroup
            key={group.label}
            group={group}
            expanded={expanded.has(group.label)}
            onToggle={() => toggle(group.label)}
          />
        ))}
      </div>
    </section>
  );
}

function ApiCatalogIndexGroup({ group, expanded, onToggle }: {
  readonly group: ApiCatalogGroup;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const listId = useId();

  return (
    <div className={`backend-api-group ${expanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        className="backend-api-group-toggle"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={onToggle}
      >
        <span className="backend-api-group-label">{group.label}</span>
        <span className="backend-api-group-prefix">{commonPathPrefix(group.entries)}</span>
        <span className="backend-api-group-count">{group.entries.length}</span>
      </button>
      {expanded ? <ApiCatalogList id={listId} entries={group.entries} /> : null}
    </div>
  );
}

function ApiCatalogResults({ entries, total, query, t }: {
  readonly entries: readonly ApiCatalogEntry[];
  readonly total: number;
  readonly query: string;
  readonly t: Translate<CoreMessageKey>;
}) {
  if (entries.length === 0) {
    return (
      <div className="backend-api-results">
        <p className="global-settings-help" role="status">{t("chrome.backendApi.findEmpty")}</p>
      </div>
    );
  }

  const sections: { readonly label: string; readonly entries: ApiCatalogEntry[] }[] = [];
  for (const entry of entries) {
    const label = pluginIdFromPath(entry.path) ?? (entry.category.trim() || t("chrome.backendApi.uncategorized"));
    const last = sections.at(-1);
    if (last && last.label === label) last.entries.push(entry);
    else sections.push({ label, entries: [entry] });
  }

  return (
    <div className="backend-api-results">
      <p className="global-settings-help" role="status">
        {t(entries.length === 1 ? "chrome.backendApi.findCount_one" : "chrome.backendApi.findCount_other", { count: entries.length, total })}
      </p>
      {sections.map((section, index) => (
        <div key={`${section.label}:${index}`} className="backend-api-result-group">
          <p className="backend-api-result-label">{section.label}</p>
          <ApiCatalogList entries={section.entries} query={query} />
        </div>
      ))}
    </div>
  );
}

function ApiCatalogList({ id, entries, query }: {
  readonly id?: string;
  readonly entries: readonly ApiCatalogEntry[];
  readonly query?: string;
}) {
  return (
    <div id={id} className="backend-api-list">
      {entries.map((entry) => (
        <ApiCatalogRow key={`${entry.method}:${entry.path}:${entry.transport}`} entry={entry} query={query} />
      ))}
    </div>
  );
}

function ApiCatalogRow({ entry, query }: { readonly entry: ApiCatalogEntry; readonly query?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    // 복사 실패는 이 행 안에서만 말한다 — 카탈로그 전체를 에러 화면으로 바꿀 이유가 없다.
    void navigator.clipboard.writeText(entry.path)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className="backend-api-row">
      <span className={`backend-api-method ${entry.method === "GET" ? "is-read" : "is-write"}`}>{entry.method.toUpperCase()}</span>
      <code className="backend-api-path">{highlight(entry.path, query)}</code>
      <span className="backend-api-summary">{entry.summary}</span>
      <span className="backend-api-flags">
        {entry.gate === SILENT_GATE ? null : <span className="backend-api-flag is-gate">{entry.gate}</span>}
        {entry.transport === SILENT_TRANSPORT ? null : <span className="backend-api-flag">{entry.transport}</span>}
      </span>
      <button
        type="button"
        className="backend-api-copy"
        aria-label={t("chrome.backendApi.copyAria", { path: entry.path })}
        onClick={copy}
        onBlur={() => setCopied(false)}
      >
        {copied ? t("chrome.backendApi.copied") : t("chrome.backendApi.copy")}
      </button>
    </div>
  );
}

/** 찾은 글자를 경로 안에서 짚는다. 결과가 왜 남았는지 행 자신이 말해야 한다. */
function highlight(path: string, query?: string) {
  if (!query) return path;
  const index = path.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return path;
  return (
    <>
      {path.slice(0, index)}
      <mark className="backend-api-hit">{path.slice(index, index + query.length)}</mark>
      {path.slice(index + query.length)}
    </>
  );
}

export function filterApiCatalog(
  entries: readonly ApiCatalogEntry[],
  query: string,
  facets: ReadonlySet<string>,
): readonly ApiCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  const selected = (kind: string): ReadonlySet<string> =>
    new Set([...facets].filter((facet) => facet.startsWith(`${kind}:`)).map((facet) => facet.slice(kind.length + 1)));
  const methods = selected("method");
  const gates = selected("gate");
  const transports = selected("transport");

  return entries.filter((entry) => {
    if (methods.size > 0 && !methods.has(entry.method)) return false;
    if (gates.size > 0 && !gates.has(entry.gate)) return false;
    if (transports.size > 0 && !transports.has(entry.transport)) return false;
    if (needle === "") return true;
    return entry.path.toLowerCase().includes(needle)
      || entry.summary.toLowerCase().includes(needle)
      || entry.gate.includes(needle)
      || entry.transport.includes(needle)
      || entry.category.toLowerCase().includes(needle);
  });
}

/**
 * 칩은 카탈로그가 실제로 가진 값만 세운다 — 이 설치에 없는 게이트를 걸러 낼 수 있는 척하면
 * 0건이 제품 상태인지 필터 실수인지 구분되지 않는다. 기본값(origin-write·http)은 다수라
 * 좁히는 데 쓸모가 없으므로 칩으로도 서지 않는다.
 */
export function availableFacets(entries: readonly ApiCatalogEntry[]): readonly FacetKey[] {
  const methods = new Set(entries.map((entry) => entry.method));
  const gates = new Set(entries.map((entry) => entry.gate).filter((gate) => gate !== SILENT_GATE));
  const transports = new Set(entries.map((entry) => entry.transport).filter((transport) => transport !== SILENT_TRANSPORT));
  return [
    ...METHOD_FACETS.filter((method) => methods.has(method)).map((method) => `method:${method}` as FacetKey),
    ...[...gates].sort().map((gate) => `gate:${gate}` as FacetKey),
    ...[...transports].sort().map((transport) => `transport:${transport}` as FacetKey),
  ];
}

function facetLabel(facet: FacetKey): string {
  return facet.slice(facet.indexOf(":") + 1);
}

/** 그룹이 어느 경로 아래 사는지 한 줄로 말한다 — 이름만으로는 열어 봐야 알 수 있었다. */
export function commonPathPrefix(entries: readonly ApiCatalogEntry[]): string {
  const segments = entries.map((entry) => entry.path.split("/").filter((part) => part !== ""));
  const first = segments[0] ?? [];
  let shared = 0;
  while (shared < first.length && segments.every((parts) => parts[shared] === first[shared])) shared += 1;
  if (shared === 0) return "/…";
  return `/${first.slice(0, shared).join("/")}${shared < first.length ? "/…" : ""}`;
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

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
