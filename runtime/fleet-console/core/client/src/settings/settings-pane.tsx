import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { PaneContext, PaneDescriptor, PaneSearchProvider } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";
import type { SettingsSectionDescriptor, SettingsSectionGroup } from "@fleet-console/sdk/settings";
import { SettingsSlider } from "@fleet-console/sdk/settings/browser";

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
import {
  setSideBarGlassAlpha,
  setSideBarGlassBlur,
  SIDE_BAR_GLASS_ALPHA_DEFAULT,
  SIDE_BAR_GLASS_ALPHA_MAX,
  SIDE_BAR_GLASS_ALPHA_MIN,
  SIDE_BAR_GLASS_BLUR_DEFAULT,
  SIDE_BAR_GLASS_BLUR_MAX,
  SIDE_BAR_GLASS_BLUR_MIN,
  useSideBarGlass,
} from "../sidebar/operations-side-bar-store.js";
import {
  buildCoreSettingsSections,
  collectPluginSettingsSections,
  renderSettingsSection,
  resolveSettingsSectionId,
  SearchIcon,
  SETTINGS_GROUP_LABEL_KEYS,
  SETTINGS_GROUP_ORDER,
  SettingsScope,
  type PluginSettingsNavItem,
  type SettingsSectionId,
  type SettingsSectionNavItem,
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
 * 원격 접속 장치·링크 관리도 같은 페인에서 제공한다.
 */

import { GearGlyph, SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "./settings-entry.js";

export { GearGlyph, SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID };

/**
 * 검색 공급자는 React 밖에서 불리므로 훅으로 레지스트리를 읽을 수 없다. app 셸이 레지스트리를
 * 실을 때 이 스냅샷을 함께 갱신한다.
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
  /** 칩 옆 '?'가 여는 설명. */
  readonly help?: string;
  /** 검색이 이 섹션에 닿는 말 — 제목·플러그인 이름·키워드를 전부 합친다. */
  readonly haystack: string;
}

function buildChips(
  coreSections: ReturnType<typeof buildCoreSettingsSections>,
  pluginSections: readonly PluginSettingsNavItem[],
): readonly SettingsChip[] {
  // 품긴 섹션(코어 embeddedIn·플러그인 experiments 그룹)은 칩을 갖지 않는다 — 그 말들은 품는 칩의
  // 검색어로 합쳐져, 찾으면 품는 페이지로 간다.
  const embeddedWords = new Map<SettingsSectionId, string[]>();
  for (const section of coreSections) {
    if (!section.embeddedIn) continue;
    embeddedWords.set(section.embeddedIn, [...(embeddedWords.get(section.embeddedIn) ?? []), section.label, ...section.entries]);
  }
  for (const section of pluginSections) {
    if (section.group !== "experiments") continue;
    embeddedWords.set("experiments", [...(embeddedWords.get("experiments") ?? []), section.sectionTitle, section.pluginLabel, ...section.entries]);
  }
  const merged: SettingsChip[] = [
    ...coreSections.filter((section) => !section.embeddedIn).map((section) => ({
      id: section.id as SettingsSectionId,
      group: section.group,
      label: section.label,
      ...(section.help ? { help: section.help } : {}),
      haystack: [section.label, ...section.entries, ...(embeddedWords.get(section.id as SettingsSectionId) ?? [])].join(" ").toLowerCase(),
    })),
    ...pluginSections.filter((section) => section.group !== "experiments").map((section) => ({
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
  panes: [SETTINGS_PANE_ID],
};

export const settingsPanes: readonly PaneDescriptor[] = [
  {
    id: SETTINGS_PANE_ID,
    role: "primary",
    mounts: ["rail"],
    // 설정은 열자마자 모든 행이 제목 왼쪽·컨트롤 오른쪽의 한 줄 꼴로 서야 한다. 픽셀을 직접
    // 고르던 시절의 360은 테마 격자 문턱(420) 아래였고, `wide`(440)도 행 스택 문턱(640) 아래라
    // 기본 상태의 설정이 늘 접힌 채로 열렸다. 등급표가 그 문턱들을 한곳에서 지킨다.
    widthClass: "broad",
    title: () => (locale: ConsoleLocale) => getT(locale)("settings.title"),
    render: (ctx) => <SettingsPaneBody ctx={ctx} />,
    search: settingsSearchProvider,
  },
];

/**
 * 칩이 없는 섹션(다른 칩 안에 묻힌 것)으로 들어온 경로를 그 칩으로 옮긴다 — 연결 설정을 여는 원격 접속
 * 픽커와 경로 어댑터는 여전히 "connectivity"를 말하고, 페인은 그 카드가 사는 실험 기능 칩을 연다.
 */
function hostSectionOf(
  requested: string | null,
  coreSections: readonly SettingsSectionNavItem[],
  pluginSections: readonly PluginSettingsNavItem[],
): string | null {
  if (requested === null) return null;
  const core = coreSections.find((section) => section.id === requested);
  if (core?.embeddedIn) return core.embeddedIn;
  const plugin = pluginSections.find((section) => section.id === requested);
  if (plugin?.group === "experiments") return "experiments";
  return requested;
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
  const activeId = resolveSettingsSectionId(hostSectionOf(ctx.params.section ?? null, coreSections, pluginSections), available) ?? "appearance";

  const selectSection = (id: SettingsSectionId) => {
    setQuery("");
    // 주소는 params가 진다 — 딥링크 어댑터와 팔레트가 같은 자리로 착지한다.
    ctx.panes.replaceParams({ section: id });
  };

  const trimmed = query.trim().toLowerCase();

  // Esc는 소환한 표면을 돌려보낸다(레퍼런스에서 취한 한 손짓). 페인 안 팝오버가 먼저
  // preventDefault로 소비하면 여기는 물러선다.
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
      </div>
      {/* 칩은 전부 선다 — 줄바꿈이 접힘(+N)을 대신한다. 그룹 어휘를 잃는 것은 변형 B의
          재가된 트레이드오프이고, 그룹 순서(환경→작업→기계)만 배열로 남긴다. */}
      <div className="settings-pane-chips" role="group" aria-label={t("settings.pane.chipsAria")}>
        {chips.map((chip) => (
          <SettingsChip
            key={chip.id}
            label={chip.label}
            help={chip.help}
            active={chip.id === activeId}
            onSelect={() => selectSection(chip.id)}
          />
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
          {/* 레일 없는 모바일과 공유하는 본문에는 데스크톱 재질 설정만 추가한다. */}
          {renderSettingsSection(activeId, state, saving, pluginSections, t, {
            themeCardExtras: <ChromeMaterialRows />,
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 그룹 칩. 도움말이 있는 칩은 별도 '?' 없이 칩 자체가 hover 말풍선을 연다 — 칩은 이미
 * 버튼이라 옆에 버튼을 하나 더 세우면 한 줄에 누를 것이 둘이 된다. 말풍선은 hover·포커스
 * 동안만 서고 클릭은 그대로 섹션 선택이다. aria-describedby로 보조기기에도 같은 글이 읽힌다.
 */
function SettingsChip({ label, help, active, onSelect }: {
  readonly label: string;
  readonly help?: string | undefined;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const bubbleId = useId();
  const [open, setOpen] = useState(false);
  const button = (
    <button
      type="button"
      className={`settings-chip${active ? " is-active" : ""}`}
      aria-pressed={active}
      aria-describedby={help ? bubbleId : undefined}
      onClick={onSelect}
      onFocus={help ? () => setOpen(true) : undefined}
      onBlur={help ? () => setOpen(false) : undefined}
    >
      {label}
    </button>
  );
  if (!help) return button;
  return (
    <span className="settings-chip-slot" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {button}
      <div className="settings-help-tip__bubble" role="tooltip" id={bubbleId} hidden={!open}>
        {help}
      </div>
    </span>
  );
}

/**
 * 크롬 재질 손잡이 묶음 — 좌·우 사이드바가 캔버스 위에서 어떻게 서는지를 사람이 직접 고른다.
 * 셋 다 서버 설정이 아니라 브라우저-로컬 store지만, 터미널 렌더러가 그렇듯 브라우저-로컬도
 * 설정 화면에 선다: 사람이 찾는 기준은 저장 위치가 아니라 하는 일이다.
 *
 * 순서는 재가된 배치를 지킨다 — 우측 불투명도가 "비포커스 패널 흐리기" 바로 아래 자리를
 * 계속 가지고, 좌측 손잡이 둘이 그 아래에 붙는다. 이 묶음 전체는 데스크톱 페인만
 * 주입한다: 같은 헬퍼가 사이드바도 레일도 없는 모바일의 본문이라, 직접 넣으면 폰에 죽은
 * 슬라이더 셋이 선다.
 */
function ChromeMaterialRows() {
  return (
    <>
      <RailOpacityRow />
      <SideBarOpacityRow />
      <SideBarBlurRow />
    </>
  );
}

/**
 * 우측 사이드바(레일 카드) 불투명도 — 서버 설정이 아니라 브라우저-로컬 rail-store다. 전용
 * "레일 패널" 카드는 퇴역했다 — 화면 재질을 다루는 다른 손잡이(리퀴드 글래스·패널 흐리기)와
 * 같은 테마 카드에 한 행으로 선다(재가된 배치·리네이밍).
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
      <SettingsSlider
        value={overlayAlpha}
        min={RAIL_OVERLAY_ALPHA_MIN}
        max={RAIL_OVERLAY_ALPHA_MAX}
        step={1}
        label={t("settings.theme.railOpacity")}
        formatValue={(value) => `${value}%`}
        decreaseLabel={t("settings.slider.decrease", { title: t("settings.theme.railOpacity") })}
        increaseLabel={t("settings.slider.increase", { title: t("settings.theme.railOpacity") })}
        onPreview={setRailOverlayAlpha}
        onCommit={setRailOverlayAlpha}
        defaultValue={RAIL_OVERLAY_ALPHA_DEFAULT}
        resetLabel={t("settings.slider.reset")}
        resetAriaLabel={t("settings.slider.resetAria", { title: t("settings.theme.railOpacity") })}
      />
    </div>
  );
}

/** 좌측 사이드바 카드의 불투명도 — 우측과 같은 문법이되 소유 store만 다르다(사이드바 store). */
function SideBarOpacityRow() {
  const t = useT();
  const glass = useSideBarGlass();
  return (
    <div className="global-settings-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">
          {t("settings.theme.sideBarOpacity")}
          <SettingsHelp title={t("settings.theme.sideBarOpacity")}>{t("settings.theme.sideBarOpacityHelp")}</SettingsHelp>
          <SettingsScope kind="live" />
        </p>
      </div>
      <SettingsSlider
        value={glass.alpha}
        min={SIDE_BAR_GLASS_ALPHA_MIN}
        max={SIDE_BAR_GLASS_ALPHA_MAX}
        step={1}
        label={t("settings.theme.sideBarOpacity")}
        formatValue={(value) => `${value}%`}
        decreaseLabel={t("settings.slider.decrease", { title: t("settings.theme.sideBarOpacity") })}
        increaseLabel={t("settings.slider.increase", { title: t("settings.theme.sideBarOpacity") })}
        onPreview={setSideBarGlassAlpha}
        onCommit={setSideBarGlassAlpha}
        defaultValue={SIDE_BAR_GLASS_ALPHA_DEFAULT}
        resetLabel={t("settings.slider.reset")}
        resetAriaLabel={t("settings.slider.resetAria", { title: t("settings.theme.sideBarOpacity") })}
      />
    </div>
  );
}

/**
 * 유리 게이트가 지금 이 화면에서 닫혀 있는가 — 판정은 테마·설정 추론이 아니라 **채널의 계산값**을
 * 읽어서 한다. theme.css의 게이트는 넷이고(@supports 미달 · prefers-reduced-transparency ·
 * 리퀴드 글래스 끔 · 라이트 테마), 그중 둘은 CSS에만 있어 TS가 볼 수 있는 상태가 아니다.
 * 조건을 여기서 복제하면 반드시 원본보다 좁아진다(적대 리뷰 적발: OS 투명도 줄이기에서 손잡이가
 * 살아 남아 화면에 닿지 않는 값을 저장했다). 채널을 읽으면 게이트가 몇 개든 CSS 하나가 진실이다.
 *
 * 다시 읽어야 할 계기도 CSS를 여는 것들이다: 루트의 data-theme·data-glass 속성 변화와 OS 투명도
 * 선호의 변화. 저장값 스토어가 아니라 루트 속성을 보는 이유는, 테마가 서버 하이드레이션·낙관
 * 적용·데스크톱 주입 어느 경로로 바뀌든 게이트를 실제로 여닫는 것은 이 속성이기 때문이다.
 * @supports는 런타임에 바뀌지 않으므로 최초 1회로 충분하다.
 */
function useGlassGateClosed(): boolean {
  const [closed, setClosed] = useState(readGlassGateClosed);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const read = () => setClosed(readGlassGateClosed());
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-glass"] });
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-transparency: reduce)") : null;
    media?.addEventListener("change", read);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", read);
    };
  }, []);
  return closed;
}

function readGlassGateClosed(): boolean {
  if (typeof document === "undefined") return false;
  return getComputedStyle(document.documentElement).getPropertyValue("--glass-backdrop-side-bar").trim() === "none";
}

/**
 * 좌측 사이드바 유리의 blur 반경. 불투명도와 달리 이 손잡이는 유리 게이트에 종속된다 — 게이트가
 * 닫힌 화면에는 blur가 아예 없다. 리퀴드 글래스 줄이 이미 정한 실패 양식을 그대로 따른다:
 * 화면에 없는 재질을 켜진 손잡이로 말하지 않고, 저장값은 건드리지 않아 유리가 돌아오면 고른 값이
 * 그대로 다시 선다.
 */
function SideBarBlurRow() {
  const t = useT();
  const glass = useSideBarGlass();
  const glassOff = useGlassGateClosed();
  return (
    <div className="global-settings-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">
          {t("settings.theme.sideBarBlur")}
          <SettingsHelp title={t("settings.theme.sideBarBlur")}>
            {t(glassOff ? "settings.theme.sideBarBlurOffHelp" : "settings.theme.sideBarBlurHelp")}
          </SettingsHelp>
          <SettingsScope kind="live" />
        </p>
      </div>
      <SettingsSlider
        value={glass.blur}
        min={SIDE_BAR_GLASS_BLUR_MIN}
        max={SIDE_BAR_GLASS_BLUR_MAX}
        step={2}
        disabled={glassOff}
        label={t("settings.theme.sideBarBlur")}
        formatValue={(value) => `${value}px`}
        decreaseLabel={t("settings.slider.decrease", { title: t("settings.theme.sideBarBlur") })}
        increaseLabel={t("settings.slider.increase", { title: t("settings.theme.sideBarBlur") })}
        onPreview={setSideBarGlassBlur}
        onCommit={setSideBarGlassBlur}
        defaultValue={SIDE_BAR_GLASS_BLUR_DEFAULT}
        resetLabel={t("settings.slider.reset")}
        resetAriaLabel={t("settings.slider.resetAria", { title: t("settings.theme.sideBarBlur") })}
      />
    </div>
  );
}
