import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { isFleetMobileShell, openInDefaultOsBrowser } from "@fleet-console/link/core";
import { createPortal } from "react-dom";
import type { Translate } from "@fleet-console/i18n";
import "@fleet-console/markdown/styles.css";
import { httpUrl, pluginReadmeHtml } from "./plugin-readme.js";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { defineSettingsSection, SettingsGroup, SettingsItem, SettingsToggle, useMobileSettingsHost } from "../../settings/client/preferences-context.js";
import { openSettingsSurface } from "../../settings/client/settings-door.js";
import { effectiveCommodorePlugins, pluginIconPath, splitPluginId, type GlobalPluginReplacement, type CommodorePluginAuthView, type PluginServerAuthView, type MarketplaceErrorCode, type MarketplaceView, type PluginCatalogEntry, type PluginCatalogView, type PluginComponents, type PluginContents, type PluginDetail } from "../shared/contracts/plugins.js";
import { postCommodorePlugins, setCommodorePlugin, useCommodore, useCommodoreEnabled } from "./commodore-state.js";
import { commodoreName } from "./commodore-name.js";
import { loadGlobalPlugins, setGlobalPlugin, useGlobalPlugins } from "./global-plugins.js";
import { useMongleLook } from "../../workspace/client/avatar-events.js";
import { commodoreAvatarKey, mongleBase } from "../../workspace/shared/avatars.js";
import { getT, type CommodoreMessageKey } from "./i18n/index.js";
import "./commodore-routines.css";
import "./global-plugins.css";

type T = Translate<CommodoreMessageKey>;

/**
 * 사령관 플러그인 — Console 설정의 「마켓플레이스」 섹션(등록부, 사령관들이 함께 본다)과 사령관 설정 칸의 「플러그인」 목록·추가
 * 팔레트(사령관마다 고른다). 등록부·카탈로그는 Console 전역 하나라 이 모듈이 한 벌을 쥐고 두 표면이 함께 읽는다. 사령관이 고른
 * 목록은 사령관 상태(`state.plugins`)가 진다 — 설치는 누르는 즉시, 제거는 한 번 더 확인한 뒤에 저장하고, 적용은 다음 턴(새 세션)부터다.
 */

const MARKETPLACE_SECTION_ID = "marketplaces";
/** 설정 주소 id — 코어가 feature id 를 앞에 붙인다(`pluginSettingsSectionId`). */
const MARKETPLACE_SETTINGS_ADDRESS = `commodore:${MARKETPLACE_SECTION_ID}`;
/** 검색어 없이 마켓플레이스마다 먼저 보이는 수 — 공식 마켓플레이스만 수백 개라 나머지는 검색·거르기로 찾는다(묶음 머리가 전체 수를 말한다). */
const PREVIEW_PER_MARKETPLACE = 6;
/** 검색·거르기 결과의 상한. */
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

const ERROR_CODES: ReadonlySet<MarketplaceErrorCode> = new Set<MarketplaceErrorCode>(["invalid_source", "duplicate", "preset_name", "reserved_name", "name_taken", "not_found", "auth_failed", "no_manifest", "fetch_failed", "preset_locked", "limit", "disabled", "plugin_not_found", "install_failed", "update_failed", "source_missing", "trust_required", "unavailable", "cli_unavailable"]);
/** 행 메타 줄에 붙이는 짧은 업데이트 실패 이유. 짧게 말할 수 없는 코드는 이유 없이 "업데이트 실패"만 둔다. */
const UPDATE_REASONS: Readonly<Record<string, CommodoreMessageKey>> = {
  source_missing: "commodore.plugins.update.reason.source_missing",
  not_found: "commodore.plugins.update.reason.not_found",
  plugin_not_found: "commodore.plugins.update.reason.not_found",
  disabled: "commodore.plugins.update.reason.disabled",
  cli_unavailable: "commodore.plugins.update.reason.cli_unavailable",
};
function updateReason(t: T, code: string): string | null {
  const key = UPDATE_REASONS[code];
  return key ? t(key) : null;
}

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
function PluginTile({ name, iconId, size }: { readonly name: string; readonly iconId?: string | undefined; readonly size: "row" | "card" | "market" | "phone" | "detail" | "summary" }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (iconId && broken !== iconId) {
    return (
      <span className={`commodore-tile is-${size} has-icon`} aria-hidden="true">
        <img src={pluginIconPath(iconId)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(iconId)} />
      </span>
    );
  }
  return <span className={`commodore-tile is-${size}`} aria-hidden="true">{size === "summary" ? Array.from(name.trim())[0]?.toLocaleUpperCase() || "?" : initialsOf(name)}</span>;
}

const titleOf = (entry: PluginCatalogEntry | undefined, fallback: string): string => entry?.displayName ?? fallback;

function GlobalPluginMark() {
  return <svg className="commodore-global-mark" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.2 14 5.3 8 8.4 2 5.3Z" /><path d="M2.4 8.2 8 11.1l5.6-2.9M2.4 11 8 13.9l5.6-2.9" /></svg>;
}

let globalTrigger: HTMLElement | null = null;
const globalPaletteListeners = new Set<() => void>();
const subscribeGlobalPalette = (listener: () => void) => { globalPaletteListeners.add(listener); return () => { globalPaletteListeners.delete(listener); }; };
const useGlobalPalette = () => useSyncExternalStore(subscribeGlobalPalette, () => globalTrigger !== null, () => false);
function openGlobalPalette(trigger: HTMLElement): void {
  globalTrigger = trigger;
  for (const listener of globalPaletteListeners) listener();
}
function closeGlobalPalette(): void {
  const trigger = globalTrigger;
  globalTrigger = null;
  for (const listener of globalPaletteListeners) listener();
  trigger?.focus({ preventScroll: true });
}

/** 팔레트는 footer·사령관 설정의 수명과 독립적으로 한 번만 선다. */
export function GlobalPluginsHost() {
  const t = getT(useConsoleLocale());
  const open = useGlobalPalette();
  const global = useGlobalPlugins();
  useLiveCatalog(open);
  return open ? <PluginPalette t={t} installed={global.view?.plugins ?? []} onClose={closeGlobalPalette} /> : null;
}

export function GlobalPluginsEntry() {
  const t = getT(useConsoleLocale());
  const global = useGlobalPlugins();
  const { view } = useLiveCatalog(true);
  const open = useGlobalPalette();
  const trigger = useRef<HTMLButtonElement>(null);
  const [tip, setTip] = useState<DOMRect | null>(null);
  const plugins = global.view?.plugins ?? [];
  const shown = plugins.slice(0, plugins.length > 3 ? 2 : 3);
  const label = t("commodore.plugins.global.countAria", { n: plugins.length });
  const showTip = () => setTip(trigger.current?.closest(".is-compact") ? trigger.current.getBoundingClientRect() : null);
  return <>
    <button ref={trigger} type="button" className="commodore-global-pill" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={(event) => { setTip(null); openGlobalPalette(event.currentTarget); }} onPointerEnter={showTip} onPointerLeave={() => setTip(null)} onFocus={showTip} onBlur={() => setTip(null)}>
      <span className="commodore-global-pill-label">{t("commodore.plugins.global.title")}</span>
      <span className="commodore-global-pill-tiles" aria-hidden="true">{shown.map((id) => {
        const entry = view?.plugins.find((plugin) => plugin.id === id);
        return <PluginTile key={id} name={titleOf(entry, splitPluginId(id).plugin)} iconId={entry?.icon ? id : undefined} size="summary" />;
      })}{plugins.length > 3 ? <span className="commodore-tile is-summary is-more">+{plugins.length - 2}</span> : plugins.length === 0 ? <span className="commodore-global-plus">＋</span> : null}</span>
      <svg className="commodore-global-pill-glyph" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1.6" /><rect x="11" y="3" width="6" height="6" rx="1.6" /><rect x="3" y="11" width="6" height="6" rx="1.6" /><path d="M14 11.2v5.6M11.2 14h5.6" strokeLinecap="round" /></svg>
      {plugins.length ? <span className="commodore-global-pill-count" aria-hidden="true">{plugins.length}</span> : null}
    </button>
    {tip && !open ? createPortal(<span className="commodore-global-pill-tip" role="tooltip" style={{ left: tip.right + 10, top: tip.top + tip.height / 2 }}>{label}</span>, document.body) : null}
  </>;
}

