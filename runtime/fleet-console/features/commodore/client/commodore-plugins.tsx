import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Translate } from "@fleet-console/i18n";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { defineSettingsSection, SettingsGroup, SettingsItem, SettingsToggle } from "../../settings/client/preferences-context.js";
import { openSettingsSurface } from "../../settings/client/settings-door.js";
import { splitPluginId, type MarketplaceErrorCode, type MarketplaceView, type PluginCatalogEntry, type PluginCatalogView, type PluginComponents } from "../shared/contracts/plugins.js";
import { postCommodorePlugins, setCommodorePlugin, useCommodore, useCommodoreEnabled } from "./commodore-state.js";
import { commodoreName } from "./commodore-name.js";
import { getT, type CommodoreMessageKey } from "./i18n/index.js";

type T = Translate<CommodoreMessageKey>;

/**
 * 사령관 플러그인 — Console 설정의 「마켓플레이스」 섹션(등록부, 사령관들이 함께 본다)과 사령관 설정 칸의 「플러그인」 목록·추가
 * 팔레트(사령관마다 고른다). 등록부·카탈로그는 Console 전역 하나라 이 모듈이 한 벌을 쥐고 두 표면이 함께 읽는다. 사령관이 고른
 * 목록은 사령관 상태(`state.plugins`)가 진다 — 설치·제거는 누르는 즉시 저장하고, 적용은 다음 턴(새 세션)부터다.
 */

const MARKETPLACE_SECTION_ID = "marketplaces";
/** 설정 주소 id — 코어가 feature id 를 앞에 붙인다(`pluginSettingsSectionId`). */
const MARKETPLACE_SETTINGS_ADDRESS = `commodore:${MARKETPLACE_SECTION_ID}`;
/** 검색어 없이 마켓플레이스마다 먼저 보이는 수 — 공식 마켓플레이스만 수백 개라 나머지는 검색·거르기로 찾는다. */
const PREVIEW_PER_MARKETPLACE = 6;
/** 검색·거르기 결과의 상한 — 넘으면 검색어를 좁히라고 말한다. */
const MAX_RESULTS = 120;
const SYNC_POLL_MS = 2_000;

/* ── 카탈로그 상태 ─────────────────────────────────────────────────── */

interface CatalogState {
  readonly view: PluginCatalogView | null;
  readonly loading: boolean;
  readonly error: string | null;
}

let catalog: CatalogState = { view: null, loading: false, error: null };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function setCatalog(next: Partial<CatalogState>): void {
  catalog = { ...catalog, ...next };
  for (const listener of listeners) listener();
}
function subscribeCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function usePluginCatalog(): CatalogState {
  return useSyncExternalStore(subscribeCatalog, () => catalog, () => catalog);
}
const codeOf = (error: unknown): string => (error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : "failed");

function loadPluginCatalog(force = false): Promise<void> {
  if (inflight) return inflight;
  if (catalog.view && !force) return Promise.resolve();
  setCatalog({ loading: true });
  inflight = postCommodorePlugins<PluginCatalogView>("/commodore/marketplaces/list", {})
    .then((view) => setCatalog({ view, loading: false, error: null }), (error) => setCatalog({ loading: false, error: codeOf(error) }))
    .finally(() => { inflight = null; });
  return inflight;
}
async function applyCatalog(path: string, body: Record<string, unknown>): Promise<void> {
  setCatalog({ view: await postCommodorePlugins<PluginCatalogView>(path, body), error: null });
}
async function inspectPlugin(pluginId: string): Promise<PluginCatalogEntry> {
  const { plugin } = await postCommodorePlugins<{ readonly plugin: PluginCatalogEntry }>("/commodore/plugins/inspect", { pluginId });
  const view = catalog.view;
  if (view) setCatalog({ view: { ...view, plugins: view.plugins.map((entry) => (entry.id === plugin.id ? plugin : entry)) } });
  return plugin;
}

