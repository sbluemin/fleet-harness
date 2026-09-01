import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { PaneContext, PaneDescriptor, PaneSearchProvider } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";
import type { SettingsSectionDescriptor, SettingsSectionGroup } from "@fleet-console/sdk/settings";

import { SettingsHelp } from "../components/settings-help.js";
import { loadGlobalSettings, useGlobalSettingsStore } from "../global-settings-store.js";
import { getT, useConsoleLocale, useT } from "../i18n/index.js";
import { usePluginRegistry } from "../plugin-registry.js";
import {
  closeRailPanel,
  RAIL_OVERLAY_ALPHA_DEFAULT,
  RAIL_OVERLAY_ALPHA_MAX,
  RAIL_OVERLAY_ALPHA_MIN,
  setRailOverlayAlpha,
  useRailOverlayAlpha,
} from "../rail/rail-store.js";
import type { RemoteAccessState } from "../types.js";
import {
  buildCoreSettingsSections,
  collectPluginSettingsSections,
  ConsolePortCard,
  renderSettingsSection,
  resolveSettingsSectionId,
  SearchIcon,
  SETTINGS_GROUP_LABEL_KEYS,
  SETTINGS_GROUP_ORDER,
  SettingsScope,
  type PluginSettingsNavItem,
  type SettingsSectionId,
} from "./sections.js";

/**
 * 설정 표면 — 페이지의 후계자.
 *
 * 설정은 더 이상 가는 곳이 아니라 부르는 것이다. 옛 `/settings` 페이지는 콘솔 전체를 치우고
 * 섰기 때문에, 콘솔을 보면서 돌려야 하는 설정(테마·유리·흐리기·서체)을 위해 콘솔의 축소
 * 모형까지 지어야 했다. 이 표면은 레일 페인으로 서서 뒤의 콘솔을 살려 둔다 — 콘솔 자체가
 * 미리보기다.
 *
 * 형태는 단일 primary 페인 + 칩 행이다(재가된 변형 B). 칩은 접히는 대신 줄바꿈으로 전부
 * 선다 — 숨은 +N 뒤에 섹션을 감추면 "모든 설정이 이 문 뒤에 있다"는 약속이 깨진다.
 * 밀도가 페인 폭을 넘는 관리면(원격 접속 장치·링크 등)은 같은 섹션을 확대 표면에서 연다 —
 * 확대는 페인이 구현하는 기능이 아니라 표면 계약의 공통 동작이므로, 여기서는 열 자리만 말한다.
 */

import { GearGlyph, SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID, SETTINGS_SECTION_PANE_ID } from "./settings-entry.js";

export { GearGlyph, SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID, SETTINGS_SECTION_PANE_ID };

/**
 * 검색 공급자는 React 밖에서 불리므로 훅으로 레지스트리를 읽을 수 없다. app 셸이 레지스트리를
 * 실을 때 이 스냅샷을 함께 갱신한다(확대 페인 제목이 쓰는 paneIndex 스냅샷과 같은 관례).
 * 호스트 번들 안의 모듈 상태라 호스트-플러그인 경계의 싱글턴 금지와는 무관하다.
 */
let searchPluginsSnapshot: readonly { readonly id: string; readonly settingsSections?: readonly SettingsSectionDescriptor[] }[] = [];

export function syncSettingsSearchPlugins(plugins: typeof searchPluginsSnapshot): void {
  searchPluginsSnapshot = plugins;
}

interface SettingsChip {
  readonly id: SettingsSectionId;
  readonly group: SettingsSectionGroup;
  readonly label: string;
  /** 검색이 이 섹션에 닿는 말 — 제목·플러그인 이름·키워드를 전부 합친다. */
  readonly haystack: string;
}

function buildChips(
  coreSections: ReturnType<typeof buildCoreSettingsSections>,
  pluginSections: readonly PluginSettingsNavItem[],
): readonly SettingsChip[] {
  const merged: SettingsChip[] = [
    ...coreSections.map((section) => ({
      id: section.id as SettingsSectionId,
      group: section.group,
      label: section.label,
      haystack: [section.label, ...section.entries].join(" ").toLowerCase(),
    })),
    ...pluginSections.map((section) => ({
      id: section.id,
      group: section.group,
      label: section.sectionTitle,
      haystack: [section.sectionTitle, section.pluginLabel, ...section.entries].join(" ").toLowerCase(),
    })),
  ];
  return SETTINGS_GROUP_ORDER.flatMap((group) => merged.filter((chip) => chip.group === group));
}

