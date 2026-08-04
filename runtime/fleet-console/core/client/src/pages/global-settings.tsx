import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FontPicker, type FontPickerInstalledFont, type FontPickerSelection } from "@fleet-console/font-picker/browser";
import type { ConsoleLocale, LocalizedText, Translate } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import "@fleet-console/font-picker/styles.css";
import { fetchSystemFonts, SystemFontsFetchError } from "@fleet-console/font-picker/system-fonts";

import { BackendApiSection } from "../components/backend-api-section.js";
import { propagateSettingsEntryIndex } from "../components/command-band-system-cluster.js";
import { getGlobalSettingsStoreState, loadGlobalSettings, setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";
import { renderMessage, useConsoleLocale, useT, type CoreMessageKey } from "../i18n/index.js";
import { useConsoleState } from "../hooks/use-store.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { readLastDarkTheme, setActiveTheme, setActiveUiFont } from "../store.js";
import { DEFAULT_UI_FONT, UI_FONT_BUILT_INS, UI_FONT_DESCRIPTION_KEYS, UI_FONT_SIZE_RANGE, uiFontFamily } from "../ui-font.js";
import type { GlobalSettingsState, ThemeId, UiFontId, UiFontSettings } from "../types.js";

interface LanguageOption {
  readonly id: GlobalSettingsState["language"];
  readonly label: string;
}

interface ThemeOption {
  readonly id: ThemeId;
  readonly label: string;
  readonly swatch: readonly [string, string, string];
}

interface PortModeOption {
  readonly id: GlobalSettingsState["consolePortMode"];
  readonly label: string;
}

type CoreSettingsSectionId = "general" | "backend-api";
type PluginSettingsSectionId = `${string}:${string}`;
type SettingsSectionId = CoreSettingsSectionId | PluginSettingsSectionId;

interface SettingsSectionNavItem {
  readonly id: CoreSettingsSectionId;
  readonly label: string;
  readonly eyebrow: string;
}

interface PluginSettingsNavItem {
  readonly id: PluginSettingsSectionId;
  readonly pluginId: string;
  readonly pluginLabel: string;
  readonly sectionTitle: string;
  readonly render?: () => ReactNode;
}

interface PluginSettingsNavGroup {
  readonly pluginId: string;
  readonly pluginLabel: string;
  readonly sections: readonly PluginSettingsNavItem[];
}

type T = Translate<CoreMessageKey>;

// 다크 테마 선택지 — 각 항목의 3톤 스와치는 해당 테마의 brass/aurora/ink 시그니처를 미리보기로 보존한다(콘텐츠 색이라 역할색 규칙과 무관).
// 라이트는 Whites(오트밀) 단일 테마라 카드 없이 Light|Dark 모드 스위치의 Light 자체가 선택이다.
function buildDarkThemeOptions(t: T): readonly ThemeOption[] {
  return [
    { id: "instrument", label: t("settings.theme.instrument"), swatch: ["oklch(16.5% 0.016 245)", "oklch(80% 0.085 78)", "oklch(77% 0.085 200)"] },
    { id: "maritime", label: t("settings.theme.maritime"), swatch: ["oklch(20% 0.045 248)", "oklch(78% 0.13 75)", "oklch(82% 0.13 195)"] },
    { id: "carbon", label: t("settings.theme.carbon"), swatch: ["oklch(18% 0.007 255)", "oklch(76% 0.115 62)", "oklch(80% 0.105 205)"] },
  ];
}

const LIGHT_THEME_ID: ThemeId = "whites";

function buildPortModes(t: T): readonly PortModeOption[] {
  return [
    { id: "dynamic", label: t("settings.port.dynamic") },
    { id: "static", label: t("settings.port.static") },
  ];
}

function buildLanguages(t: T): readonly LanguageOption[] {
  return [
    { id: "auto", label: t("settings.language.auto") },
    { id: "en", label: t("settings.language.en") },
    { id: "ko", label: t("settings.language.ko") },
  ];
}

function buildCoreSettingsSections(t: T): readonly SettingsSectionNavItem[] {
  return [
    { id: "general", label: t("settings.core.general.label"), eyebrow: t("settings.core.general.eyebrow") },
    { id: "backend-api", label: t("settings.core.backendApi.label"), eyebrow: t("settings.core.backendApi.eyebrow") },
  ];
}

const MIN_CONSOLE_STATIC_PORT = 1024;
const MAX_CONSOLE_STATIC_PORT = 65535;

export function GlobalSettings() {
  const settings = useGlobalSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>("general");
  const location = useLocation();
  const navigate = useNavigate();
  const registry = usePluginRegistry();
  const locale = useConsoleLocale();
  const t = useT();
  const coreSections = buildCoreSettingsSections(t);
  const pluginSections = collectPluginSettingsSections(registry.plugins, locale, t);
  const pluginGroups = groupPluginSettingsSections(pluginSections);
  const selectSection = (sectionId: SettingsSectionId) => {
    setActiveSectionId(sectionId);
    // 설정 토글 버튼이 닫힐 때 설정 구간 전체를 소비하려면 진입 마커가 필요하다 —
    // 이 push는 state 없이 새 항목을 만들므로 마커를 명시적으로 전파한다.
    navigate(
      { pathname: "/settings", search: sectionId === "general" ? "" : `?section=${encodeURIComponent(sectionId)}` },
      { state: propagateSettingsEntryIndex(null) },
    );
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadGlobalSettings(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const requested = new URLSearchParams(location.search).get("section");
    const available = new Set<SettingsSectionId>([...coreSections.map((section) => section.id), ...pluginSections.map((section) => section.id)]);
    const next = requested && available.has(requested as SettingsSectionId) ? requested as SettingsSectionId : "general";
    setActiveSectionId(next);
    if (requested && requested !== next) navigate({ pathname: "/settings", search: "" }, { replace: true });
  }, [location.search, navigate, coreSections, pluginSections]);

  return (
    <main className="global-settings-page">
      <section className="global-settings-hero" aria-labelledby="global-settings-title">
        <div>
          <p className="bridge-kicker">{t("settings.kicker")}</p>
          <h2 id="global-settings-title">{t("settings.title")}</h2>
        </div>
        <div className="global-settings-status" role="status" aria-live="polite">
          {saving ? t("settings.saving") : ""}
        </div>
      </section>

      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}

      <section className="global-settings-grid">
        <div className="global-settings-list" aria-label={t("settings.sectionsAria")}>
          <p className="global-settings-nav-group">{t("settings.nav.console")}</p>
          {coreSections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`global-settings-nav-item ${section.id === activeSectionId ? "is-active" : ""}`}
              aria-pressed={section.id === activeSectionId}
              onClick={() => selectSection(section.id)}
            >
              <span className="global-settings-nav-label">{section.label}</span>
              <span className="global-settings-nav-eyebrow">{section.eyebrow}</span>
            </button>
          ))}
          {pluginSections.length > 0 ? (
            <>
              <p className="global-settings-nav-group">{t("settings.nav.plugins")}</p>
              {pluginGroups.map((group) => (
                <div key={group.pluginId} className="global-settings-plugin-group">
                  <p className="global-settings-plugin-heading">{group.pluginLabel}</p>
                  {group.sections.map((section) => (
                    <button
                      key={section.id}
                      type="button"
                      className={`global-settings-nav-item ${section.id === activeSectionId ? "is-active" : ""}`}
                      aria-pressed={section.id === activeSectionId}
                      onClick={() => selectSection(section.id)}
                    >
                      <span className="global-settings-nav-label">{section.sectionTitle}</span>
                      <span className="global-settings-nav-eyebrow">{section.pluginLabel}</span>
                    </button>
                  ))}
                </div>
              ))}
            </>
          ) : null}
        </div>

        <div key={activeSectionId} className="global-settings-detail">
          {renderSettingsSection(activeSectionId, state, saving, pluginSections, t)}
        </div>
      </section>
    </main>
  );
}

