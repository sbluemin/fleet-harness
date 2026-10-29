import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import { openInDefaultOsBrowser } from "@fleet-console/link/core";
import { createPortal } from "react-dom";
import type { Translate } from "@fleet-console/i18n";
import "@fleet-console/markdown/styles.css";
import { httpUrl, pluginReadmeHtml } from "./plugin-readme.js";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { defineSettingsSection, SettingsGroup, SettingsItem, SettingsToggle, useMobileSettingsHost } from "../../settings/client/preferences-context.js";
import { openSettingsSurface } from "../../settings/client/settings-door.js";
import { pluginIconPath, splitPluginId, type CommodorePluginAuthView, type PluginServerAuthView, type MarketplaceErrorCode, type MarketplaceView, type PluginCatalogEntry, type PluginCatalogView, type PluginComponents, type PluginContents, type PluginDetail } from "../shared/contracts/plugins.js";
import { postCommodorePlugins, setCommodorePlugin, useCommodore, useCommodoreEnabled } from "./commodore-state.js";
import { commodoreName } from "./commodore-name.js";
import { getT, type CommodoreMessageKey } from "./i18n/index.js";
import "./commodore-routines.css";

type T = Translate<CommodoreMessageKey>;

/**
 * 사령관 플러그인 — Console 설정의 「마켓플레이스」 섹션(등록부, 사령관들이 함께 본다)과 사령관 설정 칸의 「플러그인」 목록·추가
 * 팔레트(사령관마다 고른다). 등록부·카탈로그는 Console 전역 하나라 이 모듈이 한 벌을 쥐고 두 표면이 함께 읽는다. 사령관이 고른
 * 목록은 사령관 상태(`state.plugins`)가 진다 — 설치는 누르는 즉시, 제거는 한 번 더 확인한 뒤에 저장하고, 적용은 다음 턴(새 세션)부터다.
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
  const view = await postCommodorePlugins<PluginCatalogView>(path, body);
  invalidatePluginDetails();
  setCatalog({ view, error: null });
}
async function inspectPlugin(pluginId: string): Promise<PluginCatalogEntry> {
  const { plugin } = await postCommodorePlugins<{ readonly plugin: PluginCatalogEntry }>("/commodore/plugins/inspect", { pluginId });
  const view = catalog.view;
  if (view) setCatalog({ view: { ...view, plugins: view.plugins.map((entry) => (entry.id === plugin.id ? { ...entry, ...plugin } : entry)) } });
  return plugin;
}

/**
 * 상세 응답 캐시 — 같은 카드를 다시 열면 구성·README 를 다시 받지 않는다. 목록 항목 자체는 바꾸지 않는다.
 * 마켓을 갱신·추가·제거·켜고 끄면 세대를 올려 비운다. 받는 중 폴링은 세대를 올리지 않아 열려 있는 상세를 비우지 않는다.
 * 세대가 바뀐 뒤에 끝나는 예전 요청은 캐시를 다시 채우지 않는다.
 */