/** 팔레트 검색 — 결과는 섹션 단위로 착지 자리를 값으로 돌려준다(PaneTarget 계약). */
const settingsSearchProvider: PaneSearchProvider = (request) => {
  const locale = (request.language ?? "en") as ConsoleLocale;
  const t = getT(locale);
  const query = request.query.trim().toLowerCase();
  if (query === "") return Promise.resolve([]);
  const chips = buildChips(
    buildCoreSettingsSections(t, null),
    collectPluginSettingsSections(searchPluginsSnapshot, locale, t),
  );
  return Promise.resolve(chips
    .filter((chip) => chip.haystack.includes(query))
    .slice(0, request.limit)
    .map((chip) => ({
      id: `settings:${chip.id}`,
      title: chip.label,
      subtitle: t(SETTINGS_GROUP_LABEL_KEYS[chip.group]),
      activate: () => ({ paneId: SETTINGS_PANE_ID, params: { section: chip.id } }),
    })));
};

export const settingsRailEntry: RailEntryDescriptor = {
  id: SETTINGS_RAIL_ENTRY_ID,
  title: (locale) => getT(locale)("settings.title"),
  icon: () => <GearGlyph />,
  panes: [SETTINGS_PANE_ID, SETTINGS_SECTION_PANE_ID],
};

export const settingsPanes: readonly PaneDescriptor[] = [
  {
    id: SETTINGS_PANE_ID,
    role: "primary",
    mounts: ["rail"],
    // 안에서 테마 격자가 2열로 서야 하는 본문이다. 픽셀을 직접 고르던 시절의 360은 자기
    // 컨테이너 문턱(components.css의 `@container (max-width: 420px)`) 아래여서, 기본 상태의
    // 설정 페인이 그 격자를 한 번도 2열로 세우지 못했다. 등급이 그 어긋남을 대신 막는다.
    widthClass: "wide",
    title: () => (locale: ConsoleLocale) => getT(locale)("settings.title"),
    render: (ctx) => <SettingsPaneBody ctx={ctx} />,
    search: settingsSearchProvider,
  },
  {
    id: SETTINGS_SECTION_PANE_ID,
    role: "detail",
    mounts: ["expanded"],
    title: (ctx) => (locale: ConsoleLocale) => resolveSectionTitle(ctx.params.section ?? null, locale),
    render: (ctx) => <SettingsSectionExpanded ctx={ctx} />,
  },
];

/** 확대 슬롯 머리가 부르는 제목 — 레지스트리 스냅샷으로 섹션 이름을 찾고, 못 찾으면 "설정". */
function resolveSectionTitle(requested: string | null, locale: ConsoleLocale): string {
  const t = getT(locale);
  const core = buildCoreSettingsSections(t, null);
  const plugins = collectPluginSettingsSections(searchPluginsSnapshot, locale, t);
  const available = new Set<string>([...core.map((section) => section.id), ...plugins.map((section) => section.id)]);
  const resolved = resolveSettingsSectionId(requested, available);
  if (resolved === null) return t("settings.title");
  const chip = buildChips(core, plugins).find((entry) => entry.id === resolved);
  return chip === undefined ? t("settings.title") : `${t("settings.title")} — ${chip.label}`;
}