// 플러그인 render()를 경계 자손의 렌더 단계에서 호출해야 동기 throw가 PluginErrorBoundary에 잡힌다.
function PluginSettingsSectionBody({ render }: { readonly render: () => ReactNode }) {
  return <>{render()}</>;
}

function renderSettingsSection(sectionId: SettingsSectionId, state: GlobalSettingsState | null, saving: boolean, pluginSections: readonly PluginSettingsNavItem[], t: T) {
  if (sectionId.includes(":")) {
    const pluginSection = pluginSections.find((section) => section.id === sectionId);
    return pluginSection?.render ? (
      <PluginErrorBoundary fallback={<div className="fc-plugin-error">{t("settings.pluginFailed")}</div>}>
        <PluginSettingsSectionBody render={pluginSection.render} />
      </PluginErrorBoundary>
    ) : <p className="global-settings-help">{t("settings.pluginUnavailable")}</p>;
  }
  switch (sectionId) {
    case "general":
      return (
        <>
          <ThemeCard state={state} saving={saving} />
          <TypographyCard state={state} saving={saving} />
          <GeneralSettingsCard state={state} saving={saving} />
        </>
      );
    case "backend-api":
      return <BackendApiSection />;
  }
}

function collectPluginSettingsSections(
  plugins: readonly { readonly id: string; readonly settingsSections?: readonly { readonly id: string; readonly title: LocalizedText; readonly render?: () => ReactNode }[] }[],
  locale: ConsoleLocale,
  t: T,
): readonly PluginSettingsNavItem[] {
  return plugins.flatMap((plugin) =>
    (plugin.settingsSections ?? []).map((section) => ({
      id: `${plugin.id}:${section.id}` as const,
      pluginId: plugin.id,
      pluginLabel: formatPluginLabel(plugin.id, t),
      sectionTitle: resolveLocalizedText(section.title, locale),
      render: section.render,
    })),
  );
}