const detailCache = new Map<string, PluginDetail>();
const detailInflight = new Map<string, { readonly generation: number; readonly promise: Promise<PluginDetail> }>();
let detailGeneration = 0;
const detailGenerationListeners = new Set<() => void>();
function invalidatePluginDetails(): void {
  detailGeneration += 1;
  detailCache.clear();
  for (const listener of detailGenerationListeners) listener();
}
function useDetailGeneration(): number {
  return useSyncExternalStore(
    (listener) => { detailGenerationListeners.add(listener); return () => { detailGenerationListeners.delete(listener); }; },
    () => detailGeneration,
    () => detailGeneration,
  );
}
function loadPluginDetail(pluginId: string): Promise<PluginDetail> {
  const generation = detailGeneration;
  const cached = detailCache.get(pluginId);
  if (cached) return Promise.resolve(cached);
  const pending = detailInflight.get(pluginId);
  if (pending?.generation === generation) return pending.promise;
  const promise = postCommodorePlugins<{ readonly plugin: PluginDetail }>("/commodore/plugins/detail", { pluginId }).then(({ plugin }) => {
    if (generation === detailGeneration) detailCache.set(pluginId, plugin);
    return plugin;
  }).finally(() => { if (detailInflight.get(pluginId)?.promise === promise) detailInflight.delete(pluginId); });
  detailInflight.set(pluginId, { generation, promise });
  return promise;
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

const ERROR_CODES: ReadonlySet<MarketplaceErrorCode> = new Set<MarketplaceErrorCode>(["invalid_source", "duplicate", "preset_name", "reserved_name", "name_taken", "not_found", "auth_failed", "no_manifest", "fetch_failed", "preset_locked", "limit", "disabled", "plugin_not_found", "install_failed", "trust_required", "unavailable", "cli_unavailable"]);
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

/* ── 머리 타일 ────────────────────────────────────────────────────────── */

/** 이니셜에서 빼는 낱말 — 마켓플레이스·플러그인 이름에 흔해 구별을 주지 못한다. */
const INITIAL_STOP_WORDS: ReadonlySet<string> = new Set(["claude", "for", "plugin", "plugins"]);

/** `knowledge-work-plugins` → KW, `code-review` → CR, `github` → G. 낱말이 모두 빠지면 이름 첫 글자다. */
function initialsOf(name: string): string {
  const first = (word: string) => Array.from(word)[0] ?? "";
  const words = name.split(/[-_.\s]+/).filter((word) => word && !INITIAL_STOP_WORDS.has(word.toLowerCase()));
  if (words.length === 0) return first(name.trim()).toUpperCase() || "?";
  return (words.length === 1 ? first(words[0]!) : first(words[0]!) + first(words[1]!)).toUpperCase();
}

/**
 * 마켓플레이스·플러그인 머리 타일 — 아이콘이 없으면(대부분이다) 무채색 이니셜, 플러그인이 낸 아이콘이 있으면 같은 자리·같은 모서리의
 * 그림이다. 그림을 읽지 못하면 이니셜로 돌아간다. 이름은 옆 글자가 말하므로 타일은 장식이다.
 */
function PluginTile({ name, iconId, size }: { readonly name: string; readonly iconId?: string | undefined; readonly size: "row" | "card" | "market" | "phone" | "detail" }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (iconId && broken !== iconId) {
    return (
      <span className={`commodore-tile is-${size} has-icon`} aria-hidden="true">
        <img src={pluginIconPath(iconId)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(iconId)} />
      </span>
    );
  }
  return <span className={`commodore-tile is-${size}`} aria-hidden="true">{initialsOf(name)}</span>;
}

const titleOf = (entry: PluginCatalogEntry | undefined, fallback: string): string => entry?.displayName ?? fallback;

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
  const openSubScreen = useMobileSettingsHost()?.openSubScreen;
  if (!enabled) return <p className="global-settings-help">{t("commodore.marketplaces.disabled")}</p>;
  if (!view) {
    return error ? <p className="global-settings-error" role="alert">{errorWord(t, error)}</p>
      : <p className="global-settings-help" role="status">{loading ? t("commodore.marketplaces.loading") : ""}</p>;
  }
  const act = (work: () => Promise<void>) => { setFailure(null); void work().catch((reason) => setFailure(errorWord(t, codeOf(reason)))); };
  const presets = view.marketplaces.filter((marketplace) => marketplace.preset);
  const customs = view.marketplaces.filter((marketplace) => !marketplace.preset);
  const anySyncing = view.marketplaces.some((marketplace) => marketplace.status === "syncing");
  // 데스크톱은 카드 격자(카드 한 층만 테두리를 진다). 폰은 이름·수·상태·토글만 둔 묶음 행이고, 행을 누르면 출처·갱신·설명·제거가
  // 있는 하위 화면이 열린다. 하위 화면을 열 수 없는 호스트는 카드를 그대로 쓴다.
  const list = (items: readonly MarketplaceView[]) => (openSubScreen
    ? items.map((marketplace) => <MarketplaceRow key={marketplace.name} t={t} marketplace={marketplace} act={act} onOpen={() => openSubScreen({ title: marketplace.name, render: () => <MarketplaceDetail name={marketplace.name} /> })} />)
    : <div className="commodore-market-grid">{items.map((marketplace) => <MarketplaceCard key={marketplace.name} t={t} marketplace={marketplace} act={act} />)}</div>);
  return (
    <div className="commodore-marketplaces">
      {failure ? <p className="global-settings-error" role="alert">{failure}</p> : null}
      <SettingsGroup
        ariaLabel={t("commodore.marketplaces.presets")}
        title={<span className="commodore-marketplaces-head">{t("commodore.marketplaces.presets")}<button type="button" className="commodore-plugins-text" disabled={anySyncing} onClick={() => act(() => applyCatalog("/commodore/marketplaces/update", {}))}>{t("commodore.marketplaces.updateAll")}</button></span>}
        note={t("commodore.marketplaces.presetsNote")}
      >
        {list(presets)}
      </SettingsGroup>
      <SettingsGroup ariaLabel={t("commodore.marketplaces.custom")} title={t("commodore.marketplaces.custom")}>
        {customs.length ? list(customs) : <p className="global-settings-help">{t("commodore.marketplaces.customEmpty")}</p>}
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

type Act = (work: () => Promise<void>) => void;

/** 데스크톱 카드의 상태 한 마디와 행동 단추·제거 확인. 폰은 행(`MarketplaceRow`)과 상세(`MarketplaceDetail`)가 나눠 진다. */
function useMarketplaceControls(t: T, marketplace: MarketplaceView, act: Act) {
  const [confirming, setConfirming] = useState(false);
  const syncing = marketplace.status === "syncing";
  const status = syncing ? <span className="commodore-plugins-state is-syncing">{t("commodore.marketplaces.syncing")}</span>
    : marketplace.status === "failed" ? <span className="commodore-plugins-state is-failed">{t("commodore.marketplaces.failed", { reason: errorWord(t, marketplace.error ?? "fetch_failed") })}</span>
      : !marketplace.enabled ? <span className="commodore-plugins-state">{t("commodore.marketplaces.off")}</span>
        : marketplace.updatedAt ? <span>{t("commodore.marketplaces.updatedAt", { time: updatedWord(marketplace.updatedAt) })}</span> : null;
  const summary = <span>{t("commodore.marketplaces.count", { n: marketplace.pluginCount })}{status ? <> · {status}</> : null}</span>;
  // 카드는 실패 이유를 본문 한 줄로 따로 세운다 — 아래 칸에 두면 긴 문장이 행동 단추를 다음 줄로 민다.
  const failed = marketplace.status === "failed";
  const failure = failed ? <p className="commodore-market-card-failure commodore-plugins-state is-failed">{t("commodore.marketplaces.failed", { reason: errorWord(t, marketplace.error ?? "fetch_failed") })}</p> : null;
  const cardSummary = failed ? <span>{t("commodore.marketplaces.count", { n: marketplace.pluginCount })}</span> : summary;
  const confirm = confirming ? (
    <span className="commodore-marketplaces-confirm" role="alert">
      <span>{t("commodore.marketplaces.removeConfirm", { name: marketplace.name })}</span>
      <button type="button" className="commodore-plugins-text" onClick={() => setConfirming(false)}>{t("commodore.marketplaces.removeCancel")}</button>
      <button type="button" className="commodore-plugins-text is-danger" onClick={() => { setConfirming(false); act(() => applyCatalog("/commodore/marketplaces/remove", { name: marketplace.name })); }}>{t("commodore.marketplaces.remove")}</button>
    </span>
  ) : null;
  const actions = (
    <span className="commodore-marketplaces-actions">
      <button type="button" className="commodore-plugins-text" disabled={syncing} aria-label={t("commodore.marketplaces.updateAria", { name: marketplace.name })} onClick={() => act(() => applyCatalog("/commodore/marketplaces/update", { name: marketplace.name }))}>{t("commodore.marketplaces.update")}</button>
      {marketplace.preset ? null : <button type="button" className="commodore-plugins-text" aria-label={t("commodore.marketplaces.removeAria", { name: marketplace.name })} onClick={() => setConfirming(true)}>{t("commodore.marketplaces.remove")}</button>}
      <SettingsToggle checked={marketplace.enabled} ariaLabel={t("commodore.marketplaces.enableAria", { name: marketplace.name })} onChange={enableMarketplace(marketplace, act)} />
    </span>
  );
  const locator = <span className="commodore-plugins-locator">{marketplace.locator}{marketplace.ref ? ` @${marketplace.ref}` : ""}</span>;
  return { cardSummary, failure, confirm, actions, locator };
}

/**
 * 데스크톱 마켓플레이스 카드 — 머리(타일·이름·출처), 설명 한 줄, 아래 칸(수·상태·행동). 마켓플레이스에는 아이콘 필드가 없어
 * 타일은 언제나 이니셜이다. 꺼진 카드는 색이 아니라 옅어짐으로 말한다.
 */
function MarketplaceCard({ t, marketplace, act }: { readonly t: T; readonly marketplace: MarketplaceView; readonly act: Act }) {
  const { cardSummary, failure, confirm, actions, locator } = useMarketplaceControls(t, marketplace, act);
  return (
    <article className={`commodore-market-card${marketplace.enabled ? "" : " is-off"}`} aria-label={marketplace.name}>
      <div className="commodore-market-card-head">
        <PluginTile name={marketplace.name} size="market" />
        <div className="commodore-market-card-title">
          <p className="commodore-market-card-name">{marketplace.name}</p>
          <p className="commodore-market-card-source">{locator}{marketplace.preset ? <span className="commodore-marketplaces-by">{t("commodore.marketplaces.by")}</span> : null}</p>
        </div>
      </div>
      {marketplace.description ? <p className="commodore-market-card-desc" title={marketplace.description}>{marketplace.description}</p> : null}
      {!marketplace.preset && marketplace.owner ? <p className="commodore-market-card-desc">{t("commodore.plugins.byAuthor", { name: marketplace.owner })}</p> : null}
      {failure}
      {confirm}
      <div className="commodore-market-card-foot">
        <span className="commodore-market-card-status">{cardSummary}</span>
        {actions}
      </div>
    </article>
  );
}

const enableMarketplace = (marketplace: MarketplaceView, act: Act) => (next: boolean) => act(() => applyCatalog("/commodore/marketplaces/enable", { name: marketplace.name, enabled: next }));

/** 폰 행의 짧은 상태 — 긴 실패 이유와 「이미 설치한 것은 그대로」 안내는 상세가 말한다. */
function shortStatus(t: T, marketplace: MarketplaceView) {
  if (marketplace.status === "syncing") return <span className="commodore-plugins-state is-syncing">{t("commodore.marketplaces.syncing")}</span>;
  if (marketplace.status === "failed") return <span className="commodore-plugins-state is-failed">{t("commodore.marketplaces.failedShort")}</span>;
  if (!marketplace.enabled) return <span className="commodore-plugins-state">{t("commodore.marketplaces.offShort")}</span>;
  return marketplace.updatedAt ? <span>{t("commodore.marketplaces.updatedAt", { time: updatedWord(marketplace.updatedAt) })}</span> : null;
}

/**
 * 폰 마켓플레이스 행 — 타일·이름·「플러그인 N개 · 상태」·토글. 모바일 설정 행은 `<label>`이라 행을 누르면 첫 컨트롤이 눌린다.
 * 토글과 상세 열기를 한 행에 같이 두려고 행은 `div`로 두고, 행 전체를 덮는 열기 단추 위에 토글만 올려 세운다.
 */
function MarketplaceRow({ t, marketplace, act, onOpen }: { readonly t: T; readonly marketplace: MarketplaceView; readonly act: Act; readonly onOpen: () => void }) {
  const status = shortStatus(t, marketplace);
  return (
    <div className={`fc-settings-row is-mobile commodore-market-row${marketplace.enabled ? "" : " is-off"}`}>
      <button type="button" className="commodore-market-row-open" aria-haspopup="dialog" aria-label={t("commodore.marketplaces.detail.openAria", { name: marketplace.name })} onClick={onOpen} />
      <span className="fc-settings-row__icon" aria-hidden="true"><PluginTile name={marketplace.name} size="phone" /></span>
      <span className="fc-settings-row__copy">
        <span className="fc-settings-row__label">{marketplace.name}</span>
        <span className="fc-settings-row__hint">{t("commodore.marketplaces.count", { n: marketplace.pluginCount })}{status ? <> · {status}</> : null}</span>
      </span>
      <span className="fc-settings-row__control commodore-market-row-toggle">
        <SettingsToggle checked={marketplace.enabled} ariaLabel={t("commodore.marketplaces.enableAria", { name: marketplace.name })} onChange={enableMarketplace(marketplace, act)} />
      </span>
    </div>
  );
}

/**
 * 폰 마켓플레이스 상세 하위 화면. 하위 화면은 설정 섹션을 대신 그려 목록(`MarketplaceSettings`)과 그 폴링이 내려가므로,
 * 받는 중인 동안 상태·수·갱신 시각이 이어지도록 여기서도 카탈로그를 다시 읽는다. 지워진 뒤에는 그렇다고 말한다.
 */
function MarketplaceDetail({ name }: { readonly name: string }) {
  const t = getT(useConsoleLocale());
  const { view } = useLiveCatalog(true);
  const marketplace = view?.marketplaces.find((candidate) => candidate.name === name);
  if (!marketplace) return <SettingsGroup ariaLabel={name}><p className="global-settings-help">{t("commodore.marketplaces.detail.gone")}</p></SettingsGroup>;
  return <MarketplaceDetailBody t={t} marketplace={marketplace} />;
}

function MarketplaceDetailBody({ t, marketplace }: { readonly t: T; readonly marketplace: MarketplaceView }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const act: Act = (work) => { setFailure(null); void work().catch((reason) => setFailure(errorWord(t, codeOf(reason)))); };
  const syncing = marketplace.status === "syncing";
  const status = syncing ? <span className="commodore-plugins-state is-syncing">{t("commodore.marketplaces.syncing")}</span>
    : marketplace.status === "failed" ? <span className="commodore-plugins-state is-failed">{t("commodore.marketplaces.failed", { reason: errorWord(t, marketplace.error ?? "fetch_failed") })}</span>
      : !marketplace.enabled ? <span className="commodore-plugins-state">{t("commodore.marketplaces.off")}</span> : null;
  return (
    <div className="commodore-market-detail">
      {failure ? <p className="global-settings-error" role="alert">{failure}</p> : null}
      <SettingsGroup ariaLabel={t("commodore.marketplaces.detail.about")} note={marketplace.preset ? t("commodore.marketplaces.presetsNote") : undefined}>
        <SettingsItem
          label={t("commodore.marketplaces.detail.source")}
          icon={<PluginTile name={marketplace.name} size="phone" />}
          badge={marketplace.preset ? <span className="commodore-marketplaces-by">{t("commodore.marketplaces.by")}</span> : undefined}
          hint={<span className="commodore-plugins-locator">{marketplace.locator}{marketplace.ref ? ` @${marketplace.ref}` : ""}</span>}
        >{null}</SettingsItem>
        {marketplace.description ? <SettingsItem label={t("commodore.marketplaces.detail.description")} hint={marketplace.description}>{null}</SettingsItem> : null}
        {!marketplace.preset && marketplace.owner ? <SettingsItem label={t("commodore.marketplaces.detail.owner")} hint={marketplace.owner}>{null}</SettingsItem> : null}
        <SettingsItem label={t("commodore.marketplaces.detail.status")} hint={<span>{t("commodore.marketplaces.count", { n: marketplace.pluginCount })}{status ? <> · {status}</> : null}</span>}>{null}</SettingsItem>
      </SettingsGroup>
      <SettingsGroup ariaLabel={t("commodore.marketplaces.detail.manage")}>
        <SettingsItem label={t("commodore.marketplaces.detail.enabled")}>
          <SettingsToggle checked={marketplace.enabled} ariaLabel={t("commodore.marketplaces.enableAria", { name: marketplace.name })} onChange={enableMarketplace(marketplace, act)} />
        </SettingsItem>
        <SettingsItem label={t("commodore.marketplaces.detail.update")} hint={marketplace.updatedAt ? t("commodore.marketplaces.updatedAt", { time: updatedWord(marketplace.updatedAt) }) : undefined}>
          <button type="button" className="commodore-plugins-text" disabled={syncing} aria-label={t("commodore.marketplaces.updateAria", { name: marketplace.name })} onClick={() => act(() => applyCatalog("/commodore/marketplaces/update", { name: marketplace.name }))}>{t("commodore.marketplaces.update")}</button>
        </SettingsItem>
        {marketplace.preset ? null : (
          <SettingsItem label={t("commodore.marketplaces.detail.remove")}>
            <button type="button" className="commodore-plugins-text is-danger" aria-label={t("commodore.marketplaces.removeAria", { name: marketplace.name })} onClick={() => setConfirming(true)}>{t("commodore.marketplaces.remove")}</button>
          </SettingsItem>
        )}
      </SettingsGroup>
      {confirming ? (
        <div className="commodore-market-detail-confirm" role="alert">
          <p>{t("commodore.marketplaces.removeConfirm", { name: marketplace.name })}</p>
          <div className="commodore-market-detail-confirm-actions">
            <button type="button" className="fc-btn fc-btn--secondary" onClick={() => setConfirming(false)}>{t("commodore.marketplaces.removeCancel")}</button>
            <button type="button" className="fc-btn fc-btn--secondary commodore-market-detail-remove" onClick={() => { setConfirming(false); act(() => applyCatalog("/commodore/marketplaces/remove", { name: marketplace.name })); }}>{t("commodore.marketplaces.remove")}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 출처 표기를 알아본다 — 안내 한 줄용이다. 받을 수 있는지는 서버가 정한다(`invalid_source`). */
function sourceKind(value: string): { readonly key: CommodoreMessageKey; readonly ref: boolean } | "bad" | null {
  const source = value.trim();
  if (!source) return null;
  if (/^(?:[\w.-]+@[\w.-]+:(?!\/\/)|ssh:\/\/[\w.-]+@[\w.-]+\/)\S+$/.test(source)) return { key: "commodore.marketplaces.kind.ssh", ref: true };
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
      invalidatePluginDetails();
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

/* ── 사령관 설정 「플러그인」 — MCP 인증·키·제거 메뉴 ─────────────────────── */

const AUTH_POLL_MS = 2_000;
type ServerAuth = PluginServerAuthView;

/** 이 사령관이 고른 플러그인의 인증 상태. 브라우저에서 진행 중인 서버가 있는 동안 몇 초마다 다시 읽는다. */
function usePluginAuth(commodoreId: string, installedKey: string) {
  const [view, setView] = useState<CommodorePluginAuthView | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!commodoreId || !installedKey) { setView(null); return; }
    let live = true;
    void postCommodorePlugins<CommodorePluginAuthView>("/commodore/plugins/auth/status", { commodoreId })
      .then((next) => { if (live) setView(next); }, () => undefined);
    return () => { live = false; };
  }, [commodoreId, installedKey, round]);
  const pending = view?.plugins.some((plugin) => plugin.servers.some((server) => server.state === "pending")) ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setRound((n) => n + 1), AUTH_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [pending, view]);
  return { view, setView };
}

/** 행 메타 줄의 상태 한 마디 — 진행 중 > 실패 > 인증 필요(서버 수) > 키 필요. 연결된 행은 아무것도 붙지 않는다. */
function authMark(t: T, servers: readonly ServerAuth[] | undefined) {
  if (!servers?.length) return null;
  if (servers.some((server) => server.state === "pending")) return <span className="commodore-plugins-state is-syncing">{t("commodore.plugins.auth.pending")}</span>;
  const failed = servers.find((server) => server.state === "failed");
  if (failed) return <span className="commodore-plugins-state is-failed">{t("commodore.plugins.auth.failed", { reason: t(`commodore.plugins.auth.reason.${failed.failure ?? "error"}`) })}</span>;
  const needed = servers.filter((server) => server.state === "needs-auth").length;
  if (needed) return <span className="commodore-plugins-state is-warn">{needed > 1 ? t("commodore.plugins.auth.neededCount", { n: needed }) : t("commodore.plugins.auth.needed")}</span>;
  if (servers.some((server) => server.state === "key-needed")) return <span className="commodore-plugins-state is-warn">{t("commodore.plugins.key.needed")}</span>;
  return null;
}

/**
 * 브라우저는 응답을 기다린 뒤의 `window.open`을 팝업으로 막는다 — 누른 순간 빈 탭을 먼저 열어 두고 주소가 오면 그리로 보낸다.
 * Desktop·Mobile 셸은 http(s) 가 아닌 창을 거절하므로(null) 받은 주소를 외부 열기 헬퍼로 넘긴다(셸이 기본 브라우저로 연다).
 */
function prepareExternalWindow(): (url: string | null) => void {
  let placeholder: Window | null = null;
  try { placeholder = window.open("", "_blank"); } catch { placeholder = null; }
  return (url) => {
    if (!url) { placeholder?.close(); return; }
    if (placeholder && !placeholder.closed) {
      try { placeholder.opener = null; placeholder.location.href = url; return; } catch { placeholder.close(); }
    }
    openInDefaultOsBrowser(url);
  };
}

/** Console 을 이 컴퓨터의 loopback 으로 열었는가 — 아니면 인증 콜백이 브라우저 쪽 기기로 돌아오지 못한다. */
const onConsoleComputer = (): boolean => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(window.location.hostname);

interface MenuItem { readonly id: string; readonly label: string; readonly run: () => void }
type InlineForm = { readonly pluginId: string; readonly kind: "key"; readonly names: readonly string[] } | { readonly pluginId: string; readonly kind: "callback"; readonly server: string };

/**
 * 사령관 설정 칸에서 Theater 목록 바로 아래 — 이 사령관이 고른 플러그인. 상태는 메타 줄의 한 마디로만 보이고, 인증·키·제거는
 * 행의 메뉴(우클릭, ContextMenu 키·Shift+F10, 폰은 길게 누르기 → 아래 시트)에서 한다 — 루틴 목록과 같은 메뉴다. 제거는 메뉴에서
 * 한 번 더 눌러 확인하고, 적용은 다음 턴부터라 칸 아래 한 줄이 그 시점을 말한다.
 */
export function CommodorePlugins({ t, commodoreId, phone = false }: { readonly t: T; readonly commodoreId: string; readonly phone?: boolean }) {
  const { view } = useCommodore(commodoreId);
  const { view: catalogView } = useLiveCatalog(Boolean(commodoreId));
  const [palette, setPalette] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ readonly pluginId: string; readonly x: number; readonly y: number; readonly trigger: HTMLElement } | null>(null);
  const [armed, setArmed] = useState(false);
  const [form, setForm] = useState<InlineForm | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const installed = view?.state.plugins ?? [];
  const auth = usePluginAuth(commodoreId, installed.join("\n"));
  const cancelPress = () => { if (press.current) clearTimeout(press.current.timer); press.current = null; };
  const closeMenu = (focus = true) => { if (focus) menu?.trigger.focus({ preventScroll: true }); setMenu(null); setArmed(false); };
  const openMenu = (pluginId: string, trigger: HTMLElement, x: number, y: number) => { cancelPress(); setArmed(false); setMenu({ pluginId, trigger, x, y }); };
  useEffect(() => () => cancelPress(), []);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) { menu.trigger.focus({ preventScroll: true }); setMenu(null); setArmed(false); } };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); menu.trigger.focus({ preventScroll: true }); setMenu(null); setArmed(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", dismiss, true); document.removeEventListener("keydown", escape, true); };
  }, [menu]);
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node || !menu) return;
    if (!phone) {
      const rect = node.getBoundingClientRect();
      node.style.left = `${Math.max(16, Math.min(menu.x, window.innerWidth - rect.width - 16))}px`;
      node.style.top = `${Math.max(16, Math.min(menu.y, window.innerHeight - rect.height - 16))}px`;
    }
    node.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu, phone]);
  if (!commodoreId || !view) return null;
  const entries = new Map(catalogView?.plugins.map((entry) => [entry.id, entry]) ?? []);
  const marketplaces = new Map(catalogView?.marketplaces.map((marketplace) => [marketplace.name, marketplace]) ?? []);
  const authOf = new Map(auth.view?.plugins.map((plugin) => [plugin.pluginId, plugin.servers]) ?? []);
  const run = (pluginId: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(pluginId); setFailure(null);
    void work().catch((error) => setFailure(errorWord(t, codeOf(error)))).finally(() => setBusy(null));
  };
  const remove = (pluginId: string) => run(pluginId, () => setCommodorePlugin(commodoreId, pluginId, false));
  const authAction = (pluginId: string, server: string, action: "cancel" | "clear") => run(pluginId, async () => {
    const { view: next } = await postCommodorePlugins<{ readonly view: CommodorePluginAuthView }>("/commodore/plugins/auth/action", { commodoreId, pluginId, server, action });
    auth.setView(next);
  });
  const startAuth = (pluginId: string, server: string) => {
    if (busy) return;
    const open = prepareExternalWindow();
    setBusy(pluginId); setFailure(null);
    void postCommodorePlugins<{ readonly authUrl?: string; readonly view: CommodorePluginAuthView }>("/commodore/plugins/auth/action", { commodoreId, pluginId, server, action: "start" })
      .then(({ authUrl, view: next }) => { auth.setView(next); open(authUrl ?? null); }, (error) => { open(null); setFailure(errorWord(t, codeOf(error))); })
      .finally(() => setBusy(null));
  };
  const setKeys = (pluginId: string, values: readonly (readonly [string, string | null])[]) => run(pluginId, async () => {
    let next: CommodorePluginAuthView | null = null;
    for (const [name, value] of values) ({ view: next } = await postCommodorePlugins<{ readonly view: CommodorePluginAuthView }>("/commodore/plugins/key", { commodoreId, pluginId, name, value }));
    if (next) auth.setView(next);
    setForm(null);
  });
  const submitCallback = (pluginId: string, server: string, callbackUrl: string) => run(pluginId, async () => {
    const { view: next } = await postCommodorePlugins<{ readonly view: CommodorePluginAuthView }>("/commodore/plugins/auth/callback", { commodoreId, pluginId, server, callbackUrl });
    auth.setView(next);
    setForm(null);
  });
  /** 상태별 항목. 서버가 여럿이면 서버 이름을 붙인다. 원격 기기에서 진행 중이면 돌아온 주소를 옮겨 붙일 수 있다. */
  const itemsOf = (pluginId: string): MenuItem[] => {
    const servers = authOf.get(pluginId) ?? [];
    const oauth = servers.filter((server) => server.mode === "oauth");
    const named = oauth.length > 1;
    const items: MenuItem[] = [];
    for (const server of oauth) {
      const id = `${server.server}:${server.state}`;
      // 확인하지 못한 서버(unknown)도 로그인을 시작할 수는 있다 — 이미 연결돼 있으면 서버가 그렇게 답한다.
      if (server.state === "needs-auth" || server.state === "unknown") items.push({ id, label: named ? t("commodore.plugins.auth.startServer", { server: server.server }) : t("commodore.plugins.auth.start"), run: () => startAuth(pluginId, server.server) });
      else if (server.state === "failed") items.push({ id, label: named ? t("commodore.plugins.auth.retryServer", { server: server.server }) : t("commodore.plugins.auth.retry"), run: () => startAuth(pluginId, server.server) });
      else if (server.state === "connected") items.push({ id, label: named ? t("commodore.plugins.auth.clearServer", { server: server.server }) : t("commodore.plugins.auth.clear"), run: () => authAction(pluginId, server.server, "clear") });
      else if (server.state === "pending") {
        const prefix = named ? `${server.server} · ` : "";
        if (server.authUrl) { const url = server.authUrl; items.push({ id: `${id}:reopen`, label: `${prefix}${t("commodore.plugins.auth.reopen")}`, run: () => { openInDefaultOsBrowser(url); } }); }
        if (server.local && !onConsoleComputer()) items.push({ id: `${id}:paste`, label: `${prefix}${t("commodore.plugins.auth.paste")}`, run: () => setForm({ pluginId, kind: "callback", server: server.server }) });
        items.push({ id: `${id}:cancel`, label: `${prefix}${t("commodore.plugins.auth.cancel")}`, run: () => authAction(pluginId, server.server, "cancel") });
      }
    }
    const keyed = servers.filter((server) => server.mode === "key");
    const names = [...new Set(keyed.flatMap((server) => server.keys ?? []))];
    if (names.length) {
      items.push({ id: "key", label: t(keyed.some((server) => server.state === "key-needed") ? "commodore.plugins.key.enter" : "commodore.plugins.key.change"), run: () => setForm({ pluginId, kind: "key", names }) });
      const saved = [...new Set(keyed.filter((server) => server.saved).flatMap((server) => server.keys ?? []))];
      if (saved.length) items.push({ id: "key-clear", label: t("commodore.plugins.key.clear"), run: () => setKeys(pluginId, saved.map((name) => [name, null] as const)) });
    }
    return items;
  };
  const close = () => { setPalette(false); addRef.current?.focus({ preventScroll: true }); };
  const note = installed.length === 0 ? t("commodore.plugins.empty") : t("commodore.plugins.applies");
  const rows = installed.map((pluginId) => {
    const { plugin, marketplace } = splitPluginId(pluginId);
    const entry = entries.get(pluginId);
    const source = marketplaces.get(marketplace);
    const mark = catalogView && !source?.enabled ? <span className="commodore-plugins-state is-warn">{t("commodore.plugins.marketplaceOff")}</span>
      : catalogView && !entry ? <span className="commodore-plugins-state">{t("commodore.plugins.notListed")}</span> : authMark(t, authOf.get(pluginId));
    return { pluginId, plugin, title: titleOf(entry, plugin), marketplace, entry, mark };
  });
  const rowHandlers = (pluginId: string) => ({
    tabIndex: 0,
    "aria-haspopup": phone ? "dialog" as const : "menu" as const,
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => { if ((event.target as HTMLElement).closest("form")) return; event.preventDefault(); openMenu(pluginId, event.currentTarget, event.clientX, event.clientY); },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(pluginId, event.currentTarget, rect.left + 16, rect.bottom); }
    },
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse" || event.button !== 0 || (event.target as HTMLElement).closest("form")) return;
      cancelPress(); suppressClick.current = false;
      const trigger = event.currentTarget; const { clientX: x, clientY: y } = event;
      press.current = { x, y, timer: setTimeout(() => { suppressClick.current = true; openMenu(pluginId, trigger, x, y); }, 500) };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => { if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 6) cancelPress(); },
    onPointerUp: cancelPress, onPointerCancel: cancelPress, onPointerLeave: cancelPress,
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } },
  });
  const inline = (pluginId: string, title: string) => form?.pluginId === pluginId
    ? form.kind === "key"
      ? <KeyForm key={`key:${pluginId}`} t={t} plugin={title} names={form.names} busy={busy !== null} phone={phone} onCancel={() => setForm(null)} onSave={(values) => setKeys(pluginId, values)} />
      : <CallbackForm key={`callback:${pluginId}:${form.server}`} t={t} server={form.server} busy={busy !== null} phone={phone} onCancel={() => setForm(null)} onSave={(url) => submitCallback(pluginId, form.server, url)} />
    : null;
  const selected = menu ? rows.find((row) => row.pluginId === menu.pluginId) : undefined;
  const menuItems = selected ? itemsOf(selected.pluginId) : [];
  const failureLine = failure ? <p className={phone ? "objectives-cm-note" : "objectives-commodore-hint is-error"} role="alert">{failure}</p> : null;
  const dialog = palette ? <PluginPalette t={t} commodoreId={commodoreId} installed={installed} phone={phone} onClose={close} /> : null;
  const itemRole = phone ? undefined : "menuitem";
  const onMenuKey = (event: ReactKeyboardEvent) => {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1);
      buttons[(next + buttons.length) % buttons.length]?.focus();
    }
  };
  const menuNode = menu && selected ? createPortal(<div className={phone ? "commodore-routines-scrim" : "commodore-routines-menu-host"}>
    <div ref={menuRef} className={`commodore-routines-menu${phone ? " is-sheet" : ""}`} role={phone ? "dialog" : "menu"} aria-modal={phone ? true : undefined} aria-label={selected.title} onKeyDown={onMenuKey}>
      <div className="commodore-routines-menu-title">{selected.title}</div>
      {menuItems.map((item) => <button key={item.id} type="button" role={itemRole} disabled={busy !== null} onClick={() => { closeMenu(); item.run(); }}>{item.label}</button>)}
      {menuItems.length ? <div className="commodore-routines-separator" role="separator" /> : null}
      <button type="button" role={itemRole} className={`is-danger${armed ? " is-armed" : ""}`} disabled={busy !== null} onClick={() => {
        if (!armed) { setArmed(true); return; }
        closeMenu(); remove(selected.pluginId);
      }}>{t(armed ? "commodore.plugins.removeArmed" : "commodore.plugins.remove")}</button>
    </div>
  </div>, document.body) : null;

  if (phone) {
    return (
      <section className="commodore-plugins is-phone" aria-label={t("commodore.plugins.title")}>
        <p className="objectives-cm-glab">{t("commodore.plugins.title")}</p>
        <div className="objectives-cm-grp">
          {rows.map(({ pluginId, title, marketplace, entry, mark }) => (
            <Fragment key={pluginId}>
              <div className={`objectives-cm-gr commodore-plugins-phone-row${menu?.pluginId === pluginId ? " is-target" : ""}`} aria-label={title} {...rowHandlers(pluginId)}>
                <PluginTile name={title} iconId={entry?.icon ? pluginId : undefined} size="phone" />
                <span className="objectives-cm-gr-tx">{title}<small className="is-mono">@{marketplace}</small>{mark || entry?.components ? <small className="commodore-plugins-meta">{mark}<Components t={t} components={entry?.components} /></small> : null}</span>
              </div>
              {inline(pluginId, title)}
            </Fragment>
          ))}
          <button ref={addRef} type="button" data-press="r1" className="objectives-cm-gr commodore-theaters-phone-add" onClick={() => setPalette(true)}>
            <span className="objectives-cm-intel-plus" aria-hidden="true">+</span>
            <span className="objectives-cm-gr-tx">{t("commodore.plugins.add")}</span>
          </button>
        </div>
        {failureLine}
        <p className="objectives-cm-secnote">{note}</p>
        {dialog}
        {menuNode}
      </section>
    );
  }

  return (
    <section className="objectives-commodore-section commodore-plugins" aria-label={t("commodore.plugins.title")}>
      <p className="objectives-commodore-section-title commodore-plugins-head"><span className="fc-settings-row__label">{t("commodore.plugins.title")}</span><button type="button" className="commodore-plugins-text" onClick={() => openSettingsSurface(MARKETPLACE_SETTINGS_ADDRESS)}>{t("commodore.plugins.manage")}</button></p>
      {rows.length ? (
        <ul className="commodore-plugins-list">
          {rows.map(({ pluginId, title, marketplace, entry, mark }) => (
            <li key={pluginId} className={`commodore-plugins-row${menu?.pluginId === pluginId ? " is-target" : ""}`} aria-label={title} {...rowHandlers(pluginId)}>
              <PluginTile name={title} iconId={entry?.icon ? pluginId : undefined} size="row" />
              <span className="commodore-plugins-name" title={pluginId}>{title}<span className="commodore-plugins-at">@{marketplace}</span></span>
              {mark || entry?.components ? <span className="commodore-plugins-meta">{mark}<Components t={t} components={entry?.components} /></span> : null}
              {inline(pluginId, title)}
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
      {menuNode}
    </section>
  );
}

/** 행 안 키 입력 — 선언이 받는 `${VAR}` 마다 password 칸 하나. 빈 칸은 그대로 둔다. 값은 저장한 뒤 화면에 다시 오지 않는다. */
function KeyForm({ t, plugin, names, busy, phone, onCancel, onSave }: { readonly t: T; readonly plugin: string; readonly names: readonly string[]; readonly busy: boolean; readonly phone: boolean; readonly onCancel: () => void; readonly onSave: (values: readonly (readonly [string, string])[]) => void }) {
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const first = useRef<HTMLInputElement | null>(null);
  useEffect(() => { first.current?.focus({ preventScroll: true }); }, []);
  const filled = names.flatMap((name) => (values[name]?.trim() ? [[name, values[name]!.trim()] as const] : []));
  const submit = (event: FormEvent) => { event.preventDefault(); if (filled.length && !busy) onSave(filled); };
  return <form className={`commodore-plugins-inline${phone ? " is-phone" : ""}`} onSubmit={submit} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    {names.map((name, index) => <input key={name} ref={index === 0 ? first : undefined} className="commodore-plugins-field" type="password" autoComplete="off" spellCheck={false} placeholder={name} aria-label={t("commodore.plugins.key.aria", { plugin, name })} value={values[name] ?? ""} disabled={busy} onChange={(event) => setValues({ ...values, [name]: event.target.value })} />)}
    <span className="commodore-plugins-inline-actions">
      <button type="button" className="commodore-plugins-text" onClick={onCancel}>{t("commodore.plugins.removeCancel")}</button>
      <button type="submit" className="commodore-plugins-text is-go" disabled={busy || !filled.length}>{t("commodore.plugins.key.save")}</button>
    </span>
  </form>;
}

/** 원격 기기에서 — 브라우저가 Console 컴퓨터의 loopback 으로 돌아가다 멈춘 주소를 옮겨 붙인다. */
function CallbackForm({ t, server, busy, phone, onCancel, onSave }: { readonly t: T; readonly server: string; readonly busy: boolean; readonly phone: boolean; readonly onCancel: () => void; readonly onSave: (url: string) => void }) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  const submit = (event: FormEvent) => { event.preventDefault(); if (value.trim() && !busy) onSave(value.trim()); };
  return <form className={`commodore-plugins-inline${phone ? " is-phone" : ""}`} onSubmit={submit} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <p className="commodore-plugins-inline-hint">{t("commodore.plugins.auth.pasteHint")}</p>
    <input ref={input} className="commodore-plugins-field" type="url" autoComplete="off" spellCheck={false} placeholder="http://localhost:…/callback?…" aria-label={t("commodore.plugins.auth.pasteAria", { server })} value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} />
    <span className="commodore-plugins-inline-actions">
      <button type="button" className="commodore-plugins-text" onClick={onCancel}>{t("commodore.plugins.removeCancel")}</button>
      <button type="submit" className="commodore-plugins-text is-go" disabled={busy || !value.trim()}>{t("commodore.plugins.key.save")}</button>
    </span>
  </form>;
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
 * 마켓플레이스마다 앞 몇 개만 세운다. 카드(설치 단추 제외)를 누르면 같은 팔레트 안에서 상세가 열린다. 목록은 언마운트하지 않아
 * 검색어·필터·스크롤이 남고, Esc 는 상세에서 뒤로, 목록에서 닫기다. 설치는 inspect 로 구성 요소·실행 명령을 받은 뒤, 실행 명령이
 * 있으면 그 원문을 보여 주고 사람이 확인해야 `trusted` 로 저장한다. 바깥 누름은 팔레트만 닫는다(뒤의 시트·패널은 그대로).
 */
function PluginPalette({ t, commodoreId, installed, phone = false, onClose }: { readonly t: T; readonly commodoreId: string; readonly installed: readonly string[]; readonly phone?: boolean; readonly onClose: () => void }) {
  const { view, error } = usePluginCatalog();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string | null>(null);
  const [row, setRow] = useState<RowState | null>(null);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const scrollTop = useRef(0);
  const returnFocusId = useRef<string | null>(null);
  /** 상세의 제거 확인이 열려 있으면 Esc 가 그것만 닫게 한다. */
  const dismissConfirm = useRef<() => boolean>(() => false);
  const titleId = useId();
  const detailTitleId = useId();
  const name = commodoreName(commodoreId, t);
  const detailEpoch = useDetailGeneration();
  const holdFocus = () => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const active = document.activeElement;
    if (active instanceof Node && dialog.contains(active)) return;
    dialog.focus();
  };
  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => { holdFocus(); });
  useEffect(() => {
    if (!openedId) return;
    const id = openedId;
    if (detailCache.has(id)) { setDetailLoading(false); setDetailError(null); return; }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    void loadPluginDetail(id).then(
      () => { if (!cancelled) setDetailLoading(false); },
      (reason) => { if (!cancelled) { setDetailLoading(false); setDetailError(codeOf(reason)); } },
    );
    return () => { cancelled = true; };
  }, [openedId, detailEpoch]);
  useEffect(() => {
    if (openedId) return;
    const id = returnFocusId.current;
    const list = listRef.current;
    if (!list || !id) return;
    list.scrollTop = scrollTop.current;
    list.querySelector<HTMLElement>(`[data-plugin-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }, [openedId]);
  const enabled = useMemo(() => view?.marketplaces.filter((marketplace) => marketplace.enabled) ?? [], [view]);
  const hidden = (view?.marketplaces.length ?? 0) - enabled.length;
  const total = enabled.reduce((sum, marketplace) => sum + marketplace.pluginCount, 0);
  const installedSet = new Set(installed);
  const needle = query.trim().toLowerCase();
  const matches = (entry: PluginCatalogEntry) => !needle || [entry.name, entry.displayName, entry.description, entry.category, entry.author, entry.marketplace, entry.license, entry.keywords?.join(" ")].some((value) => value?.toLowerCase().includes(needle) ?? false);
  const openDetail = (id: string) => {
    scrollTop.current = listRef.current?.scrollTop ?? 0;
    returnFocusId.current = id;
    setDetailError(null);
    setDetailLoading(!detailCache.has(id));
    setOpenedId(id);
  };
  const backToList = () => setOpenedId(null);
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
  const removeInstalled = (pluginId: string) => {
    if (row && (row.phase === "checking" || row.phase === "saving")) return;
    setRow({ pluginId, phase: "saving" });
    void setCommodorePlugin(commodoreId, pluginId, false).then(() => setRow(null), (reason) => setRow({ pluginId, phase: "failed", code: codeOf(reason) }));
  };
  useEffect(() => {
    // 포커스가 BODY 로 빠져도 Esc 규칙은 유지된다. 다이얼로그의 onKeyDown 은 그때 이벤트를 받지 못한다.
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (dismissConfirm.current()) return;
      if (row?.phase === "trust") { setRow(null); return; }
      if (openedId) { backToList(); return; }
      onClose();
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [onClose, openedId, row]);
  const opened = openedId ? view?.plugins.find((entry) => entry.id === openedId) ?? null : null;
  const openedDetail = openedId ? detailCache.get(openedId) : undefined;

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
            <div className="commodore-palette-grid">
              {items.map((entry) => <PaletteCard key={entry.id} t={t} entry={entry} installed={installedSet.has(entry.id)} row={row?.pluginId === entry.id ? row : null} showTrust={openedId === null} onOpen={() => openDetail(entry.id)} onInstall={() => install(entry)} onTrust={(fresh) => save(entry.id, true, fresh)} onCancel={() => setRow(null)} />)}
            </div>
            {rest > 0 ? <p className="commodore-palette-more">{t("commodore.plugins.palette.more", { n: rest, marketplace: marketplace.name })}</p> : null}
          </section>
        ));

  return createPortal(
    <div className="commodore-palette-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className={`commodore-palette${phone ? " is-phone" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={opened ? detailTitleId : titleId}
        tabIndex={-1}
      >
        {opened ? (
          <PluginDetailView
            t={t}
            titleId={detailTitleId}
            entry={opened}
            detail={openedDetail}
            loading={detailLoading && !openedDetail}
            error={detailError}
            installed={installedSet.has(opened.id)}
            row={row?.pluginId === opened.id ? row : null}
            dismissConfirm={dismissConfirm}
            onFocusFallback={holdFocus}
            onBack={backToList}
            onClose={onClose}
            onInstall={() => install(opened)}
            onRemove={() => removeInstalled(opened.id)}
            onTrust={(fresh) => save(opened.id, true, fresh)}
            onCancel={() => setRow(null)}
          />
        ) : (
          <>
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
          </>
        )}
        <div ref={listRef} className="commodore-palette-list" hidden={opened !== null}>{body}</div>
        {opened ? null : (
          <div className="commodore-palette-foot">
            <span>{!browsing && pool.length > shown.length ? t("commodore.plugins.palette.truncated", { shown: shown.length, n: pool.length }) : hidden > 0 ? t("commodore.plugins.palette.hidden", { n: hidden }) : ""}</span>
            <button type="button" className="commodore-plugins-text" onClick={() => { onClose(); openSettingsSurface(MARKETPLACE_SETTINGS_ADDRESS); }}>{t("commodore.plugins.manage")}</button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function TrustPanel({ t, entry, onTrust, onCancel, trustRef }: {
  readonly t: T;
  readonly entry: PluginCatalogEntry;
  readonly onTrust: (entry: PluginCatalogEntry) => void;
  readonly onCancel: () => void;
  readonly trustRef?: Ref<HTMLButtonElement>;
}) {
  if (!entry.runs?.length) return null;
  const homepage = entry.homepage ? httpUrl(entry.homepage) : null;
  return (
    <div className="commodore-palette-trust" role="group" aria-label={t("commodore.plugins.trust.title")}>
      <p><strong>{t("commodore.plugins.trust.title")}</strong> {t("commodore.plugins.trust.body")}</p>
      <ul>{entry.runs.map((run, index) => <li key={index}><span>{t(run.kind === "hook" ? "commodore.plugins.trust.hook" : "commodore.plugins.trust.mcp", { label: run.label })}</span><code>{run.command}</code></li>)}</ul>
      <p className="commodore-palette-trust-source">
        <span>{t("commodore.plugins.trust.source", { marketplace: entry.marketplace })}</span>
        {homepage ? <a href={homepage} target="_blank" rel="noopener noreferrer">{t("commodore.plugins.homepage")}</a> : null}
      </p>
      <div className="commodore-palette-trust-actions">
        <button type="button" className="fc-btn fc-btn--secondary" onClick={onCancel}>{t("commodore.plugins.trust.cancel")}</button>
        <button ref={trustRef} type="button" className="fc-btn fc-btn--primary" onClick={() => onTrust(entry)}>{t("commodore.plugins.trust.confirm")}</button>
      </div>
    </div>
  );
}

/**
 * 팔레트 카드 — 설치 단추를 제외한 카드는 상세를 연다. Enter 는 그 단추의 기본 동작이다.
 * 신뢰 확인이 필요하면 카드가 한 줄 전체를 차지하며 펼치고 설명 전체를 보인다.
 */
function PaletteCard({ t, entry, installed, row, showTrust, onOpen, onInstall, onTrust, onCancel }: {
  readonly t: T;
  readonly entry: PluginCatalogEntry;
  readonly installed: boolean;
  readonly row: RowState | null;
  readonly showTrust: boolean;
  readonly onOpen: () => void;
  readonly onInstall: () => void;
  readonly onTrust: (entry: PluginCatalogEntry) => void;
  readonly onCancel: () => void;
}) {
  const shown = row?.entry ?? entry;
  const working = row?.phase === "checking" || row?.phase === "saving";
  const trusting = showTrust && row?.phase === "trust" && Boolean(shown.runs?.length);
  const trustRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (trusting) trustRef.current?.focus({ preventScroll: false }); }, [trusting]);
  const title = titleOf(shown, entry.name);
  const byline = [shown.displayName ? entry.name : null, shown.version ? `v${shown.version}` : null, shown.author ? t("commodore.plugins.byAuthor", { name: shown.author }) : null].filter(Boolean).join(" · ");
  const chips = shown.category || shown.components;
  return (
    <article className={`commodore-palette-card${trusting ? " is-open" : ""}`}>
      <button type="button" className="commodore-palette-open" data-plugin-id={entry.id} aria-label={t("commodore.plugins.detail.openAria", { plugin: title })} onClick={() => { if (!working && row?.phase !== "trust") onOpen(); }}>
        <span className="commodore-palette-card-head">
          <PluginTile name={title} iconId={shown.icon ? entry.id : undefined} size="card" />
          <span className="commodore-palette-card-title">
            <span className="commodore-palette-name">{title}</span>
            {byline ? <span className="commodore-palette-byline">{byline}</span> : null}
          </span>
        </span>
        {shown.description ? <span className={`commodore-palette-desc${trusting ? "" : " is-clamped"}`}>{shown.description}</span> : null}
        {chips ? <span className="commodore-plugins-meta">{shown.category ? <span className="commodore-plugins-comp">{shown.category}</span> : null}<Components t={t} components={shown.components} /></span> : null}
      </button>
      <span className="commodore-palette-action">
        {installed ? <span className="commodore-plugins-state is-done">{t("commodore.plugins.palette.installed")}</span>
          : row?.phase === "trust" ? null
            : <button type="button" className="fc-btn fc-btn--secondary commodore-palette-install" disabled={working} aria-label={t("commodore.plugins.palette.installAria", { plugin: title })} onClick={onInstall}>{working ? t("commodore.plugins.palette.checking") : t("commodore.plugins.palette.install")}</button>}
      </span>
      {row?.phase === "failed" && showTrust ? <span className="commodore-plugins-state is-failed" role="alert">{errorWord(t, row.code ?? "failed")}</span> : null}
      {trusting ? <TrustPanel t={t} entry={shown} onTrust={onTrust} onCancel={onCancel} trustRef={trustRef} /> : null}
    </article>
  );
}

const DETAIL_PARTS: readonly (readonly [keyof PluginContents, CommodoreMessageKey])[] = [
  ["skills", "commodore.plugins.detail.skills"],
  ["commands", "commodore.plugins.detail.commands"],
  ["agents", "commodore.plugins.detail.agents"],
  ["hooks", "commodore.plugins.detail.hooks"],
  ["mcp", "commodore.plugins.detail.mcp"],
];

function WebLink({ href, children }: { readonly href: string | undefined; readonly children: string }) {
  const safe = href ? httpUrl(href) : null;
  if (!safe) return null;
  return <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>;
}

/**
 * 팔레트 안의 상세. 카탈로그 필드는 바로 보이고, 구성 이름·실행 명령·README 는 상세 응답이 오면 채워진다.
 * 조회가 실패해도 카탈로그 필드는 남는다. README 는 정화된 markdown 이다.
 */
function PluginDetailView({ t, titleId, entry, detail, loading, error, installed, row, dismissConfirm, onFocusFallback, onBack, onClose, onInstall, onRemove, onTrust, onCancel }: {
  readonly t: T;
  readonly titleId: string;
  readonly entry: PluginCatalogEntry;
  readonly detail: PluginDetail | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly installed: boolean;
  readonly row: RowState | null;
  readonly dismissConfirm: { current: () => boolean };
  readonly onFocusFallback: () => void;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly onInstall: () => void;
  readonly onRemove: () => void;
  readonly onTrust: (entry: PluginCatalogEntry) => void;
  readonly onCancel: () => void;
}) {
  const backRef = useRef<HTMLButtonElement | null>(null);
  const trustRef = useRef<HTMLButtonElement | null>(null);
  const cancelRemoveRef = useRef<HTMLButtonElement | null>(null);
  const removeRef = useRef<HTMLButtonElement | null>(null);
  const confirmWasOpen = useRef(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const shown = detail ? { ...entry, ...detail } : row?.entry ? { ...entry, ...row.entry } : entry;
  const title = titleOf(shown, entry.name);
  const working = row?.phase === "checking" || row?.phase === "saving";
  const trusting = row?.phase === "trust" && Boolean((row.entry ?? shown).runs?.length);
  const trustEntry = row?.entry ?? shown;
  const readme = detail?.readme ?? "";
  const readmeHtml = useMemo(() => (readme ? pluginReadmeHtml(readme) : ""), [readme]);
  const parts = detail?.contents;
  const hasParts = DETAIL_PARTS.some(([key]) => (parts?.[key].length ?? 0) > 0);
  const runs = detail?.runs ?? entry.runs;
  const meta = [shown.version ? `v${shown.version}` : null, shown.author ? t("commodore.plugins.byAuthor", { name: shown.author }) : null, shown.category ?? null, shown.marketplace].filter(Boolean).join(" · ");
  useEffect(() => { backRef.current?.focus(); }, []);
  useEffect(() => { if (trusting) trustRef.current?.focus({ preventScroll: false }); }, [trusting]);
  useEffect(() => {
    dismissConfirm.current = () => {
      if (!confirmRemove) return false;
      setConfirmRemove(false);
      return true;
    };
    return () => { dismissConfirm.current = () => false; };
  }, [confirmRemove, dismissConfirm]);
  useEffect(() => {
    if (confirmRemove) {
      confirmWasOpen.current = true;
      cancelRemoveRef.current?.focus();
      return;
    }
    if (!confirmWasOpen.current) return;
    confirmWasOpen.current = false;
    if (removeRef.current) removeRef.current.focus();
    else onFocusFallback();
  }, [confirmRemove, onFocusFallback]);
  return (
    <div className="commodore-plugin-detail">
      <div className="commodore-plugin-detail-bar">
        <button ref={backRef} type="button" className="commodore-plugin-detail-back" onClick={onBack}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M6.5 2 L3.5 5 L6.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {t("commodore.plugins.detail.back")}
        </button>
        <button type="button" className="commodore-plugins-text" onClick={onClose}>{t("commodore.plugins.palette.close")}</button>
      </div>
      <div className="commodore-plugin-detail-scroll">
        <header className="commodore-plugin-detail-hero">
          <PluginTile name={title} iconId={shown.icon ? entry.id : undefined} size="detail" />
          <span className="commodore-plugin-detail-heading">
            <h2 id={titleId} className="commodore-plugin-detail-name">{title}</h2>
            {meta ? <p className="commodore-plugin-detail-meta">{meta}</p> : null}
          </span>
          <span className="commodore-plugin-detail-action">
            {trusting ? null : installed ? (
              confirmRemove ? (
                <span className="commodore-plugin-detail-confirm" role="alert">
                  <span>{t("commodore.plugins.removeConfirm", { plugin: title })}</span>
                  <button ref={cancelRemoveRef} type="button" className="commodore-plugins-text" onClick={() => setConfirmRemove(false)}>{t("commodore.plugins.removeCancel")}</button>
                  <button type="button" className="commodore-plugins-text is-danger" disabled={working} onClick={() => { setConfirmRemove(false); onRemove(); }}>{t("commodore.plugins.detail.remove")}</button>
                </span>
              ) : <button ref={removeRef} type="button" className="fc-btn fc-btn--secondary" onClick={() => setConfirmRemove(true)}>{t("commodore.plugins.detail.remove")}</button>
            ) : (
              <button type="button" className="fc-btn fc-btn--secondary commodore-palette-install" disabled={working} aria-label={t("commodore.plugins.palette.installAria", { plugin: title })} onClick={onInstall}>{working ? t("commodore.plugins.palette.checking") : t("commodore.plugins.palette.install")}</button>
            )}
          </span>
        </header>
        {shown.description ? <p className="commodore-plugin-detail-desc">{shown.description}</p> : null}
        {shown.homepage || shown.repository || shown.license || shown.keywords?.length ? (
          <div className="commodore-plugin-detail-facts">
            {shown.homepage || shown.repository ? (
              <p className="commodore-plugin-detail-links">
                <WebLink href={shown.homepage}>{t("commodore.plugins.homepage")}</WebLink>
                <WebLink href={shown.repository}>{t("commodore.plugins.detail.repository")}</WebLink>
              </p>
            ) : null}
            {shown.license ? <span className="commodore-plugins-comp">{t("commodore.plugins.detail.license", { name: shown.license })}</span> : null}
            {shown.keywords?.length ? (
              <span className="commodore-plugin-detail-keywords">
                <span className="commodore-plugin-detail-kicker">{t("commodore.plugins.detail.keywords")}</span>
                {shown.keywords.map((word, index) => <span key={`${word}-${index}`} className="commodore-plugins-comp">{word}</span>)}
              </span>
            ) : null}
          </div>
        ) : null}
        {loading ? <p className="commodore-plugin-detail-status" role="status">{t("commodore.plugins.detail.loading")}</p> : null}
        {error ? <p className="commodore-plugin-detail-status is-failed" role="alert">{t("commodore.plugins.detail.failed")}</p> : null}
        {row?.phase === "failed" ? <p className="commodore-plugin-detail-status is-failed" role="alert">{errorWord(t, row.code ?? "failed")}</p> : null}
        {trusting ? <TrustPanel t={t} entry={trustEntry} onTrust={onTrust} onCancel={onCancel} trustRef={trustRef} /> : null}
        {hasParts && parts ? (
          <section className="commodore-plugin-detail-included" aria-label={t("commodore.plugins.detail.included")}>
            <h3>{t("commodore.plugins.detail.included")}</h3>
            {DETAIL_PARTS.map(([key, label]) => parts[key].length ? (
              <div key={key} className="commodore-plugin-detail-group">
                <h4>{t(label)}</h4>
                <span className="commodore-plugins-meta">{parts[key].map((part, index) => <span key={`${part}-${index}`} className="commodore-plugins-comp">{part}</span>)}</span>
              </div>
            ) : null)}
          </section>
        ) : null}
        {runs && runs.length > 0 && !trusting ? (
          <section className="commodore-plugin-detail-runs" aria-label={t("commodore.plugins.detail.runs")}>
            <h3>{t("commodore.plugins.detail.runs")}</h3>
            <ul>{runs.map((run, index) => <li key={index}><span>{t(run.kind === "hook" ? "commodore.plugins.trust.hook" : "commodore.plugins.trust.mcp", { label: run.label })}</span><code>{run.command}</code></li>)}</ul>
          </section>
        ) : null}
        {readmeHtml ? (
          <section className="commodore-plugin-detail-readme" aria-label={t("commodore.plugins.detail.readme")}>
            <h3>{t("commodore.plugins.detail.readme")}</h3>
            {detail?.readmeTruncated ? <p className="commodore-plugin-detail-status">{t("commodore.plugins.detail.readmeTruncated")}</p> : null}
            <div className="markdown-body" dangerouslySetInnerHTML={{ __html: readmeHtml }} />
          </section>
        ) : null}
      </div>
    </div>
  );
}

const SearchGlyph = () => (
  <svg className="commodore-palette-search-glyph" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </svg>
);
