import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";
import type { PaneContext, PaneDescriptor, PaneSearchProvider } from "../../workspace/shared/pane.js";
import type { RailEntryDescriptor } from "../../workspace/shared/rail.js";
import type { SettingsSectionDescriptor, SettingsSectionGroup } from "../shared/types.js";

import { loadGlobalSettings, useGlobalSettingsStore } from "./global-settings-store.js";
import { getT, useConsoleLocale, useT } from "../../../core/client/src/i18n/index.js";
import { useFeatureRegistry } from "../../../core/client/src/integration/feature-registry.js";
import { closeRailPanel } from "../../../core/client/src/chrome/rail/rail-store.js";
import {
  buildCoreSettingsSections,
  collectPluginSettingsSections,
  renderSettingsSection,
  resolveSettingsSectionId,
  SearchIcon,
  SETTINGS_GROUP_LABEL_KEYS,
  SETTINGS_GROUP_ORDER,
  type PluginSettingsNavItem,
  type SettingsSectionId,
  type SettingsSectionNavItem,
} from "./sections.js";

/**
 * 설정 표면 — 페이지의 후계자.
 *
 * 설정은 더 이상 가는 곳이 아니라 부르는 것이다. 옛 `/settings` 페이지는 콘솔 전체를 치우고
 * 섰기 때문에, 콘솔을 보면서 돌려야 하는 설정(테마·서체)을 위해 콘솔의 축소
 * 모형까지 지어야 했다. 이 표면은 레일 페인으로 서서 뒤의 콘솔을 살려 둔다 — 콘솔 자체가
 * 미리보기다.
 *
 * 형태는 단일 primary 페인과 한 줄 글자형 목차다. 목차는 넘치면 가로로 흐르고,
 * 본문은 한 단계 그룹 제목과 행으로 선다.
 * 원격 접속 장치·링크 관리도 같은 페인에서 제공한다.
 */

import { GearGlyph, SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "./settings-entry.js";

export { GearGlyph, SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID };

/**
 * 검색 공급자는 React 밖에서 불리므로 훅으로 레지스트리를 읽을 수 없다. app 셸이 레지스트리를
 * 실을 때 이 스냅샷을 함께 갱신한다.
 * 호스트 번들 안의 모듈 상태라 호스트-플러그인 경계의 싱글턴 금지와는 무관하다.
 */
let searchPluginsSnapshot: readonly { readonly id: string | null; readonly settingsSections?: readonly SettingsSectionDescriptor[] }[] = [];

export function syncSettingsSearchPlugins(plugins: typeof searchPluginsSnapshot): void {
  searchPluginsSnapshot = plugins;
}

export interface SettingsChip {
  readonly id: SettingsSectionId;
  readonly group: SettingsSectionGroup;
  readonly label: string;
  /** 칩 옆 '?'가 여는 설명. */
  readonly help?: string;
  /** 검색이 이 섹션에 닿는 말 — 제목·플러그인 이름·키워드를 전부 합친다. */
  readonly haystack: string;
}

export function buildChips(
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
 * 칩이 없는 섹션(다른 칩 안에 묻힌 것)으로 들어온 경로를 그 칩으로 옮긴다 — 옛 주소의 표시 언어는 겉모습 칩을,
 * 실험 묶음의 플러그인 섹션은 실험 기능 칩을 연다.
 */
export function hostSectionOf(
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
  const registry = useFeatureRegistry();
  const settings = useGlobalSettingsStore();
  const state = settings.state;
  const saving = settings.savingFields;
  const [query, setQuery] = useState("");
  const tabs = useRef<HTMLDivElement>(null);
  const tabId = useId();
  const [fades, setFades] = useState({ start: false, end: false });

  useEffect(() => {
    void loadGlobalSettings(ctx.signal);
  }, [ctx.signal]);

  const coreSections = buildCoreSettingsSections(t, state);
  const pluginSections = collectPluginSettingsSections(registry.providers, locale, t);
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

  useEffect(() => {
    const element = tabs.current;
    if (!element) return;
    const read = () => setFades({ start: element.scrollLeft > 1, end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1 });
    const observer = new ResizeObserver(read);
    observer.observe(element);
    for (const button of element.children) observer.observe(button);
    element.addEventListener("scroll", read, { passive: true });
    read();
    return () => { observer.disconnect(); element.removeEventListener("scroll", read); };
  }, [chips.map((chip) => `${chip.id}:${chip.label}`).join("|")]);
  useEffect(() => {
    const element = tabs.current;
    const active = element?.querySelector<HTMLElement>("[aria-selected=true]");
    if (!element || !active) return;
    const rect = active.getBoundingClientRect(), parent = element.getBoundingClientRect();
    if (rect.left < parent.left) element.scrollLeft -= parent.left - rect.left + 12;
    if (rect.right > parent.right) element.scrollLeft += rect.right - parent.right + 12;
  }, [activeId]);

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
      <div className="settings-index" data-fade-start={fades.start || undefined} data-fade-end={fades.end || undefined}>
        <div ref={tabs} className="settings-index-tabs" role="tablist" aria-label={t("settings.pane.chipsAria")} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const buttons = [...(tabs.current?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? [])];
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
          buttons[next]?.click();
        }}>
          {chips.map((chip, index) => <button key={chip.id} id={`${tabId}-${index}`} type="button" className="settings-index-tab" role="tab" aria-selected={chip.id === activeId} aria-description={chip.help} title={chip.help} tabIndex={chip.id === activeId ? 0 : -1} aria-controls={matches === null ? `${tabId}-panel` : undefined} onClick={() => selectSection(chip.id)}>{chip.label}</button>)}
        </div>
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
        <div key={activeId} id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${chips.findIndex((chip) => chip.id === activeId)}`} className="settings-pane-sections">
          {renderSettingsSection(activeId, state, saving, pluginSections, t)}
        </div>
      )}
    </div>
  );
}