function groupPluginSettingsSections(sections: readonly PluginSettingsNavItem[]): readonly PluginSettingsNavGroup[] {
  const groups: PluginSettingsNavGroup[] = [];
  for (const section of sections) {
    const last = groups.at(-1);
    if (last?.pluginId === section.pluginId) {
      groups[groups.length - 1] = { ...last, sections: [...last.sections, section] };
      continue;
    }
    groups.push({ pluginId: section.pluginId, pluginLabel: section.pluginLabel, sections: [section] });
  }
  return groups;
}

function formatPluginLabel(pluginId: string, t: T): string {
  if (pluginId === "terminal") return t("settings.plugin.terminal");
  return pluginId.split(/[-_]/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || pluginId;
}

function ThemeCard({
  state,
  saving,
}: {
  readonly state: GlobalSettingsState | null;
  readonly saving: boolean;
}) {
  const t = useT();
  const darkThemes = buildDarkThemeOptions(t);
  const activeTheme = state?.theme ?? "instrument";
  const isLight = activeTheme === LIGHT_THEME_ID;
  const selectTheme = (theme: ThemeId) => {
    if (getGlobalSettingsStoreState().savingField !== null) return;
    const previousTheme = activeTheme;
    setActiveTheme(theme);
    void setGlobalSettingsField("theme", theme).then((saved) => {
      if (!saved) setActiveTheme(previousTheme);
    });
  };
  const selectMode = (mode: "light" | "dark") => {
    if ((mode === "light") === isLight) return;
    selectTheme(mode === "light" ? LIGHT_THEME_ID : readLastDarkTheme());
  };
  return (
    <section className="global-settings-card" aria-label={t("settings.theme.aria")}>
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">{t("settings.theme.title")}</p>
          <p className="global-settings-help">{t("settings.theme.help")}</p>
          <p className="global-settings-help global-settings-theme-cli-note">{t("settings.theme.cliNote")}</p>
        </div>
        <div className="theme-picker" role="group" aria-label={t("settings.theme.aria")}>
          {/* 상호배타 2버튼이지만 radio 대신 aria-pressed 토글 그룹을 쓴다 — radiogroup은 roving
              tabindex+화살표 탐색 구현 의무가 생기고, 기존 테마 카드(aria-pressed) 문법과도 일치한다. */}
          <div className="theme-mode-seg" role="group" aria-label={t("settings.theme.aria")}>
            <button
              type="button"
              aria-pressed={isLight}
              className={isLight ? "is-active" : ""}
              disabled={saving}
              onClick={() => selectMode("light")}
            >
              <SunIcon />
              {t("settings.theme.group.light")}
            </button>
            <button
              type="button"
              aria-pressed={!isLight}
              className={isLight ? "" : "is-active"}
              disabled={saving}
              onClick={() => selectMode("dark")}
            >
              <MoonIcon />
              {t("settings.theme.group.dark")}
            </button>
          </div>
          {/* 닫힌 트레이는 inert로 봉인한다 — tabIndex=-1은 팔레트 포커스 복원 같은 프로그램적
              focus()를 막지 못해 aria-hidden 내부에 포커스가 남는 AT 결함이 생긴다. */}
          <div className={`theme-dark-tray ${isLight ? "" : "is-open"}`} inert={isLight || undefined}>
            {darkThemes.map((theme) => {
              const isActive = theme.id === activeTheme;
              return (
                <button
                  key={theme.id}
                  type="button"
                  aria-pressed={isActive}
                  className={`theme-card ${isActive ? "is-active" : ""}`}
                  disabled={saving}
                  onClick={() => selectTheme(theme.id)}
                >
                  <span className="theme-card-swatch" aria-hidden="true">
                    {theme.swatch.map((color) => <i key={color} style={{ background: color }} />)}
                  </span>
                  <span className="theme-card-label">{theme.label}</span>
                  <span className="theme-card-check" aria-hidden="true">{isActive ? <CheckIcon /> : null}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <p className="global-settings-foot">{t("settings.theme.foot")}</p>
    </section>
  );
}

function TypographyCard({
  state,
  saving,
}: {
  readonly state: GlobalSettingsState | null;
  readonly saving: boolean;
}) {
  const t = useT();
  const activeUiFont = state?.uiFont ?? DEFAULT_UI_FONT;
  const [installedFonts, setInstalledFonts] = useState<readonly FontPickerInstalledFont[]>([]);
  const [fontsLoading, setFontsLoading] = useState(true);
  const [fontsError, setFontsError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSystemFonts({ signal: controller.signal }).then((response) => {
      setInstalledFonts(response.fonts.filter((font) => font.uiSuitable).map(({ family, monospace }) => ({ family, monospace })));
      setFontsError(null);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setInstalledFonts([]);
        // SystemFontsFetchError는 고정 영문 메시지를 담고 오므로 그대로 노출하면 로케일을 벗어난다.
        // 예상된 탐색 실패는 카탈로그 문구로 바꾸고, 예상 밖 오류만 원문을 남긴다.
        const expected = error instanceof SystemFontsFetchError;
        setFontsError(!expected && error instanceof Error ? error.message : t("settings.typography.fontsLoadError"));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setFontsLoading(false);
    });
    return () => controller.abort();
  }, [t]);

  const saveUiFont = (uiFont: UiFontSettings) => {
    if (getGlobalSettingsStoreState().savingField !== null) return;
    const previousUiFont = activeUiFont;
    setActiveUiFont(uiFont);
    void setGlobalSettingsField("uiFont", uiFont).then((saved) => {
      if (!saved) setActiveUiFont(previousUiFont);
    });
  };

  const selectUiFont = (selection: FontPickerSelection) => {
    const uiFont: UiFontSettings = selection.source === "builtin"
      ? { source: "builtin", id: selection.id as UiFontId, size: activeUiFont.size }
      : { source: "system", familyName: selection.familyName, size: activeUiFont.size };
    saveUiFont(uiFont);
  };

  return (
    <section className="global-settings-card" aria-label={t("settings.typography.aria")}>
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">{t("settings.typography.title")}</p>
          <p className="global-settings-help">{t("settings.typography.help")}</p>
        </div>
        <button
          type="button"
          className="typography-reset"
          disabled={!state || saving || activeUiFont.source === "builtin" && activeUiFont.id === "manrope" && activeUiFont.size === UI_FONT_SIZE_RANGE.defaultValue}
          onClick={() => saveUiFont(DEFAULT_UI_FONT)}
        >
          {t("settings.typography.reset")}
        </button>
      </div>
      <FontPicker
        builtIns={UI_FONT_BUILT_INS.map(({ id, label, family, aliases }) => ({
          id,
          label,
          family,
          aliases,
          description: t(UI_FONT_DESCRIPTION_KEYS[id]),
        }))}
        installedFonts={installedFonts}
        selected={activeUiFont.source === "builtin" ? { source: "builtin", id: activeUiFont.id } : { source: "system", familyName: activeUiFont.familyName }}
        selectedSystemFont={activeUiFont.source === "system" ? activeUiFont.familyName : null}
        fallbackStack={uiFontFamily(DEFAULT_UI_FONT)}
        previewText={t("settings.typography.preview")}
        size={activeUiFont.size}
        sizeRange={UI_FONT_SIZE_RANGE}
        loading={fontsLoading}
        error={fontsError}
        disabled={!state || saving}
        labels={{
          browserAria: t("settings.typography.picker.browserAria"),
          searchLabel: t("settings.typography.picker.searchLabel"),
          searchPlaceholder: t("settings.typography.picker.searchPlaceholder"),
          loading: t("settings.typography.picker.loading"),
          choicesAria: t("settings.typography.picker.choicesAria"),
          builtInGroup: t("settings.typography.picker.builtInGroup"),
          installedGroup: t("settings.typography.picker.installedGroup"),
          noMatch: t("settings.typography.picker.noMatch"),
          preview: t("settings.typography.picker.preview"),
          available: t("settings.typography.picker.available"),
          unavailable: t("settings.typography.picker.unavailable"),
          fontSizeAria: t("settings.typography.picker.fontSizeAria"),
          decreaseSizeAria: t("settings.typography.picker.decreaseSizeAria"),
          sizeValueAria: t("settings.typography.picker.sizeValueAria"),
          increaseSizeAria: t("settings.typography.picker.increaseSizeAria"),
          sizeSliderAria: t("settings.typography.picker.sizeSliderAria"),
          monospace: t("settings.typography.picker.monospace"),
          systemFont: t("settings.typography.picker.systemFont"),
          savedSystemFont: t("settings.typography.picker.savedSystemFont"),
        }}
        onSelectionChange={selectUiFont}
        onSizeCommit={(size) => saveUiFont({ ...activeUiFont, size })}
      />
      <p className="global-settings-foot">{t("settings.typography.foot")}</p>
    </section>
  );
}

function GeneralSettingsCard({
  state,
  saving,
}: {
  readonly state: GlobalSettingsState | null;
  readonly saving: boolean;
}) {
  const t = useT();
  const consoleState = useConsoleState();
  return (
    <section className="global-settings-card" aria-label={t("settings.general.aria")}>
      {state ? (
        <>
          <ConsolePortSettings state={state} saving={saving} consoleState={consoleState} />
          <PanelMotionSettings state={state} saving={saving} />
          <LanguageSettings state={state} saving={saving} />
        </>
      ) : (
        <p className="global-settings-help">{t("settings.general.loading")}</p>
      )}
      <p className="global-settings-foot">{t("settings.general.foot")}</p>
    </section>
  );
}

function PanelMotionSettings({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  return (
    <div className="global-settings-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">{t("settings.panelMotion.title")}</p>
        <p className="global-settings-help">{t("settings.panelMotion.help")}</p>
      </div>
      <button
        type="button"
        aria-pressed={state.reducePanelMotion}
        className={`global-settings-toggle ${state.reducePanelMotion ? "is-on" : ""}`}
        disabled={saving}
        onClick={() => void setGlobalSettingsField("reducePanelMotion", !state.reducePanelMotion)}
      >
        {t("settings.panelMotion.toggle")}
      </button>
    </div>
  );
}

function LanguageSettings({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const languages = buildLanguages(t);
  return (
    <div className="global-settings-row is-stack language-settings-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">{t("settings.language.title")}</p>
        <p className="global-settings-help">{t("settings.language.help")}</p>
      </div>
      <div className="segmented language-picker" role="group" aria-label={t("settings.language.aria")}>
        {languages.map((language) => {
          const isActive = state.language === language.id;
          return (
            <button
              key={language.id}
              type="button"
              aria-pressed={isActive}
              className={`segmented-option ${isActive ? "is-active" : ""}`}
              disabled={saving}
              onClick={() => void setGlobalSettingsField("language", language.id)}
            >
              {language.label}
            </button>
          );
        })}
      </div>
      <p className="console-port-note">{t("settings.language.note")}</p>
    </div>
  );
}

function ConsolePortSettings({
  state,
  saving,
  consoleState,
}: {
  readonly state: GlobalSettingsState;
  readonly saving: boolean;
  readonly consoleState: ReturnType<typeof useConsoleState>;
}) {
  const t = useT();
  const portModes = buildPortModes(t);
  const [draftPort, setDraftPort] = useState(state.consoleStaticPort?.toString() ?? "");
  const effectivePort = consoleState.effectivePort;
  const fallbackActive = consoleState.portMode === "static" && !consoleState.portHonored;
  // runtimeRequestedPort는 마지막 기동에서 실제로 시도한 포트(런타임 사실)이고,
  // 다음 재시작 동작은 저장된 설정(state)으로 안내해야 한다 — 둘을 섞으면 오안내가 된다.
  const runtimeRequestedPort = consoleState.requestedPort;
  const nextRestartStatic = state.consolePortMode === "static" && state.consoleStaticPort !== null;
  const trimmedDraftPort = draftPort.trim();
  const parsedPort = Number(trimmedDraftPort);
  const draftHasValue = trimmedDraftPort.length > 0;
  const draftIsValid = draftHasValue && isValidConsoleStaticPort(parsedPort);
  const draftIsInvalid = state.consolePortMode === "static" && draftHasValue && !draftIsValid;

  useEffect(() => {
    setDraftPort(state.consoleStaticPort?.toString() ?? "");
  }, [state.consoleStaticPort]);

  return (
    <div className="global-settings-row is-stack console-port-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">{t("settings.port.title")} <span className="new-badge">{t("settings.port.newBadge")}</span></p>
        <p className="global-settings-help">
          {t("settings.port.help")}
        </p>
      </div>
      <div className="console-port-control">
        <div className="segmented" role="group" aria-label={t("settings.port.modeAria")}>
          {portModes.map((mode) => {
            const isActive = state.consolePortMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                aria-pressed={isActive}
                className={`segmented-option ${isActive ? "is-active" : ""}`}
                disabled={saving}
                onClick={() => void setGlobalSettingsField("consolePortMode", mode.id)}
              >
                {mode.label}
              </button>
            );
          })}
        </div>

        <div className={`console-port-reveal ${state.consolePortMode === "static" ? "is-open" : ""}`}>
          <div className="console-port-reveal-inner">
            <label className="console-port-input-label" htmlFor="console-static-port-input">{t("settings.port.staticPort")}</label>
            <input
              id="console-static-port-input"
              className={`console-port-input ${draftIsInvalid ? "is-invalid" : ""}`}
              inputMode="numeric"
              placeholder="8080"
              value={draftPort}
              disabled={saving}
              aria-invalid={draftIsInvalid}
              aria-describedby="console-static-port-hint"
              onChange={(event) => {
                const next = event.target.value;
                setDraftPort(next);
                const nextPort = Number(next.trim());
                if (isValidConsoleStaticPort(nextPort)) void setGlobalSettingsField("consoleStaticPort", nextPort);
              }}
            />
            <span id="console-static-port-hint" className={`console-port-hint ${draftIsInvalid ? "is-invalid" : ""}`}>
              {t("settings.port.hint")}
            </span>
          </div>
        </div>

        <div className={`console-port-effective ${fallbackActive ? "is-fallback" : ""}`} aria-live="polite">
          <span className="console-port-effective-dot" aria-hidden="true" />
          <div>
            <p className="console-port-effective-label">{t("settings.port.currentlyReachable")}</p>
            <p className="console-port-effective-value">
              127.0.0.1:<span>{effectivePort || "..."}</span>{fallbackActive ? t("settings.port.dynamicSuffix") : ""}
            </p>
          </div>
        </div>

        {fallbackActive && runtimeRequestedPort ? (
          <div className="console-port-warning" role="status">
            {renderMessage(t("settings.port.fallback"), {
              port: <strong>{runtimeRequestedPort}</strong>,
              mode: <strong>{t("settings.port.dynamic")}</strong>,
              host: <strong>{`127.0.0.1:${effectivePort || "..."}`}</strong>,
            })}{" "}
            {nextRestartStatic
              ? renderMessage(t("settings.port.nextRestartStatic"), {
                  port: <strong>{state.consoleStaticPort}</strong>,
                })
              : t("settings.port.nextRestartDynamic")}
          </div>
        ) : null}

        <p className="console-port-note">{t("settings.port.note")}</p>
      </div>
    </div>
  );
}

function isValidConsoleStaticPort(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_CONSOLE_STATIC_PORT && value <= MAX_CONSOLE_STATIC_PORT;
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5 12.5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 1.2v1.8M8 13v1.8M1.2 8H3M13 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M3.2 12.8l1.3-1.3M11.5 4.5l1.3-1.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.2 9.4A5.6 5.6 0 1 1 6.6 2.8a4.4 4.4 0 0 0 6.6 6.6Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