/** 등록부를 읽고, 받는 중인 마켓플레이스가 있는 동안에는 몇 초마다 다시 읽는다(카탈로그에는 사건 채널이 없다). */
function useLiveCatalog(active: boolean): CatalogState {
  const state = usePluginCatalog();
  const syncing = state.view?.marketplaces.some((marketplace) => marketplace.status === "syncing") ?? false;
  useEffect(() => { if (active) void loadPluginCatalog(); }, [active]);
  useEffect(() => {
    if (!active || !syncing) return;
    const timer = window.setTimeout(() => { void loadPluginCatalog(true); }, SYNC_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [active, syncing, state.view]);
  return state;
}

const ERROR_CODES: ReadonlySet<MarketplaceErrorCode> = new Set<MarketplaceErrorCode>(["invalid_source", "duplicate", "preset_name", "not_found", "auth_failed", "no_manifest", "fetch_failed", "preset_locked", "limit", "disabled", "plugin_not_found", "install_failed", "trust_required", "unavailable"]);
function errorWord(t: T, code: string): string {
  return ERROR_CODES.has(code as MarketplaceErrorCode) ? t(`commodore.plugins.error.${code as MarketplaceErrorCode}`) : t("commodore.plugins.error.unknown", { code });
}

const COMPONENT_KEYS: readonly (readonly [keyof PluginComponents, CommodoreMessageKey])[] = [
  ["skills", "commodore.plugins.comp.skills"],
  ["agents", "commodore.plugins.comp.agents"],
  ["commands", "commodore.plugins.comp.commands"],
  ["hooks", "commodore.plugins.comp.hooks"],
  ["mcp", "commodore.plugins.comp.mcp"],
];

/** 구성 요소 칩 — 무엇이 실리는지 설치 전에 공개한다. 받기 전이라 모르면 아무것도 세우지 않는다. */
function Components({ t, components }: { readonly t: T; readonly components: PluginComponents | undefined }) {
  if (!components) return null;
  const parts = COMPONENT_KEYS.filter(([key]) => components[key] > 0);
  if (!parts.length) return null;
  return <>{parts.map(([key, label]) => <span key={key} className="commodore-plugins-comp">{t(label, { n: components[key] })}</span>)}</>;
}

/* ── Console 설정 「마켓플레이스」 ─────────────────────────────────────── */

export const commodoreMarketplaceSettingsSection = defineSettingsSection({
  id: MARKETPLACE_SECTION_ID,
  title: (locale) => getT(locale)("commodore.marketplaces.title"),
  group: "work",
  keywords: [(locale) => getT(locale)("commodore.marketplaces.keywords"), "marketplace plugin catalog anthropic github git ssh"],
  render: () => <MarketplaceSettings />,
});

function MarketplaceSettings() {
  const t = getT(useConsoleLocale());
  const enabled = useCommodoreEnabled();
  const { view, loading, error } = useLiveCatalog(enabled);
  const [failure, setFailure] = useState<string | null>(null);
  if (!enabled) return <p className="global-settings-help">{t("commodore.marketplaces.disabled")}</p>;
  if (!view) {
    return error ? <p className="global-settings-error" role="alert">{errorWord(t, error)}</p>
      : <p className="global-settings-help" role="status">{loading ? t("commodore.marketplaces.loading") : ""}</p>;
  }
  const act = (work: () => Promise<void>) => { setFailure(null); void work().catch((reason) => setFailure(errorWord(t, codeOf(reason)))); };
  const presets = view.marketplaces.filter((marketplace) => marketplace.preset);
  const customs = view.marketplaces.filter((marketplace) => !marketplace.preset);
  const anySyncing = view.marketplaces.some((marketplace) => marketplace.status === "syncing");
  return (
    <div className="commodore-marketplaces">
      {failure ? <p className="global-settings-error" role="alert">{failure}</p> : null}
      <SettingsGroup
        ariaLabel={t("commodore.marketplaces.presets")}
        title={<span className="commodore-marketplaces-head">{t("commodore.marketplaces.presets")}<button type="button" className="commodore-plugins-text" disabled={anySyncing} onClick={() => act(() => applyCatalog("/commodore/marketplaces/update", {}))}>{t("commodore.marketplaces.updateAll")}</button></span>}
        note={t("commodore.marketplaces.presetsNote")}
      >
        {presets.map((marketplace) => <MarketplaceRow key={marketplace.name} t={t} marketplace={marketplace} act={act} />)}
      </SettingsGroup>
      <SettingsGroup ariaLabel={t("commodore.marketplaces.custom")} title={t("commodore.marketplaces.custom")}>
        {customs.length ? customs.map((marketplace) => <MarketplaceRow key={marketplace.name} t={t} marketplace={marketplace} act={act} />)
          : <p className="global-settings-help">{t("commodore.marketplaces.customEmpty")}</p>}
        <MarketplaceAdd t={t} />
      </SettingsGroup>
      <p className="global-settings-help">{t("commodore.marketplaces.note")}</p>
    </div>
  );
}

function updatedWord(at: number): string {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString([], { ...(sameDay ? {} : { month: "short", day: "numeric" }), hour: "2-digit", minute: "2-digit", hour12: false });
}

function MarketplaceRow({ t, marketplace, act }: { readonly t: T; readonly marketplace: MarketplaceView; readonly act: (work: () => Promise<void>) => void }) {
  const [confirming, setConfirming] = useState(false);
  const syncing = marketplace.status === "syncing";
  const status = syncing ? <span className="commodore-plugins-state is-syncing">{t("commodore.marketplaces.syncing")}</span>
    : marketplace.status === "failed" ? <span className="commodore-plugins-state is-failed">{t("commodore.marketplaces.failed", { reason: errorWord(t, marketplace.error ?? "fetch_failed") })}</span>
      : !marketplace.enabled ? <span className="commodore-plugins-state">{t("commodore.marketplaces.off")}</span>
        : marketplace.updatedAt ? <span>{t("commodore.marketplaces.updatedAt", { time: updatedWord(marketplace.updatedAt) })}</span> : null;
  const hint = (
    <span className="commodore-marketplaces-meta">
      <span className="commodore-plugins-locator">{marketplace.locator}{marketplace.ref ? ` @${marketplace.ref}` : ""}</span>
      <span>{t("commodore.marketplaces.count", { n: marketplace.pluginCount })}{status ? <> · {status}</> : null}</span>
      {confirming ? (
        <span className="commodore-marketplaces-confirm" role="alert">
          <span>{t("commodore.marketplaces.removeConfirm", { name: marketplace.name })}</span>
          <button type="button" className="commodore-plugins-text" onClick={() => setConfirming(false)}>{t("commodore.marketplaces.removeCancel")}</button>
          <button type="button" className="commodore-plugins-text is-danger" onClick={() => { setConfirming(false); act(() => applyCatalog("/commodore/marketplaces/remove", { name: marketplace.name })); }}>{t("commodore.marketplaces.remove")}</button>
        </span>
      ) : null}
    </span>
  );
  return (
    <SettingsItem
      label={marketplace.name}
      badge={marketplace.preset ? <span className="commodore-marketplaces-by">{t("commodore.marketplaces.by")}</span> : undefined}
      hint={hint}
    >
      <span className="commodore-marketplaces-actions">
        <button type="button" className="commodore-plugins-text" disabled={syncing} aria-label={t("commodore.marketplaces.updateAria", { name: marketplace.name })} onClick={() => act(() => applyCatalog("/commodore/marketplaces/update", { name: marketplace.name }))}>{t("commodore.marketplaces.update")}</button>
        {marketplace.preset ? null : <button type="button" className="commodore-plugins-text" aria-label={t("commodore.marketplaces.removeAria", { name: marketplace.name })} onClick={() => setConfirming(true)}>{t("commodore.marketplaces.remove")}</button>}
        <SettingsToggle checked={marketplace.enabled} ariaLabel={t("commodore.marketplaces.enableAria", { name: marketplace.name })} onChange={(next) => act(() => applyCatalog("/commodore/marketplaces/enable", { name: marketplace.name, enabled: next }))} />
      </span>
    </SettingsItem>
  );
}

/** 출처 표기를 알아본다 — 안내 한 줄용이다. 받을 수 있는지는 서버가 정한다(`invalid_source`). */
function sourceKind(value: string): { readonly key: CommodoreMessageKey; readonly ref: boolean } | "bad" | null {
  const source = value.trim();
  if (!source) return null;
  if (/^(?:git@[\w.-]+:|ssh:\/\/)\S+$/.test(source)) return { key: "commodore.marketplaces.kind.ssh", ref: true };
  if (/^https?:\/\/\S+\.json(?:\?\S*)?$/.test(source)) return { key: "commodore.marketplaces.kind.url", ref: false };
  if (/^https?:\/\/[\w.-]+\/\S+$/.test(source)) return { key: "commodore.marketplaces.kind.https", ref: true };
  if (/^[\w.-]+\/[\w.-]+(?:@[\w./-]+)?$/.test(source)) return { key: "commodore.marketplaces.kind.github", ref: true };
  return "bad";
}

function MarketplaceAdd({ t }: { readonly t: T }) {
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [state, setState] = useState<{ readonly kind: "idle" } | { readonly kind: "adding" } | { readonly kind: "failed"; readonly code: string } | { readonly kind: "done"; readonly name: string }>({ kind: "idle" });
  const hintId = useId();
  const kind = sourceKind(source);
  const adding = state.kind === "adding";
  const takesRef = kind !== null && kind !== "bad" && kind.ref;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (adding || kind === null || kind === "bad") return;
    setState({ kind: "adding" });
    const body = { source: source.trim(), ...(takesRef && ref.trim() ? { ref: ref.trim() } : {}) };
    void postCommodorePlugins<{ readonly marketplace: MarketplaceView }>("/commodore/marketplaces/add", body).then(({ marketplace }) => {
      setSource(""); setRef("");
      setState({ kind: "done", name: marketplace.name });
      void loadPluginCatalog(true);
    }, (error) => setState({ kind: "failed", code: codeOf(error) }));
  };
  const line = adding ? <span className="commodore-plugins-state is-syncing" role="status">{t("commodore.marketplaces.add.adding")}</span>
    : state.kind === "failed" ? <span className="commodore-plugins-state is-failed" role="alert">{errorWord(t, state.code)}</span>
      : state.kind === "done" ? <span className="commodore-plugins-state is-done" role="status">{t("commodore.marketplaces.add.done", { name: state.name })}</span>
        : kind === "bad" ? <span className="commodore-plugins-state is-failed">{t("commodore.marketplaces.kind.bad")}</span>
          : kind ? <span>{t("commodore.marketplaces.kind.detected", { kind: t(kind.key) })}</span> : null;
  return (
    <form className="commodore-marketplaces-add" onSubmit={submit} noValidate>
      <div className="commodore-marketplaces-add-line">
        <span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span>
        <input
          className="commodore-plugins-field"
          value={source}
          placeholder={t("commodore.marketplaces.add.source")}
          aria-label={t("commodore.marketplaces.add.sourceAria")}
          aria-describedby={line ? hintId : undefined}
          readOnly={adding}
          autoComplete="off"
          spellCheck={false}
          maxLength={512}
          onChange={(event) => { setSource(event.target.value); if (state.kind !== "adding") setState({ kind: "idle" }); }}
        />
        <input
          className="commodore-plugins-field is-ref"
          value={ref}
          placeholder={t("commodore.marketplaces.add.ref")}
          aria-label={t("commodore.marketplaces.add.refAria")}
          disabled={adding || (kind !== null && !takesRef)}
          autoComplete="off"
          spellCheck={false}
          maxLength={128}
          onChange={(event) => setRef(event.target.value)}
        />
        <button type="submit" className="fc-btn fc-btn--secondary" disabled={adding || kind === null || kind === "bad"}>{t("commodore.marketplaces.add.submit")}</button>
      </div>
      {line ? <p id={hintId} className="commodore-marketplaces-add-hint">{line}</p> : null}
    </form>
  );
}

/* ── 사령관 설정 「플러그인」 ───────────────────────────────────────────── */

/**
 * 사령관 설정 칸에서 Theater 목록 바로 아래 — 이 사령관이 고른 플러그인. 「제거」는 바로 저장하고, 적용은 다음 턴부터라
 * 칸 아래 한 줄이 그 시점을 말한다. 데스크톱은 Theater 목록과 같은 줄 문법, 폰은 폰 묶음 문법이다.
 */
export function CommodorePlugins({ t, commodoreId, phone = false }: { readonly t: T; readonly commodoreId: string; readonly phone?: boolean }) {
  const { view } = useCommodore(commodoreId);
  const { view: catalogView } = useLiveCatalog(Boolean(commodoreId));
  const [palette, setPalette] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  if (!commodoreId || !view) return null;
  const installed = view.state.plugins ?? [];
  const entries = new Map(catalogView?.plugins.map((entry) => [entry.id, entry]) ?? []);
  const marketplaces = new Map(catalogView?.marketplaces.map((marketplace) => [marketplace.name, marketplace]) ?? []);
  const remove = (pluginId: string) => {
    if (busy) return;
    setBusy(pluginId); setFailure(null);
    void setCommodorePlugin(commodoreId, pluginId, false).catch((error) => setFailure(errorWord(t, codeOf(error)))).finally(() => setBusy(null));
  };
  const close = () => { setPalette(false); addRef.current?.focus({ preventScroll: true }); };
  const note = installed.length === 0 ? t("commodore.plugins.empty") : t("commodore.plugins.applies");
  const rows = installed.map((pluginId) => {
    const { plugin, marketplace } = splitPluginId(pluginId);
    const entry = entries.get(pluginId);
    const source = marketplaces.get(marketplace);
    const mark = catalogView && !source?.enabled ? <span className="commodore-plugins-state is-warn">{t("commodore.plugins.marketplaceOff")}</span>
      : catalogView && !entry ? <span className="commodore-plugins-state">{t("commodore.plugins.notListed")}</span> : null;
    return { pluginId, plugin, marketplace, entry, mark };
  });
  const manage = <button type="button" className="commodore-plugins-text" onClick={() => openSettingsSurface(MARKETPLACE_SETTINGS_ADDRESS)}>{t("commodore.plugins.manage")}</button>;
  const failureLine = failure ? <p className={phone ? "objectives-cm-note" : "objectives-commodore-hint is-error"} role="alert">{failure}</p> : null;
  const dialog = palette ? <PluginPalette t={t} commodoreId={commodoreId} installed={installed} onClose={close} /> : null;

  if (phone) {
    return (
      <section className="commodore-plugins is-phone" aria-label={t("commodore.plugins.title")}>
        <p className="objectives-cm-glab">{t("commodore.plugins.title")}</p>
        <div className="objectives-cm-grp">
          {rows.map(({ pluginId, plugin, marketplace, entry, mark }) => (
            <div key={pluginId} className="objectives-cm-gr">
              <span className="objectives-cm-gr-tx">{plugin}<small className="is-mono">@{marketplace}</small>{mark || entry?.components ? <small className="commodore-plugins-meta">{mark}<Components t={t} components={entry?.components} /></small> : null}</span>
              <button type="button" data-press="r1" className="objectives-cm-tbtn" aria-label={t("commodore.plugins.removeAria", { plugin })} disabled={busy !== null} onClick={() => remove(pluginId)}>{t("commodore.plugins.remove")}</button>
            </div>
          ))}
          <button ref={addRef} type="button" data-press="r1" className="objectives-cm-gr commodore-theaters-phone-add" onClick={() => setPalette(true)}>
            <span className="objectives-cm-intel-plus" aria-hidden="true">+</span>
            <span className="objectives-cm-gr-tx">{t("commodore.plugins.add")}</span>
          </button>
        </div>
        {failureLine}
        <p className="objectives-cm-secnote">{note}</p>
        {dialog}
      </section>
    );
  }

  return (
    <section className="objectives-commodore-section commodore-plugins" aria-label={t("commodore.plugins.title")}>
      <p className="objectives-commodore-section-title commodore-plugins-head"><span>{t("commodore.plugins.title")}</span>{manage}</p>
      {rows.length ? (
        <ul className="commodore-plugins-list">
          {rows.map(({ pluginId, plugin, marketplace, entry, mark }) => (
            <li key={pluginId}>
              <span className="commodore-plugins-name" title={pluginId}>{plugin}<span className="commodore-plugins-at">@{marketplace}</span></span>
              <button type="button" className="objectives-commodore-text-button" aria-label={t("commodore.plugins.removeAria", { plugin })} disabled={busy !== null} onClick={() => remove(pluginId)}>{t("commodore.plugins.remove")}</button>
              {mark || entry?.components ? <span className="commodore-plugins-meta">{mark}<Components t={t} components={entry?.components} /></span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <button ref={addRef} type="button" className="commodore-theaters-add" onClick={() => setPalette(true)}>
        <span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span>
        <span>{t("commodore.plugins.add")}</span>
      </button>
      {failureLine}
      <p className="objectives-commodore-hint">{note}</p>
      {dialog}
    </section>
  );
}

/* ── 추가 팔레트 ──────────────────────────────────────────────────────── */

interface RowState {
  readonly pluginId: string;
  readonly phase: "checking" | "trust" | "saving" | "failed";
  readonly entry?: PluginCatalogEntry;
  readonly code?: string;
}

/**
 * 「+ 플러그인 추가」 — 검색칸이 먼저 포커스를 받는 팔레트. 켜진 마켓플레이스의 플러그인을 마켓플레이스별로 묶고, 검색어가 없으면
 * 마켓플레이스마다 앞 몇 개만 세운다. 설치는 inspect 로 구성 요소·실행 명령을 받은 뒤, 실행 명령이 있으면 그 원문을 보여 주고
 * 사람이 확인해야 `trusted` 로 저장한다. Esc·바깥 누름은 팔레트만 닫는다(뒤의 시트·패널은 그대로).
 */
function PluginPalette({ t, commodoreId, installed, onClose }: { readonly t: T; readonly commodoreId: string; readonly installed: readonly string[]; readonly onClose: () => void }) {
  const { view, error } = usePluginCatalog();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string | null>(null);
  const [row, setRow] = useState<RowState | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const name = commodoreName(commodoreId, t);
  useEffect(() => { searchRef.current?.focus(); }, []);
  const enabled = useMemo(() => view?.marketplaces.filter((marketplace) => marketplace.enabled) ?? [], [view]);
  const hidden = (view?.marketplaces.length ?? 0) - enabled.length;
  const total = enabled.reduce((sum, marketplace) => sum + marketplace.pluginCount, 0);
  const installedSet = new Set(installed);
  const needle = query.trim().toLowerCase();
  const matches = (entry: PluginCatalogEntry) => !needle || entry.name.toLowerCase().includes(needle) || (entry.description?.toLowerCase().includes(needle) ?? false) || entry.marketplace.toLowerCase().includes(needle);
  const pool = (view?.plugins ?? []).filter((entry) => (filter === null || entry.marketplace === filter) && matches(entry));
  const browsing = !needle && filter === null;
  const shown = browsing ? pool : pool.slice(0, MAX_RESULTS);
  const groups = enabled.map((marketplace) => {
    const all = shown.filter((entry) => entry.marketplace === marketplace.name);
    return { marketplace, items: browsing ? all.slice(0, PREVIEW_PER_MARKETPLACE) : all, rest: browsing ? Math.max(0, marketplace.pluginCount - Math.min(all.length, PREVIEW_PER_MARKETPLACE)) : 0 };
  }).filter((group) => group.items.length > 0);

  const save = (pluginId: string, trusted: boolean, entry?: PluginCatalogEntry) => {
    setRow({ pluginId, phase: "saving", ...(entry ? { entry } : {}) });
    void setCommodorePlugin(commodoreId, pluginId, true, trusted).then(() => setRow(null), (reason) => {
      const code = codeOf(reason);
      // 서버가 신뢰 확인을 요구하면(받은 뒤 실행 명령이 생겼다) 원문을 다시 받아 확인 칸을 세운다.
      if (code === "trust_required") { void inspectPlugin(pluginId).then((fresh) => setRow({ pluginId, phase: "trust", entry: fresh }), (again) => setRow({ pluginId, phase: "failed", code: codeOf(again) })); return; }
      setRow({ pluginId, phase: "failed", code, ...(entry ? { entry } : {}) });
    });
  };
  const install = (entry: PluginCatalogEntry) => {
    if (row && (row.phase === "checking" || row.phase === "saving")) return;
    setRow({ pluginId: entry.id, phase: "checking" });
    void inspectPlugin(entry.id).then((fresh) => {
      if (fresh.runs?.length) setRow({ pluginId: entry.id, phase: "trust", entry: fresh });
      else save(entry.id, false, fresh);
    }, (reason) => setRow({ pluginId: entry.id, phase: "failed", code: codeOf(reason) }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (row?.phase === "trust") { setRow(null); return; }
    onClose();
  };

  const body = !view ? <p className="commodore-plugins-empty" role={error ? "alert" : "status"}>{error ? errorWord(t, error) : t("commodore.plugins.loading")}</p>
    : enabled.length === 0 ? <p className="commodore-plugins-empty">{t("commodore.plugins.palette.none")}</p>
      : groups.length === 0 ? <p className="commodore-plugins-empty">{t("commodore.plugins.palette.empty", { query: query.trim() })}</p>
        : groups.map(({ marketplace, items, rest }) => (
          <section key={marketplace.name} className="commodore-palette-group" aria-label={marketplace.name}>
            <p className="commodore-palette-group-head">
              <span>{marketplace.name}</span>
              {marketplace.preset ? <span>{t("commodore.marketplaces.by")}</span> : <span className="commodore-plugins-locator">{marketplace.locator}</span>}
              <span>{browsing ? t("commodore.marketplaces.count", { n: marketplace.pluginCount }) : t("commodore.plugins.palette.found", { n: items.length })}</span>
            </p>
            {items.map((entry) => <PaletteRow key={entry.id} t={t} entry={entry} installed={installedSet.has(entry.id)} row={row?.pluginId === entry.id ? row : null} onInstall={() => install(entry)} onTrust={(fresh) => save(entry.id, true, fresh)} onCancel={() => setRow(null)} />)}
            {rest > 0 ? <p className="commodore-palette-more">{t("commodore.plugins.palette.more", { n: rest, marketplace: marketplace.name })}</p> : null}
          </section>
        ));

  return createPortal(
    <div className="commodore-palette-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="commodore-palette" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <h2 id={titleId} className="commodore-palette-title">{t("commodore.plugins.palette.title", { name })}</h2>
        <div className="commodore-palette-search">
          <SearchGlyph />
          <input
            ref={searchRef}
            type="search"
            className="commodore-palette-input"
            value={query}
            placeholder={t("commodore.plugins.palette.search", { n: total })}
            aria-label={t("commodore.plugins.palette.searchAria")}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="commodore-plugins-text" onClick={onClose}>{t("commodore.plugins.palette.close")}</button>
        </div>
        {enabled.length > 0 ? (
          <div className="commodore-palette-filters" role="group" aria-label={t("commodore.plugins.palette.filterAria")}>
            <button type="button" className="commodore-palette-chip" aria-pressed={filter === null} onClick={() => setFilter(null)}>{t("commodore.plugins.palette.all")} <span>{total}</span></button>
            {enabled.map((marketplace) => <button key={marketplace.name} type="button" className="commodore-palette-chip" aria-pressed={filter === marketplace.name} onClick={() => setFilter(marketplace.name)}>{marketplace.name} <span>{marketplace.pluginCount}</span></button>)}
          </div>
        ) : null}
        <div className="commodore-palette-list">{body}</div>
        <div className="commodore-palette-foot">
          <span>{!browsing && pool.length > shown.length ? t("commodore.plugins.palette.truncated", { shown: shown.length, n: pool.length }) : hidden > 0 ? t("commodore.plugins.palette.hidden", { n: hidden }) : ""}</span>
          <button type="button" className="commodore-plugins-text" onClick={() => { onClose(); openSettingsSurface(MARKETPLACE_SETTINGS_ADDRESS); }}>{t("commodore.plugins.manage")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PaletteRow({ t, entry, installed, row, onInstall, onTrust, onCancel }: {
  readonly t: T;
  readonly entry: PluginCatalogEntry;
  readonly installed: boolean;
  readonly row: RowState | null;
  readonly onInstall: () => void;
  readonly onTrust: (entry: PluginCatalogEntry) => void;
  readonly onCancel: () => void;
}) {
  const shown = row?.entry ?? entry;
  const working = row?.phase === "checking" || row?.phase === "saving";
  const trustRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (row?.phase === "trust") trustRef.current?.focus({ preventScroll: false }); }, [row?.phase]);
  return (
    <div className="commodore-palette-row">
      <span className="commodore-palette-name">{entry.name}{shown.version ? <span className="commodore-plugins-at">{shown.version}</span> : null}</span>
      <span className="commodore-palette-action">
        {installed ? <span className="commodore-plugins-state is-done">{t("commodore.plugins.palette.installed")}</span>
          : row?.phase === "trust" ? null
            : <button type="button" className="fc-btn fc-btn--secondary commodore-palette-install" disabled={working} aria-label={t("commodore.plugins.palette.installAria", { plugin: entry.name })} onClick={onInstall}>{working ? t("commodore.plugins.palette.checking") : t("commodore.plugins.palette.install")}</button>}
      </span>
      {shown.description ? <span className="commodore-palette-desc">{shown.description}</span> : null}
      {shown.components ? <span className="commodore-plugins-meta"><Components t={t} components={shown.components} /></span> : null}
      {row?.phase === "failed" ? <span className="commodore-plugins-state is-failed commodore-palette-wide" role="alert">{errorWord(t, row.code ?? "failed")}</span> : null}
      {row?.phase === "trust" && shown.runs?.length ? (
        <div className="commodore-palette-trust" role="group" aria-label={t("commodore.plugins.trust.title")}>
          <p><strong>{t("commodore.plugins.trust.title")}</strong> {t("commodore.plugins.trust.body")}</p>
          <ul>{shown.runs.map((run, index) => <li key={index}><span>{t(run.kind === "hook" ? "commodore.plugins.trust.hook" : "commodore.plugins.trust.mcp", { label: run.label })}</span><code>{run.command}</code></li>)}</ul>
          <p className="commodore-palette-trust-source">{t("commodore.plugins.trust.source", { marketplace: entry.marketplace })}</p>
          <div className="commodore-palette-trust-actions">
            <button type="button" className="fc-btn fc-btn--secondary" onClick={onCancel}>{t("commodore.plugins.trust.cancel")}</button>
            <button ref={trustRef} type="button" className="fc-btn fc-btn--primary" onClick={() => onTrust(shown)}>{t("commodore.plugins.trust.confirm")}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const SearchGlyph = () => (
  <svg className="commodore-palette-search-glyph" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </svg>
);