function ReplacementHint({ t, replacement, id }: { readonly t: T; readonly replacement: GlobalPluginReplacement | undefined; readonly id: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const row = anchor.current?.parentElement;
    if (!row || !replacement) return;
    const show = () => setRect(row.getBoundingClientRect());
    const hide = () => setRect(null);
    const reposition = () => setRect((current) => current ? row.getBoundingClientRect() : null);
    row.addEventListener("pointerenter", show); row.addEventListener("pointerleave", hide);
    row.addEventListener("focusin", show); row.addEventListener("focusout", hide);
    window.addEventListener("scroll", reposition, true); window.addEventListener("resize", reposition);
    return () => { row.removeEventListener("pointerenter", show); row.removeEventListener("pointerleave", hide); row.removeEventListener("focusin", show); row.removeEventListener("focusout", hide); window.removeEventListener("scroll", reposition, true); window.removeEventListener("resize", reposition); };
  }, [replacement]);
  if (!replacement) return null;
  return <><span ref={anchor} hidden />{createPortal(<span id={id} role="tooltip" className="commodore-plugins-replacement-tip" hidden={!rect} style={rect ? { left: Math.max(12, Math.min(rect.left, window.innerWidth - 272)), top: rect.top - 8 } : undefined}>{t(replacement.reason === "same-id" ? "commodore.plugins.global.sameId" : "commodore.plugins.global.sameName", { marketplace: splitPluginId(replacement.by).marketplace })}</span>, document.body)}</>;
}

function GlobalPluginGroup({ t, plugins, entries, phone }: { readonly t: T; readonly plugins: readonly string[]; readonly entries: ReadonlyMap<string, PluginCatalogEntry>; readonly phone: boolean }) {
  if (!plugins.length) return null;
  return <div className="commodore-global-group">
    <p className="commodore-plugins-group-head"><GlobalPluginMark /><span>{t("commodore.plugins.global.group")}</span><button type="button" className="commodore-plugins-text" onClick={(event) => openGlobalPalette(event.currentTarget)}>{t("commodore.plugins.global.manage")}</button></p>
    <ul className={`commodore-plugins-list${phone ? " is-phone" : ""}`}>
      {plugins.map((pluginId) => {
        const { plugin, marketplace } = splitPluginId(pluginId);
        const entry = entries.get(pluginId);
        return <li key={pluginId} className="commodore-plugins-row commodore-global-row">
          <span className="commodore-global-tile"><PluginTile name={titleOf(entry, plugin)} iconId={entry?.icon ? pluginId : undefined} size={phone ? "phone" : "row"} /><span className="commodore-global-badge"><GlobalPluginMark /></span></span>
          <span className="commodore-plugins-name">{titleOf(entry, plugin)}<span className="commodore-plugins-at">@{marketplace}</span></span>
          <span className="commodore-plugins-version">{rowVersion(entry?.version)}</span>
          <span className="commodore-plugins-meta"><Components t={t} components={entry?.components} /></span>
        </li>;
      })}
    </ul>
  </div>;
}

/**
 * 마켓플레이스 타일은 켜기/끄기 단추다 — 켜지면 brass, 꺼지면 무채색. 이름은 「{이름} 켜기」로 고정하고 상태는 aria-pressed 가 말한다.
 * 카드·폰 행이 같은 단추를 쓰고, 상태 글자(「꺼짐」)는 따로 두지 않는다.
 */
function MarketplaceGlyph({ t, marketplace, act, size }: { readonly t: T; readonly marketplace: MarketplaceView; readonly act: Act; readonly size: "market" | "phone" }) {
  return (
    <button
      type="button"
      className={`commodore-tile is-${size} commodore-market-glyph`}
      aria-pressed={marketplace.enabled}
      aria-label={t("commodore.marketplaces.enableAria", { name: marketplace.name })}
      title={t(marketplace.enabled ? "commodore.marketplaces.turnOff" : "commodore.marketplaces.turnOn")}
      onClick={() => enableMarketplace(marketplace, act)(!marketplace.enabled)}
    >{initialsOf(marketplace.name)}</button>
  );
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
      >
        {list(presets)}
      </SettingsGroup>
      <SettingsGroup ariaLabel={t("commodore.marketplaces.custom")} title={t("commodore.marketplaces.custom")}>
        {customs.length ? list(customs) : <p className="global-settings-help">{t("commodore.marketplaces.customEmpty")}</p>}
        <MarketplaceAdd t={t} />
      </SettingsGroup>
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
      : marketplace.enabled && marketplace.updatedAt ? <span>{t("commodore.marketplaces.updatedAt", { time: updatedWord(marketplace.updatedAt) })}</span> : null;
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
    </span>
  );
  const locator = <span className="commodore-plugins-locator">{marketplace.locator}{marketplace.ref ? ` @${marketplace.ref}` : ""}</span>;
  return { cardSummary, failure, confirm, actions, locator };
}

/**
 * 데스크톱 마켓플레이스 카드 — 머리(타일·이름·출처), 설명 한 줄, 아래 칸(수·상태·행동). 마켓플레이스에는 아이콘 필드가 없어
 * 타일은 언제나 이니셜이고 켜기/끄기 단추를 겸한다(`MarketplaceGlyph`). 꺼진 카드는 타일 색과 글자 옅어짐으로 말한다.
 */
