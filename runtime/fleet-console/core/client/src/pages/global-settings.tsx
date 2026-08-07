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
import { createRemoteAccessLink, fetchRemoteAccessStatus, revokeRemoteAccessLink, revokeRemoteAccessSession, rotateRemoteIdentity } from "../global-settings-api.js";
import { getGlobalSettingsStoreState, loadGlobalSettings, setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";
import { renderMessage, useConsoleLocale, useT, type CoreMessageKey } from "../i18n/index.js";
import { useConsoleState } from "../hooks/use-store.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { readLastDarkTheme, setActiveTheme, setActiveUiFont, themePolarity } from "../store.js";
import { DEFAULT_UI_FONT, UI_FONT_BUILT_INS, UI_FONT_DESCRIPTION_KEYS, UI_FONT_SIZE_RANGE, uiFontFamily } from "../ui-font.js";
import type { GlobalSettingsState, RemoteAccessLink, RemoteAccessStatus, ThemeId, UiFontId, UiFontSettings } from "../types.js";

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
    // 이 push는 state 없이 새 항목을 만들므로 현재 항목의 마커를 명시적으로 전파한다.
    // 마커 없는 방문(직접 로드·리로드)에서 push하면 원본 설정 항목이 고아가 되어
    // Back이 설정을 다시 열으므로, 마커가 없을 때는 섹션 이동을 replace로 처리한다.
    const nextState = propagateSettingsEntryIndex(
      "settingsEntry" in ((location.state ?? {}) as Record<string, unknown>)
        ? location.state
        : { settingsEntry: null },
    );
    const marked = typeof nextState.settingsEntry === "number";
    navigate(
      { pathname: "/settings", search: sectionId === "general" ? "" : `?section=${encodeURIComponent(sectionId)}` },
      { replace: !marked, state: nextState },
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
    if (requested && requested !== next) navigate({ pathname: "/settings", search: "" }, { replace: true, state: propagateSettingsEntryIndex(location.state) });
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
  const isLight = themePolarity(activeTheme) === "light";
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
          <RemoteAccessSettings state={state} saving={saving} />
          <LanguageSettings state={state} saving={saving} />
        </>
      ) : (
        <p className="global-settings-help">{t("settings.general.loading")}</p>
      )}
      <p className="global-settings-foot">{t("settings.general.foot")}</p>
    </section>
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

/** 바인드 주소는 이 기기가 실제로 가진 주소여야 하므로, 루프백은 서버와 같은 규칙으로 여기서도 막는다. */
const REMOTE_BIND_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252}[A-Za-z0-9])?)$/u;
const REMOTE_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const REMOTE_GRANT_TTL_MINUTES = 15;
const ROTATE_ARM_TIMEOUT_MS = 5_000;

function isValidRemoteBindHost(value: string): boolean {
  return REMOTE_BIND_HOST.test(value) && !REMOTE_LOOPBACK_HOSTS.has(value);
}