function SettingsPaneBody({ ctx }: { readonly ctx: PaneContext }) {
  const t = useT();
  const locale = useConsoleLocale();
  const registry = usePluginRegistry();
  const settings = useGlobalSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;
  const [query, setQuery] = useState("");

  useEffect(() => {
    void loadGlobalSettings(ctx.signal);
  }, [ctx.signal]);

  const coreSections = buildCoreSettingsSections(t, state);
  const pluginSections = collectPluginSettingsSections(registry.plugins, locale, t);
  const chips = useMemo(() => buildChips(coreSections, pluginSections), [coreSections, pluginSections]);
  const available = useMemo(() => new Set<string>(chips.map((chip) => chip.id)), [chips]);
  const activeId = resolveSettingsSectionId(ctx.params.section ?? null, available) ?? "appearance";

  const selectSection = (id: SettingsSectionId) => {
    setQuery("");
    // 주소는 params가 진다 — 딥링크 어댑터와 팔레트가 같은 자리로 착지한다.
    ctx.panes.replaceParams({ section: id });
  };

  const openExpandedSection = (id: SettingsSectionId) => {
    ctx.panes.open({ paneId: SETTINGS_SECTION_PANE_ID, mount: "expanded", params: { section: id } });
  };

  const trimmed = query.trim().toLowerCase();

  // Esc는 소환한 표면을 돌려보낸다(레퍼런스에서 취한 한 손짓). 페인 안 팝오버가 먼저
  // preventDefault로 소비하면 여기는 물러선다 — 확대 슬롯의 window Esc와도 겹치지 않는다.
  // 검색이 서 있는 동안의 첫 Esc는 표면이 아니라 검색을 거둔다(file-explorer 필터와 같은
  // 층위 문법) — 안 그러면 질의를 지우려던 손이 페인째 닫는다.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (trimmed !== "") {
      setQuery("");
      return;
    }
    closeRailPanel(SETTINGS_RAIL_ENTRY_ID);
    document.querySelector<HTMLElement>(".right-rail-settings-btn")?.focus();
  };
  const matches = trimmed === "" ? null : chips.filter((chip) => chip.haystack.includes(trimmed));

  return (
    <div className="settings-pane" onKeyDown={handleKeyDown}>
      <div className="settings-pane-toolbar">
        <div className="settings-search">
          <SearchIcon />
          <input
            type="search"
            value={query}
            placeholder={t("settings.search.placeholder")}
            aria-label={t("settings.search.aria")}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="settings-pane-zoom"
          aria-label={t("settings.pane.expand")}
          title={t("settings.pane.expand")}
          onClick={() => openExpandedSection(activeId)}
        >
          <ExpandGlyph />
        </button>
      </div>
      {/* 칩은 전부 선다 — 줄바꿈이 접힘(+N)을 대신한다. 그룹 어휘를 잃는 것은 변형 B의
          재가된 트레이드오프이고, 그룹 순서(환경→작업→기계)만 배열로 남긴다. */}
      <div className="settings-pane-chips" role="group" aria-label={t("settings.pane.chipsAria")}>
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={`settings-chip${chip.id === activeId ? " is-active" : ""}`}
            aria-pressed={chip.id === activeId}
            onClick={() => selectSection(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      {matches !== null ? (
        <div className="settings-pane-results" role="group" aria-label={t("settings.pane.resultsAria")}>
          {matches.length === 0 ? <p className="settings-nav-empty">{t("settings.search.empty")}</p> : matches.map((match) => (
            <button key={match.id} type="button" className="settings-pane-result" onClick={() => selectSection(match.id)}>
              <span className="settings-pane-result-label">{match.label}</span>
              <span className="settings-pane-result-group">{t(SETTINGS_GROUP_LABEL_KEYS[match.group])}</span>
            </button>
          ))}
        </div>
      ) : (
        /* 섹션 전환은 재마운트다 — 키가 없으면 한 플러그인 섹션의 렌더 실패(hasError)가
           경계 인스턴스 재사용을 타고 다음 섹션까지 전염된다(옛 페이지의 key 계약 계승). */
        <div key={activeId} className="settings-pane-sections">
          {activeId === "connectivity" ? (
            state === null ? <p className="global-settings-help">{t("settings.general.loading")}</p> : (
              <>
                <ConsolePortCard state={state} saving={saving} />
                {/* 장치·링크·세션 테이블은 페인 폭에 구겨 넣지 않는다 — 페이지가 하던 "넓은
                    화면" 역할의 정당한 후계는 확대 표면이다. 요약은 여기, 관리는 저기. */}
                {state.remoteAccess === undefined ? null : (
                  <RemoteSummaryCard remote={state.remoteAccess} onManage={() => openExpandedSection("connectivity")} />
                )}
              </>
            )
          ) : (
            /* 톱니 메뉴가 들고 있던 레일 취향은 테마 카드의 한 행이 된다 — 비포커스 패널
               흐리기 아래(재가된 배치). 행 주입은 데스크톱 페인만 한다: 레일 없는 모바일이
               같은 헬퍼를 본문으로 쓰기 때문이다. */
            renderSettingsSection(activeId, state, saving, pluginSections, t, { themeCardExtras: <RailOpacityRow /> })
          )}
        </div>
      )}
    </div>
  );
}

function RemoteSummaryCard({ remote, onManage }: {
  readonly remote: RemoteAccessState;
  readonly onManage: () => void;
}) {
  const t = useT();
  return (
    <section className="global-settings-card" aria-label={t("settings.remote.title")}>
      <p className="global-settings-card-title">{t("settings.remote.title")}</p>
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            {remote.enabled ? t("settings.remote.on") : t("settings.remote.off")}
            {/* 제목이 켬/끔 상태 문구라, 팁의 접근성 이름은 섹션 이름(원격 접속)으로 짓는다. */}
            <SettingsHelp title={t("settings.remote.title")}>{t("settings.remote.help")}</SettingsHelp>
          </p>
        </div>
        <button type="button" className="settings-pane-manage" onClick={onManage}>
          {t("settings.pane.manageRemote")}
        </button>
      </div>
    </section>
  );
}

/**
 * 우측 사이드바(레일 카드) 불투명도 — 서버 설정이 아니라 브라우저-로컬 rail-store다. 터미널
 * 렌더러가 그렇듯 브라우저-로컬도 설정 화면에 선다: 사람이 찾는 기준은 저장 위치가 아니라
 * 하는 일이다. 전용 "레일 패널" 카드는 퇴역했다 — 화면 재질을 다루는 다른 손잡이(리퀴드
 * 글래스·패널 흐리기)와 같은 테마 카드에 한 행으로 선다(재가된 배치·리네이밍).
 */
function RailOpacityRow() {
  const t = useT();
  const overlayAlpha = useRailOverlayAlpha();
  return (
    <div className="global-settings-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">
          {t("settings.theme.railOpacity")}
          <SettingsHelp title={t("settings.theme.railOpacity")}>{t("settings.theme.railOpacityHelp")}</SettingsHelp>
          <SettingsScope kind="live" />
        </p>
      </div>
      <div className="settings-slider-field">
        <input
          className="fleet-slider settings-slider"
          type="range"
          min={RAIL_OVERLAY_ALPHA_MIN}
          max={RAIL_OVERLAY_ALPHA_MAX}
          step={1}
          value={overlayAlpha}
          aria-label={t("settings.theme.railOpacity")}
          aria-valuetext={`${overlayAlpha}%`}
          style={{ "--slider-fill": `${((overlayAlpha - RAIL_OVERLAY_ALPHA_MIN) / (RAIL_OVERLAY_ALPHA_MAX - RAIL_OVERLAY_ALPHA_MIN)) * 100}%` } as CSSProperties}
          onChange={(event) => setRailOverlayAlpha(Number(event.currentTarget.value))}
          onDoubleClick={() => setRailOverlayAlpha(RAIL_OVERLAY_ALPHA_DEFAULT)}
        />
        <output className="settings-slider-value">{`${overlayAlpha}%`}</output>
      </div>
    </div>
  );
}

/** 확대 표면의 섹션 본문 — 같은 섹션 레지스트리를 넓은 캔버스로 편다. */
function SettingsSectionExpanded({ ctx }: { readonly ctx: PaneContext }) {
  const t = useT();
  const locale = useConsoleLocale();
  const registry = usePluginRegistry();
  const settings = useGlobalSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;

  // 확대는 언제나 이미 적재를 끝낸 primary 페인 옆에 선다 — 여기서 GET을 한 번 더 쏘면,
  // 그 응답이 사용자의 낙관 저장(PUT) 뒤에 도착해 옛 스냅숏으로 화면을 되덮는 경쟁이 생긴다.
  // 준비된 스냅숏은 그대로 쓰고, 비어 있을 때(방어적 폴백)만 적재한다.
  useEffect(() => {
    if (state !== null) return;
    void loadGlobalSettings(ctx.signal);
  }, [ctx.signal, state]);

  const coreSections = buildCoreSettingsSections(t, state);
  const pluginSections = collectPluginSettingsSections(registry.plugins, locale, t);
  const available = useMemo(
    () => new Set<string>([...coreSections.map((section) => section.id), ...pluginSections.map((section) => section.id)]),
    [coreSections, pluginSections],
  );
  const activeId = resolveSettingsSectionId(ctx.params.section ?? null, available) ?? "appearance";

  return (
    <div className="settings-expanded">
      {/* 페인과 같은 키 계약 — replaceParams로 섹션을 갈아탈 때 경계와 섹션-로컬 상태를 재마운트한다. */}
      <div key={activeId} className="settings-expanded-canvas">
        {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
        {/* 우측 사이드바 불투명도 행은 페인과 같은 자리(테마 카드)에서 확대에도 선다 — 행 주입인
            이유는 같은 헬퍼가 레일 없는 모바일의 본문이기도 하기 때문이다. */}
        {renderSettingsSection(activeId, state, saving, pluginSections, t, { themeCardExtras: <RailOpacityRow /> })}
      </div>
    </div>
  );
}

function ExpandGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