function MarketplaceCard({ t, marketplace, act }: { readonly t: T; readonly marketplace: MarketplaceView; readonly act: Act }) {
  const { cardSummary, failure, confirm, actions, locator } = useMarketplaceControls(t, marketplace, act);
  return (
    <article className={`commodore-market-card${marketplace.enabled ? "" : " is-off"}`} aria-label={marketplace.name}>
      <div className="commodore-market-card-head">
        <MarketplaceGlyph t={t} marketplace={marketplace} act={act} size="market" />
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

/** 폰 행의 짧은 상태 — 긴 실패 이유는 상세가 말하고, 켜짐/꺼짐은 타일 단추가 말한다. */
function shortStatus(t: T, marketplace: MarketplaceView) {
  if (marketplace.status === "syncing") return <span className="commodore-plugins-state is-syncing">{t("commodore.marketplaces.syncing")}</span>;
  if (marketplace.status === "failed") return <span className="commodore-plugins-state is-failed">{t("commodore.marketplaces.failedShort")}</span>;
  if (!marketplace.enabled) return null;
  return marketplace.updatedAt ? <span>{t("commodore.marketplaces.updatedAt", { time: updatedWord(marketplace.updatedAt) })}</span> : null;
}

/**
 * 폰 마켓플레이스 행 — 타일 단추·이름·「플러그인 N개 · 상태」. 모바일 설정 행은 `<label>`이라 행을 누르면 첫 컨트롤이 눌린다.
 * 켜기/끄기와 상세 열기를 한 행에 같이 두려고 행은 `div`로 두고, 행 전체를 덮는 열기 단추 위에 타일 단추만 올려 세운다.
 */
function MarketplaceRow({ t, marketplace, act, onOpen }: { readonly t: T; readonly marketplace: MarketplaceView; readonly act: Act; readonly onOpen: () => void }) {
  const status = shortStatus(t, marketplace);
  return (
    <div className={`fc-settings-row is-mobile commodore-market-row${marketplace.enabled ? "" : " is-off"}`}>
      <button type="button" className="commodore-market-row-open" aria-haspopup="dialog" aria-label={t("commodore.marketplaces.detail.openAria", { name: marketplace.name })} onClick={onOpen} />
      <span className="fc-settings-row__icon commodore-market-row-glyph"><MarketplaceGlyph t={t} marketplace={marketplace} act={act} size="phone" /></span>
      <span className="fc-settings-row__copy">
        <span className="fc-settings-row__label">{marketplace.name}</span>
        <span className="fc-settings-row__hint">{t("commodore.marketplaces.count", { n: marketplace.pluginCount })}{status ? <> · {status}</> : null}</span>
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
    : marketplace.status === "failed" ? <span className="commodore-plugins-state is-failed">{t("commodore.marketplaces.failed", { reason: errorWord(t, marketplace.error ?? "fetch_failed") })}</span> : null;
  return (
    <div className="commodore-market-detail">
      {failure ? <p className="global-settings-error" role="alert">{failure}</p> : null}
      <SettingsGroup ariaLabel={t("commodore.marketplaces.detail.about")}>
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

/**
 * 이 사령관이 고른 플러그인의 인증 상태. 브라우저에서 진행 중인 서버가 있는 동안 몇 초마다 다시 읽는다. 상태 조회와 동작 응답은
 * 보낸 순서대로 번호를 받고, 더 늦게 보낸 요청의 응답이 이미 왔으면 먼저 보낸 요청의 응답은 버린다 — 키를 저장하기 전에
 * 떠난 조회가 저장 뒤에 도착해 옛 결과로 덮지 않게.
 */
function usePluginAuth(commodoreId: string, installedKey: string) {
  const [view, setView] = useState<CommodorePluginAuthView | null>(null);
  const [round, setRound] = useState(0);
  const sent = useRef(0);
  const applied = useRef(0);
  /** 요청을 보내기 직전에 부른다. 돌려준 함수로 그 응답을 반영한다. */
  const track = () => {
    const seq = ++sent.current;
    return (next: CommodorePluginAuthView) => { if (seq < applied.current) return; applied.current = seq; setView(next); };
  };
  useEffect(() => {
    if (!commodoreId || !installedKey) { setView(null); return; }
    let live = true;
    const apply = track();
    void postCommodorePlugins<CommodorePluginAuthView>("/commodore/plugins/auth/status", { commodoreId })
      .then((next) => { if (live) apply(next); }, () => undefined);
    return () => { live = false; };
  }, [commodoreId, installedKey, round]);
  const pending = view?.plugins.some((plugin) => plugin.servers.some((server) => server.state === "pending")) ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setRound((n) => n + 1), AUTH_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [pending, view]);
  return { view, track };
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

interface MenuItem { readonly id: string; readonly label: string; readonly version?: string; readonly run: () => void }
type PluginUpdateState = { readonly kind: "updating" | "done" } | { readonly kind: "failed"; readonly code: string };
type UpdateTrust = { readonly pluginId: string; readonly version: string; readonly runs: NonNullable<PluginCatalogEntry["runs"]> };
const isCommitVersion = (version: string): boolean => /^[0-9a-f]{12}$/.test(version);
const rowVersion = (version: string | undefined): string => version && !isCommitVersion(version) ? `v${version.replace(/^v/, "")}` : "";
const menuVersion = (t: T, version: string | undefined): string => version && isCommitVersion(version) ? t("commodore.plugins.commit", { sha: version.slice(0, 7) }) : rowVersion(version);

/** 오류 응답도 신뢰 확인에 쓸 원문만 읽는다. 불완전한 상세로는 trusted 요청을 만들지 않는다. */
function updateTrustOf(error: unknown, pluginId: string): UpdateTrust | null {
  if (codeOf(error) !== "trust_required" || !(error instanceof Error) || !("details" in error)) return null;
  const details = error.details as { version?: unknown; runs?: unknown } | null;
  if (!details || typeof details.version !== "string" || !Array.isArray(details.runs) || !details.runs.length) return null;
  const runs: NonNullable<PluginCatalogEntry["runs"]> = details.runs.filter((run): run is NonNullable<PluginCatalogEntry["runs"]>[number] =>
    run !== null && typeof run === "object" && (run.kind === "hook" || run.kind === "mcp") && typeof run.label === "string" && typeof run.command === "string");
  return runs.length === details.runs.length ? { pluginId, version: details.version, runs } : null;
}
type InlineForm = { readonly pluginId: string; readonly kind: "key"; readonly names: readonly string[] } | { readonly pluginId: string; readonly kind: "callback"; readonly server: string };

/**
 * 사령관 설정 칸에서 Theater 목록 바로 아래 — 이 사령관이 고른 플러그인. 상태는 메타 줄의 한 마디로만 보이고, 인증·키·제거는
 * 행의 메뉴(클릭·키보드·우클릭, 폰은 탭·길게 누르기 → 아래 시트)에서 한다 — 루틴 목록과 같은 메뉴다. 제거는 메뉴에서
 * 한 번 더 눌러 확인하고, 적용은 다음 턴부터라 칸 아래 한 줄이 그 시점을 말한다.
 */
export function CommodorePlugins({ t, commodoreId, phone = false }: { readonly t: T; readonly commodoreId: string; readonly phone?: boolean }) {
  const { view } = useCommodore(commodoreId);
  const { view: catalogView } = useLiveCatalog(Boolean(commodoreId));
  const global = useGlobalPlugins();
  const look = useMongleLook(commodoreAvatarKey(commodoreId));
  const identityStyle = { "--commodore-plugin-identity": `var(--id-${look.tone ?? mongleBase(look.base).tone})` } as CSSProperties;
  const replacementId = useId();
  const [palette, setPalette] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ readonly pluginId: string; readonly x: number; readonly y: number; readonly trigger: HTMLElement; readonly anchored: boolean } | null>(null);
  const [armed, setArmed] = useState(false);
  const [updates, setUpdates] = useState<Readonly<Record<string, PluginUpdateState>>>({});
  const [trust, setTrust] = useState<UpdateTrust | null>(null);
  const [authRevision, setAuthRevision] = useState(0);
  const [form, setForm] = useState<InlineForm | null>(null);
  /** 모바일 셸에서 받은 인증 주소 — 셸은 누름 없이 연 창을 OS 브라우저로 넘기지 않아, 행에서 한 번 누르게 한다. */
  const [ready, setReady] = useState<{ readonly pluginId: string; readonly server: string; readonly url: string } | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const installed = view?.state.plugins ?? [];
  const effective = effectiveCommodorePlugins(global.view?.plugins ?? [], installed);
  const replacements = new Map(effective.replaced.map((replacement) => [replacement.pluginId, replacement]));
  const auth = usePluginAuth(commodoreId, effective.effective.length ? `${effective.effective.join("\n")}\n${authRevision}` : "");
  const cancelPress = () => { if (press.current) clearTimeout(press.current.timer); press.current = null; };
  const closeMenu = (focus = true) => { if (focus) menu?.trigger.focus({ preventScroll: true }); setMenu(null); setArmed(false); setTrust(null); };
  const openMenu = (pluginId: string, trigger: HTMLElement, x: number, y: number, anchored = false) => { cancelPress(); setArmed(false); setTrust(null); setMenu({ pluginId, trigger, x, y, anchored }); };
  const toggleMenu = (pluginId: string, trigger: HTMLElement) => {
    if (menu?.pluginId === pluginId) { closeMenu(); return; }
    const rect = trigger.getBoundingClientRect();
    openMenu(pluginId, trigger, rect.left, rect.bottom + 4, true);
  };
  useEffect(() => () => cancelPress(), []);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !menu.trigger.contains(event.target as Node)) { menu.trigger.focus({ preventScroll: true }); setMenu(null); setArmed(false); setTrust(null); } };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); menu.trigger.focus({ preventScroll: true }); setMenu(null); setArmed(false); setTrust(null);
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
      const top = menu.anchored && menu.y + rect.height > window.innerHeight - 16 ? menu.trigger.getBoundingClientRect().top - rect.height - 4 : menu.y;
      node.style.top = `${Math.max(16, Math.min(top, window.innerHeight - rect.height - 16))}px`;
    }
    (node.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? node).focus({ preventScroll: true });
  }, [menu, phone, trust, busy]);
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
    const apply = auth.track();
    const { view: next } = await postCommodorePlugins<{ readonly view: CommodorePluginAuthView }>("/commodore/plugins/auth/action", { commodoreId, pluginId, server, action });
    apply(next);
  });
  const startAuth = (pluginId: string, server: string) => {
    if (busy) return;
    // 모바일 셸(Android WebView·WKWebView)은 사람의 누름이 이끈 열기만 OS 브라우저로 넘긴다. 응답을 기다린 뒤에는 누름이
    // 남지 않으므로, 빈 탭을 미리 열지 않고 받은 주소를 행의 「브라우저에서 열기」로 건넨다.
    const shell = isFleetMobileShell();
    const open = shell ? null : prepareExternalWindow();
    setBusy(pluginId); setFailure(null); setReady(null);
    const apply = auth.track();
    void postCommodorePlugins<{ readonly authUrl?: string; readonly view: CommodorePluginAuthView }>("/commodore/plugins/auth/action", { commodoreId, pluginId, server, action: "start" })
      .then(({ authUrl, view: next }) => { apply(next); if (open) open(authUrl ?? null); else if (authUrl) setReady({ pluginId, server, url: authUrl }); }, (error) => { open?.(null); setFailure(errorWord(t, codeOf(error))); })
      .finally(() => setBusy(null));
  };
  const setKeys = (pluginId: string, values: readonly (readonly [string, string | null])[]) => run(pluginId, async () => {
    for (const [name, value] of values) {
      const apply = auth.track();
      apply((await postCommodorePlugins<{ readonly view: CommodorePluginAuthView }>("/commodore/plugins/key", { commodoreId, pluginId, name, value })).view);
    }
    setForm(null);
  });
  const submitCallback = (pluginId: string, server: string, callbackUrl: string) => run(pluginId, async () => {
    const apply = auth.track();
    const { view: next } = await postCommodorePlugins<{ readonly view: CommodorePluginAuthView }>("/commodore/plugins/auth/callback", { commodoreId, pluginId, server, callbackUrl });
    apply(next);
    setForm(null);
  });
  /** reviewed 는 사람이 확인 화면에서 본 버전과 명령이다 — 서버는 받은 것이 그와 같을 때만 신뢰한다. */
  const update = (pluginId: string, reviewed?: { readonly version: string; readonly runs: UpdateTrust["runs"] }) => {
    if (busy) return;
    setBusy(pluginId); setTrust(null);
    setUpdates((current) => ({ ...current, [pluginId]: { kind: "updating" } }));
    void postCommodorePlugins<{ readonly outcome: "updated" | "up_to_date"; readonly oldVersion: string; readonly newVersion: string; readonly view: PluginCatalogView }>("/commodore/plugins/update", { pluginId, ...(reviewed ? { trusted: true, version: reviewed.version, runs: reviewed.runs } : {}) })
      .then(({ view: next }) => {
        invalidatePluginDetails();
        setCatalog({ view: next, error: null });
        setAuthRevision((revision) => revision + 1);
        setUpdates((current) => ({ ...current, [pluginId]: { kind: "done" } }));
        if (menuRef.current?.dataset.pluginId === pluginId) closeMenu();
      }, (error) => {
        setUpdates((current) => ({ ...current, [pluginId]: { kind: "failed", code: codeOf(error) } }));
        const required = updateTrustOf(error, pluginId);
        // 신뢰 확인은 같은 메뉴에서 이어 가고, 그 밖의 실패는 메뉴를 닫아 행의 실패 글자가 보이게 한다.
        if (required) setTrust(required);
        else if (menuRef.current?.dataset.pluginId === pluginId) closeMenu();
      }).finally(() => setBusy(null));
  };
  const updateMark = (entry: PluginCatalogEntry | undefined, pluginId: string) => {
    const state = updates[pluginId];
    if (state?.kind === "updating") return <span className="commodore-plugins-state is-syncing" role="status">{t("commodore.plugins.update.pending")}</span>;
    if (state?.kind === "failed") { const reason = updateReason(t, state.code); return <span className="commodore-plugins-state is-failed" role="alert">{reason ? t("commodore.plugins.update.failed", { reason }) : t("commodore.plugins.update.failedPlain")}</span>; }
    if (state?.kind === "done") return <span className="commodore-plugins-state is-done" role="status">{t("commodore.plugins.update.done")}</span>;
    return entry?.latestVersion ? <span className="commodore-plugins-state is-update">{isCommitVersion(entry.latestVersion) ? t("commodore.plugins.update.available") : t("commodore.plugins.update.version", { version: entry.latestVersion })}</span> : null;
  };
  /** 상태별 항목. 서버가 여럿이면 서버 이름을 붙인다. 원격 기기에서 진행 중이면 돌아온 주소를 옮겨 붙일 수 있다. */
  const itemsOf = (pluginId: string): MenuItem[] => {
    const servers = authOf.get(pluginId) ?? [];
    const oauth = servers.filter((server) => server.mode === "oauth");
    const named = oauth.length > 1;
    const items: MenuItem[] = [];
    const entry = entries.get(pluginId);
    if (entry?.latestVersion || updates[pluginId]?.kind === "failed") {
      const version = entry?.latestVersion;
      const runs = entry?.latestRuns;
      items.push({ id: "update", label: t(updates[pluginId]?.kind === "failed" ? "commodore.plugins.update.retry" : runs?.length ? "commodore.plugins.update.review" : "commodore.plugins.update.action"), ...(version ? { version: isCommitVersion(version) ? menuVersion(t, version) : version } : {}), run: () => {
        if (version && runs?.length) setTrust({ pluginId, version, runs });
        else update(pluginId);
      } });
    }
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
  const note = installed.length === 0 ? t("commodore.plugins.empty") : null;
  const globalGroup = <GlobalPluginGroup t={t} plugins={global.view?.plugins ?? []} entries={entries} phone={phone} />;
  const ownHeading = global.view?.plugins.length ? <p className="commodore-plugins-group-head">{t("commodore.plugins.global.own")}</p> : null;
  const rows = installed.map((pluginId) => {
    const { plugin, marketplace } = splitPluginId(pluginId);
    const entry = entries.get(pluginId);
    const source = marketplaces.get(marketplace);
    const mark = catalogView && !source?.enabled ? <span className="commodore-plugins-state is-warn">{t("commodore.plugins.marketplaceOff")}</span>
      : catalogView && !entry ? <span className="commodore-plugins-state">{t("commodore.plugins.notListed")}</span> : authMark(t, authOf.get(pluginId));
    return { pluginId, plugin, title: titleOf(entry, plugin), marketplace, entry, replacement: replacements.get(pluginId), mark: <>{updateMark(entry, pluginId)}{mark}</> };
  });
  const rowHandlers = (pluginId: string) => ({
    tabIndex: 0,
    "aria-haspopup": phone ? "dialog" as const : "menu" as const,
    "aria-expanded": menu?.pluginId === pluginId,
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => { if ((event.target as HTMLElement).closest("form, button, a, input")) return; event.preventDefault(); openMenu(pluginId, event.currentTarget, event.clientX, event.clientY); },
    onClick: (event: ReactMouseEvent<HTMLElement>) => { if (!(event.target as HTMLElement).closest("form, button, a, input")) toggleMenu(pluginId, event.currentTarget); },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (["Enter", " ", "ContextMenu"].includes(event.key) || (event.shiftKey && event.key === "F10")) { event.preventDefault(); toggleMenu(pluginId, event.currentTarget); }
    },
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse" || event.button !== 0 || (event.target as HTMLElement).closest("form, button, a, input")) return;
      cancelPress(); suppressClick.current = false;
      const trigger = event.currentTarget; const { clientX: x, clientY: y } = event;
      press.current = { x, y, timer: setTimeout(() => { suppressClick.current = true; openMenu(pluginId, trigger, x, y); }, 500) };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => { if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 6) cancelPress(); },
    onPointerUp: cancelPress, onPointerCancel: cancelPress, onPointerLeave: cancelPress,
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } },
  });
  const readyFor = (pluginId: string) => ready?.pluginId === pluginId && authOf.get(pluginId)?.some((row) => row.server === ready.server && row.state === "pending") ? ready : null;
  /**
   * 모바일 셸에서 받은 인증 주소를 여는 글자 버튼 — 메타 줄의 상태 글자 바로 옆이다. 누름은 행의 길게 누르기·메뉴로 번지지 않는다.
   */
  const openNow = (pluginId: string) => {
    const found = readyFor(pluginId);
    if (!found) return null;
    const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
    return <button type="button" className="commodore-plugins-text is-meta"
      onPointerDown={(event) => { cancelPress(); suppressClick.current = false; event.stopPropagation(); }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={stop}
      onClick={(event) => { event.stopPropagation(); openInDefaultOsBrowser(found.url); setReady(null); }}>{t("commodore.plugins.auth.openBrowser")}</button>;
  };
  const inline = (pluginId: string, title: string) => form?.pluginId === pluginId
    ? form.kind === "key"
      ? <KeyForm key={`key:${pluginId}`} t={t} plugin={title} names={form.names} busy={busy !== null} phone={phone} onCancel={() => setForm(null)} onSave={(values) => setKeys(pluginId, values)} />
      : <CallbackForm key={`callback:${pluginId}:${form.server}`} t={t} server={form.server} busy={busy !== null} phone={phone} onCancel={() => setForm(null)} onSave={(url) => submitCallback(pluginId, form.server, url)} />
    : null;
  const selected = menu ? rows.find((row) => row.pluginId === menu.pluginId) : undefined;
  const menuItems = selected ? itemsOf(selected.pluginId) : [];
  const selectedTrust = selected?.pluginId === trust?.pluginId ? trust : null;
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
    <div ref={menuRef} tabIndex={-1} data-plugin-id={selected.pluginId} className={`commodore-routines-menu${phone ? " is-sheet" : ""}`} role={phone || selectedTrust ? "dialog" : "menu"} aria-modal={phone ? true : undefined} aria-label={selected.title} onKeyDown={onMenuKey}>
      <div className="commodore-routines-menu-head">
        <div className="commodore-routines-menu-title">{selected.title}</div>
        <div className="commodore-routines-menu-meta is-mono">{[menuVersion(t, selected.entry?.version), `@${selected.marketplace}`].filter(Boolean).join(" · ")}{selected.entry?.latestVersion ? ` → ${isCommitVersion(selected.entry.latestVersion) ? menuVersion(t, selected.entry.latestVersion) : selected.entry.latestVersion}` : ""}</div>
      </div>
      {selectedTrust ? <div className="commodore-plugins-update-trust">
        <p>{t("commodore.plugins.update.commands", { version: isCommitVersion(selectedTrust.version) ? menuVersion(t, selectedTrust.version) : selectedTrust.version })}</p>
        <ul>{selectedTrust.runs.map((run, index) => <li key={index}><span>{t(run.kind === "hook" ? "commodore.plugins.trust.hook" : "commodore.plugins.trust.mcp", { label: run.label })}</span><code>{run.command}</code></li>)}</ul>
        <div className="commodore-plugins-update-actions">
          <button type="button" onClick={() => setTrust(null)}>{t("commodore.plugins.trust.cancel")}</button>
          <button type="button" className="is-go" disabled={busy !== null} onClick={() => update(selected.pluginId, selectedTrust)}>{t("commodore.plugins.update.trust")}</button>
        </div>
      </div> : <>
        {menuItems.map((item) => <button key={item.id} type="button" role={itemRole} disabled={busy !== null} onClick={() => { if (item.id !== "update") closeMenu(); item.run(); }}>{item.label}{item.version ? <small className="commodore-plugins-menu-version">{item.version}</small> : null}</button>)}
        {menuItems.length ? <div className="commodore-routines-separator" role="separator" /> : null}
        <button type="button" role={itemRole} className={`is-danger${armed ? " is-armed" : ""}`} disabled={busy !== null} onClick={() => {
          if (!armed) { setArmed(true); return; }
          closeMenu(); remove(selected.pluginId);
        }}>{t(armed ? "commodore.plugins.removeArmed" : "commodore.plugins.remove")}</button>
      </>}
    </div>
  </div>, document.body) : null;

  if (phone) {
    return (
      <section className="commodore-plugins is-phone" style={identityStyle} aria-label={t("commodore.plugins.title")}>
        <p className="objectives-cm-glab">{t("commodore.plugins.title")}</p>
        {globalGroup}
        {ownHeading}
        <div className="objectives-cm-grp">
          {rows.map(({ pluginId, title, marketplace, entry, mark, replacement }) => (
            <Fragment key={pluginId}>
              <div className={`objectives-cm-gr commodore-plugins-phone-row${menu?.pluginId === pluginId ? " is-target" : ""}${replacement ? " is-replaced" : ""}`} aria-label={title} aria-describedby={replacement ? `${replacementId}-${pluginId}` : undefined} {...rowHandlers(pluginId)}>
                <PluginTile name={title} iconId={entry?.icon ? pluginId : undefined} size="phone" />
                <span className="objectives-cm-gr-tx"><span className="commodore-plugins-name">{title}</span><small className="is-mono">@{marketplace}</small><small className="commodore-plugins-meta">{mark}{openNow(pluginId)}<Components t={t} components={entry?.components} /></small></span>
                <span className="commodore-plugins-version">{rowVersion(entry?.version)}</span>
                <ReplacementHint t={t} replacement={replacement} id={`${replacementId}-${pluginId}`} />
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
        {note ? <p className="objectives-cm-secnote">{note}</p> : null}
        {dialog}
        {menuNode}
      </section>
    );
  }

  return (
    <section className="objectives-commodore-section commodore-plugins" style={identityStyle} aria-label={t("commodore.plugins.title")}>
      <p className="objectives-commodore-section-title commodore-plugins-head"><span className="fc-settings-row__label">{t("commodore.plugins.title")}</span><button type="button" className="commodore-plugins-text" onClick={() => openSettingsSurface(MARKETPLACE_SETTINGS_ADDRESS)}>{t("commodore.plugins.manage")}</button></p>
      {globalGroup}
      {ownHeading}
      {rows.length ? (
        <ul className="commodore-plugins-list">
          {rows.map(({ pluginId, title, marketplace, entry, mark, replacement }) => (
            <li key={pluginId} className={`commodore-plugins-row${menu?.pluginId === pluginId ? " is-target" : ""}${replacement ? " is-replaced" : ""}`} aria-label={title} aria-describedby={replacement ? `${replacementId}-${pluginId}` : undefined} {...rowHandlers(pluginId)}>
              <PluginTile name={title} iconId={entry?.icon ? pluginId : undefined} size="row" />
              <span className="commodore-plugins-name" title={pluginId}>{title}<span className="commodore-plugins-at">@{marketplace}</span></span>
              <span className="commodore-plugins-version">{rowVersion(entry?.version)}</span>
              <span className="commodore-plugins-meta">{mark}{openNow(pluginId)}<Components t={t} components={entry?.components} /></span>
              <ReplacementHint t={t} replacement={replacement} id={`${replacementId}-${pluginId}`} />
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
      {note ? <p className="objectives-commodore-hint">{note}</p> : null}
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
function PluginPalette({ t, commodoreId, installed, phone = false, onClose }: { readonly t: T; readonly commodoreId?: string; readonly installed: readonly string[]; readonly phone?: boolean; readonly onClose: () => void }) {
  const { view, error } = usePluginCatalog();
  const global = useGlobalPlugins();
  const globalScope = !commodoreId;
  const [armed, setArmed] = useState<string | null>(null);
  const mutate = (pluginId: string, selected: boolean, trusted = false) => commodoreId ? setCommodorePlugin(commodoreId, pluginId, selected, trusted) : setGlobalPlugin(pluginId, selected, trusted);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string | null>(null);
  const [row, setRow] = useState<RowState | null>(null);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** 상세 조회 실패 뒤 「다시 시도」 — 같은 플러그인의 조회 효과를 다시 돌린다. */
  const [detailRetry, setDetailRetry] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const scrollTop = useRef(0);
  const returnFocusId = useRef<string | null>(null);
  /** 상세의 제거 확인이 열려 있으면 Esc 가 그것만 닫게 한다. */
  const dismissConfirm = useRef<() => boolean>(() => false);
  const titleId = useId();
  const detailTitleId = useId();
  const name = commodoreId ? commodoreName(commodoreId, t) : "";
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
  }, [openedId, detailEpoch, detailRetry]);
  useEffect(() => {
    if (openedId) return;
    const id = returnFocusId.current;
    const list = listRef.current;
    if (!list || !id) return;
    list.scrollTop = scrollTop.current;
    list.querySelector<HTMLElement>(`[data-plugin-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }, [openedId]);
  const enabled = useMemo(() => view?.marketplaces.filter((marketplace) => marketplace.enabled) ?? [], [view]);
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
    return { marketplace, items: browsing ? all.slice(0, PREVIEW_PER_MARKETPLACE) : all };
  }).filter((group) => group.items.length > 0);

  const save = (pluginId: string, trusted: boolean, entry?: PluginCatalogEntry) => {
    setRow({ pluginId, phase: "saving", ...(entry ? { entry } : {}) });
    void mutate(pluginId, true, trusted).then(() => setRow(null), (reason) => {
      const code = codeOf(reason);
      // 서버가 신뢰 확인을 요구하면(받은 뒤 실행 명령이 생겼다) 원문을 다시 받아 확인 칸을 세운다.
      if (code === "trust_required") { void inspectPlugin(pluginId).then((fresh) => setRow({ pluginId, phase: "trust", entry: fresh }), (again) => setRow({ pluginId, phase: "failed", code: codeOf(again) })); return; }
      setRow({ pluginId, phase: "failed", code, ...(entry ? { entry } : {}) });
    });
  };
  const install = (entry: PluginCatalogEntry) => {
    if (!global.view || row && (row.phase === "checking" || row.phase === "saving")) return;
    if (!globalScope && global.view.plugins.includes(entry.id)) return;
    setRow({ pluginId: entry.id, phase: "checking" });
    void inspectPlugin(entry.id).then((fresh) => {
      if (fresh.runs?.length) setRow({ pluginId: entry.id, phase: "trust", entry: fresh });
      else save(entry.id, false, fresh);
    }, (reason) => setRow({ pluginId: entry.id, phase: "failed", code: codeOf(reason) }));
  };
  const removeInstalled = (pluginId: string) => {
    if (row && (row.phase === "checking" || row.phase === "saving")) return;
    setRow({ pluginId, phase: "saving" });
    void mutate(pluginId, false).then(() => { setArmed(null); setRow(null); }, (reason) => setRow({ pluginId, phase: "failed", code: codeOf(reason) }));
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
  const opened = openedId ? view?.plugins.find((entry) => entry.id === openedId) ?? (installedSet.has(openedId) ? { id: openedId, name: splitPluginId(openedId).plugin, marketplace: splitPluginId(openedId).marketplace } : null) : null;
  const openedDetail = openedId ? detailCache.get(openedId) : undefined;

  const body = !view ? <p className="commodore-plugins-empty" role={error ? "alert" : "status"}>{error ? errorWord(t, error) : t("commodore.plugins.loading")}</p>
    : enabled.length === 0 ? <p className="commodore-plugins-empty">{t("commodore.plugins.palette.none")}</p>
      : groups.length === 0 ? <p className="commodore-plugins-empty">{t("commodore.plugins.palette.empty", { query: query.trim() })}</p>
        : groups.map(({ marketplace, items }) => (
          <section key={marketplace.name} className="commodore-palette-group" aria-label={marketplace.name}>
            <p className="commodore-palette-group-head">
              <span>{marketplace.name}</span>
              {marketplace.preset ? <span>{t("commodore.marketplaces.by")}</span> : <span className="commodore-plugins-locator">{marketplace.locator}</span>}
              <span>{browsing ? t("commodore.marketplaces.count", { n: marketplace.pluginCount }) : t("commodore.plugins.palette.found", { n: items.length })}</span>
            </p>
            <div className="commodore-palette-rows">
              {items.map((entry) => <PaletteRow key={entry.id} t={t} entry={entry} installed={installedSet.has(entry.id)} installedGlobally={!globalScope && Boolean(global.view?.plugins.includes(entry.id))} globalScope={globalScope} disabled={!global.view || row?.phase === "checking" || row?.phase === "saving"} hint={globalScope && !installedSet.has(entry.id) && global.view?.installedBy[entry.id]?.length ? t("commodore.plugins.global.alreadyOwn", { name: global.view.installedBy[entry.id]!.map((owner) => owner.alias || commodoreName(owner.commodoreId, t)).join(", ") }) : undefined} row={row?.pluginId === entry.id ? row : null} showTrust={openedId === null} onOpen={() => openDetail(entry.id)} onInstall={() => install(entry)} onTrust={(fresh) => save(entry.id, true, fresh)} onCancel={() => setRow(null)} />)}
            </div>
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
            installedGlobally={!globalScope && Boolean(global.view?.plugins.includes(opened.id))}
            globalScope={globalScope}
            disabled={!global.view || row?.phase === "checking" || row?.phase === "saving"}
            row={row?.pluginId === opened.id ? row : null}
            dismissConfirm={dismissConfirm}
            onFocusFallback={holdFocus}
            onBack={backToList}
            onClose={onClose}
            onInstall={() => install(opened)}
            onRemove={() => removeInstalled(opened.id)}
            onRetry={() => setDetailRetry((n) => n + 1)}
            onTrust={(fresh) => save(opened.id, true, fresh)}
            onCancel={() => setRow(null)}
          />
        ) : (
          <>
            <PaletteBar t={t} title={globalScope ? t("commodore.plugins.global.title") : t("commodore.plugins.palette.title", { name })} titleId={titleId} globalScope={globalScope} onClose={onClose} />
            {globalScope ? <p className="commodore-global-lede">{t("commodore.plugins.global.lede")}</p> : null}
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
            </div>
            {enabled.length > 0 ? (
              <div className="commodore-palette-filters" role="group" aria-label={t("commodore.plugins.palette.filterAria")}>
                <button type="button" className="commodore-palette-chip" aria-pressed={filter === null} onClick={() => setFilter(null)}>{t("commodore.plugins.palette.all")} <span>{total}</span></button>
                {enabled.map((marketplace) => <button key={marketplace.name} type="button" className="commodore-palette-chip" aria-pressed={filter === marketplace.name} onClick={() => setFilter(marketplace.name)}>{marketplace.name} <span>{marketplace.pluginCount}</span></button>)}
              </div>
            ) : null}
          </>
        )}
        <div ref={listRef} className="commodore-palette-list" hidden={opened !== null}>
          {global.error ? <p className="commodore-plugins-empty" role="alert">{errorWord(t, global.error)} <button type="button" className="commodore-plugins-text" onClick={() => { void loadGlobalPlugins(); }}>{t("commodore.plugins.detail.retry")}</button></p> : null}
          {globalScope ? <section className="commodore-global-installed">
            <h3 className="commodore-palette-group-head"><GlobalPluginMark /><span>{t("commodore.plugins.global.installedCount", { n: installed.length })}</span></h3>
            {global.view ? installed.length ? <div className="commodore-palette-rows">{installed.map((pluginId) => {
              const parts = splitPluginId(pluginId);
              const entry = view?.plugins.find((plugin) => plugin.id === pluginId) ?? { id: pluginId, name: parts.plugin, marketplace: parts.marketplace };
              return <PaletteRow key={pluginId} t={t} entry={entry} installed globalScope showMarketplace disabled={row?.phase === "checking" || row?.phase === "saving"} row={row?.pluginId === pluginId ? row : null} showTrust onOpen={() => openDetail(pluginId)} onInstall={() => {}} onTrust={(fresh) => save(pluginId, true, fresh)} onCancel={() => setRow(null)} onRemove={() => { if (armed === pluginId) removeInstalled(pluginId); else setArmed(pluginId); }} removeArmed={armed === pluginId} />;
            })}</div> : <p className="commodore-plugins-empty">{t("commodore.plugins.empty")}</p> : <p className="commodore-plugins-empty" role="status">{t("commodore.plugins.loading")}</p>}
          </section> : null}
          {body}
        </div>
        {opened ? null : (
          <div className="commodore-palette-foot">
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
 * 팔레트 행 — 마켓플레이스 묶음의 둥근 카드 안에 한 줄씩 선다. 설치 단추를 제외한 행은 상세를 연다. Enter 는 그 단추의 기본 동작이다.
 * 둘째 줄은 설명 한 줄(없으면 버전·만든 이)이고, 나머지 사실은 상세의 정보 카드가 맡는다. 신뢰 확인이 필요하면 행 아래로 펼친다.
 */
function PaletteRow({ t, entry, installed, installedGlobally = false, globalScope = false, disabled = false, hint, showMarketplace = false, onRemove, removeArmed = false, row, showTrust, onOpen, onInstall, onTrust, onCancel }: {
  readonly t: T;
  readonly entry: PluginCatalogEntry;
  readonly installed: boolean;
  readonly installedGlobally?: boolean;
  readonly globalScope?: boolean;
  readonly disabled?: boolean;
  readonly hint?: string | undefined;
  readonly showMarketplace?: boolean;
  readonly row: RowState | null;
  readonly showTrust: boolean;
  readonly onRemove?: () => void;
  readonly removeArmed?: boolean;
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
  const byline = [shown.version ? `v${shown.version}` : null, shown.author ? t("commodore.plugins.byAuthor", { name: shown.author }) : null].filter(Boolean).join(" · ");
  const sub = shown.description ?? (byline || null);
  return (
    <article className={`commodore-palette-row${trusting ? " is-open" : ""}`}>
      <button type="button" className="commodore-palette-open" data-plugin-id={entry.id} aria-label={t("commodore.plugins.detail.openAria", { plugin: title })} onClick={() => { if (!working && row?.phase !== "trust") onOpen(); }}>
        <PluginTile name={title} iconId={shown.icon ? entry.id : undefined} size="card" />
        <span className="commodore-palette-row-main">
          <span className="commodore-palette-name">{title}{showMarketplace ? <span className="commodore-plugins-at">@{shown.marketplace}</span> : null}</span>
          {sub ? <span className={`commodore-palette-desc${trusting ? "" : " is-clamped"}`}>{sub}</span> : null}
          {hint ? <span className="commodore-global-own-hint">{hint}</span> : null}
        </span>
      </button>
      <span className="commodore-palette-action">
        {installedGlobally ? <span className="commodore-plugins-state">{t("commodore.plugins.global.installed")}</span>
          : installed ? onRemove ? <button type="button" className="fc-btn fc-btn--secondary commodore-palette-install" disabled={working || disabled} onClick={onRemove}>{t(removeArmed ? "commodore.plugins.removeArmed" : "commodore.plugins.remove")}</button> : <span className="commodore-plugins-state is-done">{t("commodore.plugins.palette.installed")}</span>
            : row?.phase === "trust" ? null
              : <button type="button" className="fc-btn fc-btn--secondary commodore-palette-install" disabled={working || disabled} aria-label={t(globalScope ? "commodore.plugins.global.installAria" : "commodore.plugins.palette.installAria", { plugin: title })} onClick={onInstall}>{working ? t("commodore.plugins.palette.checking") : t("commodore.plugins.palette.install")}</button>}
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

/**
 * 팔레트 상단 바 — 목록과 상세가 같은 바를 써서 닫기(오른쪽)·뒤로(왼쪽) 아이콘이 두 화면에서 같은 자리에 선다.
 * 목록은 왼쪽 칸을 비워 두고 제목을 싣는다. 상세는 큰 이름이 스크롤로 가려질 때만 가운데에 이름을 보인다(그때도 읽는 이름은 본문 h2 다).
 */
function PaletteBar({ t, title, titleId, pinned, backRef, onBack, onClose, globalScope = false }: {
  readonly t: T;
  readonly title: string;
  readonly titleId?: string;
  readonly globalScope?: boolean;
  readonly pinned?: boolean;
  readonly backRef?: Ref<HTMLButtonElement>;
  readonly onBack?: () => void;
  readonly onClose: () => void;
}) {
  return (
    <div className={`commodore-palette-bar${onBack ? " is-detail" : ""}${pinned ? " is-pinned" : ""}`}>
      {onBack ? (
        <button ref={backRef} type="button" className="commodore-palette-icon" aria-label={t("commodore.plugins.detail.back")} title={t("commodore.plugins.detail.back")} onClick={onBack}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      ) : null}
      {titleId ? <h2 id={titleId} className="commodore-palette-title">{globalScope ? <GlobalPluginMark /> : null}{title}</h2> : <p className="commodore-palette-title" aria-hidden="true">{title}</p>}
      <button type="button" className="commodore-palette-icon" aria-label={t("commodore.plugins.palette.close")} title={t("commodore.plugins.palette.close")} onClick={onClose}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

/** 섹션마다 먼저 보이는 행 수 — 넘으면 「모두 보기」로 펼친다. */
const DETAIL_PREVIEW_ROWS = 5;

const PART_GLYPH: Readonly<Record<keyof PluginContents, ReactNode>> = {
  skills: <path d="M8 2.5l1.6 3.3 3.6.5-2.6 2.5.6 3.6L8 10.7l-3.2 1.7.6-3.6L2.8 6.3l3.6-.5z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />,
  commands: <path d="M3.5 5l3 3-3 3M8.5 11.5h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
  agents: <><circle cx="8" cy="6" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M3.5 13c.6-2.3 2.4-3.5 4.5-3.5s3.9 1.2 4.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></>,
  hooks: <path d="M9 2.5 4.5 9H8l-1 4.5L11.5 7H8z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />,
  mcp: <><rect x="3" y="3" width="10" height="4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" /><rect x="3" y="9" width="10" height="4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" /></>,
};

type DetailRow = { readonly name: string; readonly commands: readonly string[] };

/**
 * 구성 섹션의 행 — 구성 이름마다 한 행이고, 실행 명령은 같은 이름의 훅·MCP 행 둘째 줄에 붙는다. 구성 목록에 없는 실행 명령도
 * 자기 이름의 행으로 남겨, 설치 전에 돌 명령이 하나도 가려지지 않게 한다.
 */
function detailSections(parts: PluginContents | undefined, runs: PluginCatalogEntry["runs"]): readonly (readonly [keyof PluginContents, CommodoreMessageKey, readonly DetailRow[]])[] {
  return DETAIL_PARTS.map(([key, label]) => {
    const kind = key === "hooks" ? "hook" : key === "mcp" ? "mcp" : null;
    const own = (runs ?? []).filter((run) => run.kind === kind);
    const names = [...(parts?.[key] ?? [])];
    for (const run of own) if (!names.includes(run.label)) names.push(run.label);
    const rows = names.map((name) => ({ name, commands: own.filter((run) => run.label === name).map((run) => run.command) }));
    return [key, label, rows] as const;
  }).filter(([, , rows]) => rows.length > 0);
}

function DetailSection({ t, partKey, label, rows }: { readonly t: T; readonly partKey: keyof PluginContents; readonly label: CommodoreMessageKey; readonly rows: readonly DetailRow[] }) {
  const [open, setOpen] = useState(false);
  const headId = useId();
  const shown = open || rows.length <= DETAIL_PREVIEW_ROWS ? rows : rows.slice(0, DETAIL_PREVIEW_ROWS);
  return (
    <section className="commodore-plugin-detail-section" aria-labelledby={headId}>
      <h3 id={headId} className="commodore-plugin-detail-head">{t(label)}<span>{rows.length}</span></h3>
      <div className="commodore-plugin-detail-rows">
        <ul>
          {shown.map((row, index) => (
            <li key={`${row.name}-${index}`} className="commodore-plugin-detail-row">
              <span className="commodore-plugin-detail-glyph" aria-hidden="true"><svg viewBox="0 0 16 16">{PART_GLYPH[partKey]}</svg></span>
              <span className="commodore-plugin-detail-row-main">
                <span className="commodore-plugin-detail-row-name">{row.name}</span>
                {row.commands.map((command, at) => <code key={at}>{command}</code>)}
              </span>
            </li>
          ))}
        </ul>
        {shown.length < rows.length ? <button type="button" className="commodore-plugin-detail-more" onClick={() => setOpen(true)}>{t("commodore.plugins.detail.showAll", { n: rows.length })}</button> : null}
      </div>
    </section>
  );
}

/** 링크 칸에 보일 글자 — 프로토콜과 끝 빗금을 뗀 주소. */
const linkText = (url: string): string => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/**
 * 팔레트 안의 상세. 카탈로그 필드는 바로 보이고, 구성 이름·실행 명령·README 는 상세 응답이 오면 채워진다.
 * 조회가 실패해도 카탈로그 필드는 남는다. README 는 정화된 markdown 이다 — 그 표현은 공용 markdown 스타일이 맡고 여기서는 자리만 둔다.
 */
function PluginDetailView({ t, titleId, entry, detail, loading, error, installed, installedGlobally = false, globalScope = false, disabled = false, row, dismissConfirm, onFocusFallback, onBack, onClose, onInstall, onRemove, onRetry, onTrust, onCancel }: {
  readonly t: T;
  readonly titleId: string;
  readonly entry: PluginCatalogEntry;
  readonly detail: PluginDetail | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly installed: boolean;
  readonly installedGlobally?: boolean;
  readonly globalScope?: boolean;
  readonly disabled?: boolean;
  readonly row: RowState | null;
  readonly dismissConfirm: { current: () => boolean };
  readonly onFocusFallback: () => void;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly onInstall: () => void;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
  readonly onTrust: (entry: PluginCatalogEntry) => void;
  readonly onCancel: () => void;
}) {
  const backRef = useRef<HTMLButtonElement | null>(null);
  const trustRef = useRef<HTMLButtonElement | null>(null);
  const cancelRemoveRef = useRef<HTMLButtonElement | null>(null);
  const removeRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLHeadingElement | null>(null);
  const confirmWasOpen = useRef(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pinned, setPinned] = useState(false);
  const shown = detail ? { ...entry, ...detail } : row?.entry ? { ...entry, ...row.entry } : entry;
  const title = titleOf(shown, entry.name);
  const working = row?.phase === "checking" || row?.phase === "saving";
  const trusting = row?.phase === "trust" && Boolean((row.entry ?? shown).runs?.length);
  const trustEntry = row?.entry ?? shown;
  const readme = detail?.readme ?? "";
  const readmeHtml = useMemo(() => (readme ? pluginReadmeHtml(readme) : ""), [readme]);
  const runs = detail?.runs ?? entry.runs;
  const sections = trusting ? [] : detailSections(detail?.contents, runs);
  const homepage = shown.homepage ? httpUrl(shown.homepage) : null;
  const repository = shown.repository ? httpUrl(shown.repository) : null;
  const facts: (readonly [CommodoreMessageKey, ReactNode])[] = [];
  if (shown.version) facts.push(["commodore.plugins.detail.version", `v${shown.version}`]);
  if (shown.author) facts.push(["commodore.plugins.detail.author", shown.author]);
  if (shown.category) facts.push(["commodore.plugins.detail.category", shown.category]);
  facts.push(["commodore.plugins.detail.marketplace", shown.marketplace]);
  if (shown.license) facts.push(["commodore.plugins.detail.license", shown.license]);
  if (homepage) facts.push(["commodore.plugins.homepage", <a href={homepage} target="_blank" rel="noopener noreferrer">{linkText(homepage)}</a>]);
  if (repository) facts.push(["commodore.plugins.detail.repository", <a href={repository} target="_blank" rel="noopener noreferrer">{linkText(repository)}</a>]);
  if (shown.keywords?.length) facts.push(["commodore.plugins.detail.keywords", shown.keywords.join(", ")]);
  useEffect(() => { backRef.current?.focus(); }, []);
  useEffect(() => { if (trusting) trustRef.current?.focus({ preventScroll: false }); }, [trusting]);
  useEffect(() => {
    const root = scrollRef.current;
    const name = nameRef.current;
    if (!root || !name || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([seen]) => setPinned(!seen?.isIntersecting), { root, threshold: 0 });
    observer.observe(name);
    return () => observer.disconnect();
  }, []);
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
      <PaletteBar t={t} title={title} pinned={pinned} backRef={backRef} onBack={onBack} onClose={onClose} />
      <div ref={scrollRef} className="commodore-plugin-detail-scroll">
        <header className="commodore-plugin-detail-hero">
          <PluginTile name={title} iconId={shown.icon ? entry.id : undefined} size="detail" />
          <span className="commodore-plugin-detail-heading">
            <h2 ref={nameRef} id={titleId} className="commodore-plugin-detail-name">{title}</h2>
            <p className="commodore-plugin-detail-meta">{installed ? `${shown.marketplace} · ${t("commodore.plugins.palette.installed")}` : shown.marketplace}</p>
          </span>
          <span className="commodore-plugin-detail-action">
            {trusting ? null : installedGlobally ? <span className="commodore-plugins-state">{t("commodore.plugins.global.installed")}</span> : installed
              ? <button ref={removeRef} type="button" className="fc-btn fc-btn--secondary" disabled={confirmRemove || working || disabled} onClick={() => setConfirmRemove(true)}>{t("commodore.plugins.detail.remove")}</button>
              : <button type="button" className="fc-btn fc-btn--primary" disabled={working || disabled} aria-label={t(globalScope ? "commodore.plugins.global.installAria" : "commodore.plugins.palette.installAria", { plugin: title })} onClick={onInstall}>{working ? t("commodore.plugins.palette.checking") : t("commodore.plugins.palette.install")}</button>}
          </span>
        </header>
        {shown.description ? <p className="commodore-plugin-detail-desc">{shown.description}</p> : null}
        {confirmRemove ? (
          <div className="commodore-plugin-detail-notice" role="alert">
            <p>{t(globalScope ? "commodore.plugins.global.removeConfirm" : "commodore.plugins.removeConfirm", { plugin: title })}</p>
            <div className="commodore-plugin-detail-notice-actions">
              <button ref={cancelRemoveRef} type="button" className="fc-btn fc-btn--secondary" onClick={() => setConfirmRemove(false)}>{t("commodore.plugins.removeCancel")}</button>
              <button type="button" className="fc-btn fc-btn--secondary is-danger" disabled={working} onClick={() => { setConfirmRemove(false); onRemove(); }}>{t("commodore.plugins.detail.remove")}</button>
            </div>
          </div>
        ) : null}
        {loading ? <p className="commodore-plugin-detail-status" role="status">{t("commodore.plugins.detail.loading")}</p> : null}
        {error ? (
          <p className="commodore-plugin-detail-status is-failed" role="alert">
            <span>{t("commodore.plugins.detail.failed")}</span>
            <button type="button" className="commodore-plugins-text" onClick={onRetry}>{t("commodore.plugins.detail.retry")}</button>
          </p>
        ) : null}
        {row?.phase === "failed" ? <p className="commodore-plugin-detail-status is-failed" role="alert">{errorWord(t, row.code ?? "failed")}</p> : null}
        {trusting ? <TrustPanel t={t} entry={trustEntry} onTrust={onTrust} onCancel={onCancel} trustRef={trustRef} /> : null}
        {sections.map(([key, label, rows]) => <DetailSection key={key} t={t} partKey={key} label={label} rows={rows} />)}
        <section className="commodore-plugin-detail-section" aria-labelledby={`${titleId}-about`}>
          <h3 id={`${titleId}-about`} className="commodore-plugin-detail-head">{t("commodore.plugins.detail.about")}</h3>
          <dl className="commodore-plugin-detail-info">
            {facts.map(([label, value]) => <div key={label} className="commodore-plugin-detail-fact"><dt>{t(label)}</dt><dd>{value}</dd></div>)}
          </dl>
        </section>
        {readmeHtml ? (
          <section className="commodore-plugin-detail-readme" aria-label={t("commodore.plugins.detail.readme")}>
            <h3 className="commodore-plugin-detail-head">{t("commodore.plugins.detail.readme")}</h3>
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