function RemoteAccessSettings({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const remote = state.remoteAccess;
  const [draftHost, setDraftHost] = useState(remote.bindHost ?? "");
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [link, setLink] = useState<RemoteAccessLink | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"create" | "rotate" | "revoke" | null>(null);
  const [copied, setCopied] = useState(false);
  const [rotateArmed, setRotateArmed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => { setDraftHost(remote.bindHost ?? ""); }, [remote.bindHost]);

  // blur만으로 무장을 풀면 안 된다 — macOS 브라우저는 버튼 클릭에 포커스를 주지 않아,
  // 무장 상태가 조용히 남았다가 한참 뒤의 첫 클릭이 곧바로 갱신을 실행한다.
  useEffect(() => {
    if (!rotateArmed) return;
    const timer = setTimeout(() => setRotateArmed(false), ROTATE_ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [rotateArmed]);

  // 설정값이 아니라 실제 리스너를 읽는다 — 켜 두었지만 바인드에 실패한 상태가 보여야 한다.
  useEffect(() => {
    const controller = new AbortController();
    void fetchRemoteAccessStatus(controller.signal)
      .then(setStatus)
      .catch(() => { if (!controller.signal.aborted) setStatus(null); });
    return () => controller.abort();
  }, [remote.enabled, remote.bindHost, reloadToken]);

  const trimmedHost = draftHost.trim();
  const hostIsValid = isValidRemoteBindHost(trimmedHost);
  const hostIsInvalid = trimmedHost.length > 0 && !hostIsValid;
  const refresh = () => setReloadToken((token) => token + 1);

  const save = (next: { readonly enabled: boolean; readonly bindHost: string | null }) => {
    // 링크는 자격이다. 대상이 바뀌거나 리스너가 닫히는 순간 화면에서도 사라져야 한다.
    setLink(null);
    setActionError(null);
    setRotateArmed(false);
    void setGlobalSettingsField("remoteAccess", next);
  };

  const run = (kind: "create" | "rotate" | "revoke", action: () => Promise<unknown>) => {
    setBusy(kind);
    setActionError(null);
    void action()
      .then((result) => { if (kind === "create") setLink(result as RemoteAccessLink); })
      .catch((error: unknown) => { setActionError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { setBusy(null); refresh(); });
  };

  const rotate = () => {
    if (!rotateArmed) {
      setRotateArmed(true);
      return;
    }
    setRotateArmed(false);
    // 갱신하면 화면에 남은 링크도 더는 통하지 않는다.
    setLink(null);
    run("rotate", rotateRemoteIdentity);
  };

  const copy = () => {
    if (!link) return;
    void navigator.clipboard.writeText(link.link).then(() => setCopied(true)).catch(() => setCopied(false));
  };

  return (
    <div className="global-settings-row is-stack remote-access-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">{t("settings.remote.title")} <span className="new-badge">{t("settings.port.newBadge")}</span></p>
        <p className="global-settings-help">{t("settings.remote.help")}</p>
      </div>
      <div className="console-port-control">
        {/* 끄기의 파급은 스위치를 보는 순간에만 필요한 정보다 — 상시 문구로 두면 조작 열을
            바깥으로 밀어낸다. 숨겨도 aria-describedby가 가리키므로 화면 낭독기에는 남는다. */}
        <div className="remote-access-toggle">
          <div className="segmented" role="group" aria-label={t("settings.remote.modeAria")} aria-describedby="remote-access-note">
            <button
              type="button"
              aria-pressed={!remote.enabled}
              className={`segmented-option ${remote.enabled ? "" : "is-active"}`}
              disabled={saving}
              onClick={() => { if (remote.enabled) save({ enabled: false, bindHost: remote.bindHost }); }}
            >
              {t("settings.remote.off")}
            </button>
            <button
              type="button"
              aria-pressed={remote.enabled}
              className={`segmented-option ${remote.enabled ? "is-active" : ""}`}
              disabled={saving || !hostIsValid}
              onClick={() => { if (!remote.enabled && hostIsValid) save({ enabled: true, bindHost: trimmedHost }); }}
            >
              {t("settings.remote.on")}
            </button>
          </div>
          <p id="remote-access-note" role="tooltip" className="settings-hover-note">{t("settings.remote.note")}</p>
        </div>

        <div className="console-port-reveal is-open">
          <div className="console-port-reveal-inner">
            <label className="console-port-input-label" htmlFor="remote-access-host-input">{t("settings.remote.hostLabel")}</label>
            <input
              id="remote-access-host-input"
              className={`console-port-input ${hostIsInvalid ? "is-invalid" : ""}`}
              placeholder="192.168.1.20"
              value={draftHost}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={hostIsInvalid}
              aria-describedby="remote-access-host-hint"
              onChange={(event) => setDraftHost(event.target.value)}
              onBlur={() => {
                const next = draftHost.trim();
                if (next === (remote.bindHost ?? "") || !isValidRemoteBindHost(next)) return;
                save({ enabled: remote.enabled, bindHost: next });
              }}
            />
            <span id="remote-access-host-hint" className={`console-port-hint ${hostIsInvalid ? "is-invalid" : ""}`}>
              {t("settings.remote.hostHint")}
            </span>
          </div>
        </div>

        <div className={`console-port-effective ${status?.lastError ? "is-fallback" : ""}`} aria-live="polite">
          <span className="console-port-effective-dot" aria-hidden="true" />
          <span>
            {status?.listening && status.origin
              ? renderMessage(t("settings.remote.listening"), { origin: status.origin })
              : status?.lastError
                ? t(remoteErrorKey(status.lastError))
                : t("settings.remote.notListening")}
          </span>
        </div>

        {status?.listening && status.fingerprint ? (
          <div className="remote-access-identity">
            <p className="remote-access-fingerprint">
              <span className="remote-access-fingerprint-label">{t("settings.remote.fingerprintLabel")}</span>
              <code>{status.fingerprint}</code>
            </p>
            <button
              type="button"
              className={`remote-access-rotate ${rotateArmed ? "is-armed" : ""}`}
              disabled={busy !== null}
              onClick={rotate}
              onBlur={() => setRotateArmed(false)}
            >
              {busy === "rotate" ? t("settings.remote.rotate.busy") : rotateArmed ? t("settings.remote.rotate.arm") : t("settings.remote.rotate")}
            </button>
            <span className="console-port-hint">{t("settings.remote.rotate.help")}</span>
          </div>
        ) : null}

        {status?.listening ? (
          <div className="remote-access-link">
            <button type="button" className="remote-access-create" disabled={busy !== null} onClick={() => run("create", createRemoteAccessLink)}>
              {busy === "create" ? t("settings.remote.creating") : t("settings.remote.create")}
            </button>
            {link ? (
              <>
                <label className="console-port-input-label" htmlFor="remote-access-link-output">{t("settings.remote.linkLabel")}</label>
                <div className="remote-access-link-field">
                  <input id="remote-access-link-output" className="console-port-input" readOnly value={link.link} onFocus={(event) => event.currentTarget.select()} />
                  <button type="button" onClick={copy}>{copied ? t("settings.remote.copied") : t("settings.remote.copy")}</button>
                </div>
                <span className="console-port-hint">{renderMessage(t("settings.remote.expires"), { minutes: REMOTE_GRANT_TTL_MINUTES })}</span>
                <p className="remote-access-open-in">{t("settings.remote.openIn")}</p>
              </>
            ) : null}
            {actionError ? <p className="global-settings-error" role="alert">{actionError}</p> : null}
            <p className="remote-access-warning">{t("settings.remote.warning")}</p>

            <RemoteAccessLedger
              title={t("settings.remote.links.title")}
              empty={t("settings.remote.links.empty")}
              action={t("settings.remote.revoke")}
              busy={busy !== null}
              rows={(status.links ?? []).map((entry) => ({
                key: entry.id,
                primary: renderMessage(t("settings.remote.links.issued"), { time: formatClockTime(entry.issuedAt) }),
                secondary: renderMessage(t("settings.remote.links.expires"), { time: formatClockTime(entry.expiresAt) }),
                onAction: () => run("revoke", () => revokeRemoteAccessLink(entry.id)),
              }))}
            />
            <RemoteAccessLedger
              title={t("settings.remote.sessions.title")}
              empty={t("settings.remote.sessions.empty")}
              action={t("settings.remote.disconnect")}
              busy={busy !== null}
              rows={(status.sessions ?? []).map((entry) => ({
                key: entry.handle,
                primary: renderMessage(t("settings.remote.sessions.opened"), { time: formatClockTime(entry.openedAt) }),
                secondary: renderMessage(t("settings.remote.sessions.lastSeen"), { time: formatClockTime(entry.lastSeenAt) }),
                onAction: () => run("revoke", () => revokeRemoteAccessSession(entry.handle)),
              }))}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface RemoteAccessLedgerRow {
  readonly key: string;
  readonly primary: ReactNode;
  readonly secondary: ReactNode;
  readonly onAction: () => void;
}

/** 발급된 자격의 목록. 자격 자체는 실리지 않고, 언제 생겼고 언제 죽는지만 보여준다. */
function RemoteAccessLedger({
  title,
  empty,
  action,
  busy,
  rows,
}: {
  readonly title: string;
  readonly empty: string;
  readonly action: string;
  readonly busy: boolean;
  readonly rows: readonly RemoteAccessLedgerRow[];
}) {
  return (
    <section className="remote-access-ledger" aria-label={title}>
      <p className="remote-access-fingerprint-label">{title}</p>
      {rows.length === 0
        ? <p className="console-port-hint">{empty}</p>
        : (
          <ul>
            {rows.map((row) => (
              <li key={row.key}>
                <span className="remote-access-ledger-when">{row.primary}<span className="remote-access-ledger-until">{row.secondary}</span></span>
                <button type="button" disabled={busy} onClick={row.onAction}>{action}</button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

/** 목록의 시간은 상대 표기가 아니라 시계 시각으로 — 만료가 언제인지 세지 않아도 되게 한다. */
function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function remoteErrorKey(code: string): CoreMessageKey {
  switch (code) {
    case "bind_address_unavailable": return "settings.remote.error.bind_address_unavailable";
    case "bind_address_in_use": return "settings.remote.error.bind_address_in_use";
    case "bind_permission_denied": return "settings.remote.error.bind_permission_denied";
    default: return "settings.remote.error.remote_listener_failed";
  }
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
