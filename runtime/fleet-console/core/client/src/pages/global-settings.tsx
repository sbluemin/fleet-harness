import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FontPicker, type FontPickerInstalledFont, type FontPickerSelection } from "@fleet-console/font-picker/browser";
import type { ConsoleLocale, LocalizedText, Translate } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import "@fleet-console/font-picker/styles.css";
import { fetchSystemFonts, SystemFontsFetchError } from "@fleet-console/font-picker/system-fonts";

import { AddHostDialog } from "../components/add-host-dialog.js";
import { BackendApiSection } from "../components/backend-api-section.js";
import { propagateSettingsEntryIndex } from "../components/command-band-system-cluster.js";
import { createRemoteAccessLink, fetchRemoteAccessStatus, revokeRemoteAccessDevice, revokeRemoteAccessLink, revokeRemoteAccessSession, rotateRemoteIdentity } from "../global-settings-api.js";
import { getGlobalSettingsStoreState, loadGlobalSettings, setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";
import { renderMessage, useConsoleLocale, useT, type CoreMessageKey } from "../i18n/index.js";
import { isDesktopShell } from "../desktop-shell.js";
import { forgetRemoteHost, probeRemoteHost, refreshRemoteHosts, renameRemoteHost, useRemoteHosts, type RemoteHost, type RemoteHostReach } from "../remote-hosts.js";
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

type CoreSettingsSectionId = "general" | "remote-access" | "backend-api";
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
    { id: "remote-access", label: t("settings.core.remoteAccess.label"), eyebrow: t("settings.core.remoteAccess.eyebrow") },
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
    case "remote-access":
      return state ? <RemoteAccessSection state={state} saving={saving} /> : <p className="global-settings-help">{t("settings.general.loading")}</p>;
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

/**
 * Settings → Remote access. 시안 그대로 네 덩어리다 — 경고 배너, 수신 주소, 이 콘솔의 신원,
 * 액세스 링크와 그것을 쓴 기기들. 각 카드는 자기 사실만 말하고 서로의 상태를 추측하지 않는다.
 */
const REMOTE_BIND_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252}[A-Za-z0-9])?)$/u;
// 서버의 isValidRemoteBindHost와 같은 집합. 와일드카드는 루프백과 같은 포트를 다투므로 값이 아니다.
const REMOTE_UNUSABLE_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const REMOTE_GRANT_TTL_MINUTES = 15;
const ROTATE_ARM_TIMEOUT_MS = 5_000;

function isValidRemoteBindHost(value: string): boolean {
  return REMOTE_BIND_HOST.test(value) && !REMOTE_UNUSABLE_HOSTS.has(value);
}

function RemoteAccessSection({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  const t = useT();
  const remote = state.remoteAccess;
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [link, setLink] = useState<RemoteAccessLink | null>(null);
  const [monitoringOnly, setMonitoringOnly] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"create" | "rotate" | "revoke" | null>(null);
  const [copied, setCopied] = useState(false);
  const [rotateArmed, setRotateArmed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetchRemoteAccessStatus(controller.signal)
      .then(setStatus)
      .catch(() => { if (!controller.signal.aborted) setStatus(null); });
    return () => controller.abort();
  }, [remote.enabled, remote.bindHost, reloadToken]);

  useEffect(() => {
    if (!rotateArmed) return;
    const timer = setTimeout(() => setRotateArmed(false), ROTATE_ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [rotateArmed]);

  const refresh = () => setReloadToken((token) => token + 1);
  const save = (next: { readonly enabled: boolean; readonly bindHost: string | null }) => {
    setLink(null);
    setActionError(null);
    setRotateArmed(false);
    // 저장은 낙관적 상태를 먼저 쓴다. 그 값에 걸린 위 effect는 서버가 리스너를 다시 세우기 전에
    // 상태를 읽고, 뒤이어 도착하는 응답은 값이 같아 effect를 다시 깨우지 않는다 — 저장이 끝난 뒤
    // 한 번 더 읽지 않으면 신원과 링크는 새로 고침 전까지 예전 값에 머문다.
    void setGlobalSettingsField("remoteAccess", next).finally(refresh);
  };
  const run = (kind: "create" | "rotate" | "revoke", action: () => Promise<unknown>) => {
    setBusy(kind);
    setActionError(null);
    void action()
      .then((result) => { if (kind === "create") { setLink(result as RemoteAccessLink); setCopied(false); } })
      .catch((error: unknown) => { setActionError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { setBusy(null); refresh(); });
  };

  return (
    <>
      <section className="global-settings-card remote-section" aria-label={t("settings.remote.title")}>
        <header className="remote-section-head">
          {/* 성숙도 표시는 아래 .remote-danger(보안 경고)와 다른 것을 말한다 — 하나는 "아직 바뀔 수
              있다", 하나는 "켜면 이 기계가 열린다"이므로 한 줄로 합치지 않는다. */}
          <h3>
            {t("settings.remote.title")}
            <span className="experimental-badge">{t("common.experimental")}</span>
          </h3>
          <p>{t("settings.remote.lede")}</p>
        </header>

        <p className="remote-danger" role="note">
          <WarningIcon />
          <span><strong>{t("settings.remote.danger.lead")}</strong> {t("settings.remote.danger.rest")}</span>
        </p>

        <RemoteHostsCard />

        <RemoteListenerCard
          state={state}
          saving={saving}
          status={status}
          onSave={save}
        />

        <RemoteIdentityCard
          status={status}
          armed={rotateArmed}
          busy={busy}
          onRotate={() => {
            if (!rotateArmed) { setRotateArmed(true); return; }
            setRotateArmed(false);
            setLink(null);
            run("rotate", rotateRemoteIdentity);
          }}
        />

        {status?.listening ? (
          <RemoteLinksCard
            status={status}
            link={link}
            copied={copied}
            monitoringOnly={monitoringOnly}
            busy={busy}
            onMonitoringOnly={setMonitoringOnly}
            onCreate={() => run("create", () => createRemoteAccessLink(monitoringOnly ? "monitoring" : "full"))}
            onCopy={() => {
              if (!link) return;
              void navigator.clipboard.writeText(link.link).then(() => setCopied(true)).catch(() => setCopied(false));
            }}
            onRevokeLink={(id) => run("revoke", () => revokeRemoteAccessLink(id))}
            onRevokeSession={(handle) => run("revoke", () => revokeRemoteAccessSession(handle))}
            onRevokeDevice={(id) => run("revoke", () => revokeRemoteAccessDevice(id))}
          />
        ) : null}

        {actionError ? <p className="global-settings-error" role="alert">{actionError}</p> : null}
      </section>
    </>
  );
}

/**
 * 다른 콘솔로 건너가는 목록. 스위처의 "호스트 관리"가 닿는 곳이라 이 섹션의 첫 카드다.
 *
 * 더하는 일은 이 카드가 하지 않는다 — 액세스 링크 입력은 스위처와 공유하는 팝업 하나가
 * 소유한다(AddHostDialog). 이 카드는 이미 등록된 콘솔을 보고 고치고 지우는 자리다.
 */
function RemoteHostsCard() {
  const t = useT();
  const hosts = useRemoteHosts();
  const [addOpen, setAddOpen] = useState(false);
  const [reach, setReach] = useState<Readonly<Record<string, RemoteHostReach | "checking">>>({});
  const addRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void refreshRemoteHosts(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    for (const host of hosts) {
      void probeRemoteHost(host.id, controller.signal)
        .then((result) => setReach((previous) => ({ ...previous, [host.id]: result })))
        .catch(() => undefined);
    }
    return () => controller.abort();
  }, [hosts]);

  return (
    <div className="remote-card" data-remote-card="hosts">
      <div className="remote-card-head">
        <p className="remote-card-title">{t("settings.remote.hosts.title")}</p>
        <button ref={addRef} type="button" className="remote-create" onClick={() => setAddOpen(true)}>
          {t("chrome.hosts.add")}
        </button>
      </div>
      <p className="remote-card-help">{t("settings.remote.hosts.help")}</p>

      {hosts.length === 0 ? (
        <p className="remote-hosts-empty">{t("settings.remote.hosts.empty")}</p>
      ) : (
        <ul className="remote-hosts">
          {hosts.map((host) => (
            <RemoteHostRow key={host.id} host={host} reach={reach[host.id]} />
          ))}
        </ul>
      )}

      <p className="remote-card-help">{t("settings.remote.hosts.pinned")}</p>
      {addOpen ? <AddHostDialog openerRef={addRef} onClose={() => setAddOpen(false)} /> : null}
    </div>
  );
}

function RemoteHostRow({ host, reach }: { readonly host: RemoteHost; readonly reach: RemoteHostReach | "checking" | undefined }) {
  const t = useT();
  const [label, setLabel] = useState(host.label);
  const [busy, setBusy] = useState(false);
  const live = reach !== undefined && reach !== "checking" && reach.trusted;
  const answered = reach === undefined || reach === "checking" || reach.reachable;
  // 여는 것만 셸이 필요하다 — 추가·이름 변경·삭제는 서버가 하는 일이라 브라우저에서도 그대로다.
  const canOpen = isDesktopShell();

  return (
    <li className="remote-host">
      <span className={`remote-host-dot ${live ? "is-live" : ""}`} aria-hidden="true" />
      <span className="remote-host-text">
        <input
          className="remote-host-name"
          value={label}
          aria-label={t("settings.remote.hosts.rename")}
          maxLength={48}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={() => {
            const next = label.trim();
            if (next === host.label || next.length === 0) { setLabel(host.label); return; }
            setBusy(true);
            void renameRemoteHost(host.id, next).catch(() => setLabel(host.label)).finally(() => setBusy(false));
          }}
        />
        <small>{`${host.hostname}:${host.port} · ${canOpen ? reachLabel(reach, t) : t("settings.remote.hosts.desktopOnly")}`}</small>
      </span>
      <button
        type="button"
        className="remote-host-open"
        title={canOpen ? undefined : t("settings.remote.hosts.desktopOnly")}
        disabled={busy || !answered || !canOpen}
        onClick={() => location.assign(new URL("/console/", `${host.origin}/`).toString())}
      >
        {t("settings.remote.hosts.open")}
      </button>
      <button
        type="button"
        className="remote-revoke"
        disabled={busy}
        onClick={() => { setBusy(true); void forgetRemoteHost(host.id).finally(() => setBusy(false)); }}
      >
        {t("settings.remote.hosts.forget")}
      </button>
    </li>
  );
}

function reachLabel(reach: RemoteHostReach | "checking" | undefined, t: T): string {
  if (reach === undefined || reach === "checking") return t("settings.remote.hosts.checking");
  if (!reach.reachable) return t("settings.remote.hosts.unreachable");
  return reach.trusted ? t("settings.remote.hosts.reachable") : t("settings.remote.hosts.untrusted");
}

function RemoteListenerCard({
  state,
  saving,
  status,
  onSave,
}: {
  readonly state: GlobalSettingsState;
  readonly saving: boolean;
  readonly status: RemoteAccessStatus | null;
  readonly onSave: (next: { readonly enabled: boolean; readonly bindHost: string | null }) => void;
}) {
  const t = useT();
  const remote = state.remoteAccess;
  const candidates = status?.interfaces ?? [];
  const knownAddress = candidates.some((entry) => entry.address === remote.bindHost);
  const [custom, setCustom] = useState(knownAddress ? "" : remote.bindHost ?? "");
  const [customChosen, setCustomChosen] = useState(Boolean(remote.bindHost) && !knownAddress);

  useEffect(() => {
    if (remote.bindHost && !candidates.some((entry) => entry.address === remote.bindHost)) {
      setCustom(remote.bindHost);
      setCustomChosen(true);
    }
  }, [remote.bindHost, candidates]);

  const choose = (address: string) => {
    setCustomChosen(false);
    onSave({ enabled: remote.enabled, bindHost: address });
  };

  return (
    <div className="remote-card" data-remote-card="listener">
      <div className="remote-card-head">
        <div>
          <p className="remote-card-title">{t("settings.remote.accept.title")}</p>
          <p className="remote-card-help">{t("settings.remote.accept.help")}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={remote.enabled}
          aria-label={t("settings.remote.accept.title")}
          className={`remote-switch ${remote.enabled ? "is-on" : ""}`}
          disabled={saving || (!remote.enabled && !remote.bindHost)}
          onClick={() => onSave({ enabled: !remote.enabled, bindHost: remote.bindHost })}
        >
          <span className="remote-switch-knob" aria-hidden="true" />
        </button>
      </div>

      <div className="remote-choices" role="radiogroup" aria-label={t("settings.remote.accept.help")}>
        {candidates.map((entry) => (
          <label key={entry.address} className="remote-choice">
            <input
              type="radio"
              name="remote-bind-host"
              checked={!customChosen && remote.bindHost === entry.address}
              disabled={saving}
              onChange={() => choose(entry.address)}
            />
            <span className="remote-choice-label">{entry.label}</span>
            <code>{entry.address}</code>
          </label>
        ))}
        <label className="remote-choice">
          <input
            type="radio"
            name="remote-bind-host"
            checked={customChosen}
            disabled={saving}
            onChange={() => setCustomChosen(true)}
          />
          <span className="remote-choice-label">{t("settings.remote.accept.custom")}</span>
        </label>
        {customChosen ? (
          <div className="remote-custom">
            <input
              className={`console-port-input ${custom.trim() && !isValidRemoteBindHost(custom.trim()) ? "is-invalid" : ""}`}
              placeholder="192.168.1.20"
              value={custom}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setCustom(event.target.value)}
              onBlur={() => {
                const next = custom.trim();
                if (!isValidRemoteBindHost(next) || next === remote.bindHost) return;
                onSave({ enabled: remote.enabled, bindHost: next });
              }}
            />
            <span className="console-port-hint">{t("settings.remote.hostHint")}</span>
          </div>
        ) : null}
      </div>

      {status?.lastError ? <p className="remote-card-alert">{t(remoteErrorKey(status.lastError))}</p> : null}
    </div>
  );
}

function RemoteIdentityCard({
  status,
  armed,
  busy,
  onRotate,
}: {
  readonly status: RemoteAccessStatus | null;
  readonly armed: boolean;
  readonly busy: string | null;
  readonly onRotate: () => void;
}) {
  const t = useT();
  return (
    <div className="remote-card" data-remote-card="identity">
      <div className="remote-card-head">
        <p className="remote-card-title">{t("settings.remote.identity.title")}</p>
        <button
          type="button"
          className={`remote-rotate ${armed ? "is-armed" : ""}`}
          disabled={busy !== null || !status?.fingerprint}
          onClick={onRotate}
        >
          {busy === "rotate" ? t("settings.remote.rotate.busy") : armed ? t("settings.remote.rotate.arm") : t("settings.remote.rotate")}
        </button>
      </div>
      <p className="remote-card-help">{t("settings.remote.identity.help")}</p>
      <code className="remote-fingerprint">{status?.fingerprint ?? t("settings.remote.identity.none")}</code>
    </div>
  );
}

function RemoteLinksCard({
  status,
  link,
  copied,
  monitoringOnly,
  busy,
  onMonitoringOnly,
  onCreate,
  onCopy,
  onRevokeLink,
  onRevokeSession,
  onRevokeDevice,
}: {
  readonly status: RemoteAccessStatus;
  readonly link: RemoteAccessLink | null;
  readonly copied: boolean;
  readonly monitoringOnly: boolean;
  readonly busy: string | null;
  readonly onMonitoringOnly: (next: boolean) => void;
  readonly onCreate: () => void;
  readonly onCopy: () => void;
  readonly onRevokeLink: (id: string) => void;
  readonly onRevokeSession: (handle: string) => void;
  readonly onRevokeDevice: (id: string) => void;
}) {
  const t = useT();
  /**
   * 두 종류의 줄이 한 표에 있다. 페어링된 기기는 회수해야 사라지고, 미사용 링크는 누가 쓰면
   * 스스로 사라진다. 그래서 기기 줄에는 버튼이 둘이다 — 지금 붙어 있는 접속을 끊는 것과,
   * 그 기기를 손님 목록에서 지우는 것은 되돌릴 수 있는 정도가 다르다.
   */
  const rows = [
    ...status.devices.map((entry) => ({
      key: entry.id,
      name: entry.device ?? t("settings.remote.table.unnamedDevice"),
      access: entry.access,
      when: entry.sessionHandle === null ? formatRelative(entry.lastSeenAt, t) : t("settings.remote.table.connected"),
      disconnect: entry.sessionHandle === null ? null : () => onRevokeSession(entry.sessionHandle!),
      revoke: () => onRevokeDevice(entry.id),
      revokeLabel: t("settings.remote.unpair"),
    })),
    ...status.links.map((entry) => ({
      key: entry.id,
      name: t("settings.remote.table.unusedLink"),
      access: entry.access,
      when: renderMessage(t("settings.remote.table.expiresIn"), { minutes: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 60_000)) }),
      disconnect: null,
      revoke: () => onRevokeLink(entry.id),
      revokeLabel: t("settings.remote.revoke"),
    })),
  ];

  return (
    <div className="remote-card" data-remote-card="links">
      <div className="remote-card-head">
        <p className="remote-card-title">{t("settings.remote.links.title")}</p>
        <button type="button" className="remote-create" disabled={busy !== null} onClick={onCreate}>
          {busy === "create" ? t("settings.remote.creating") : t("settings.remote.create")}
        </button>
      </div>
      <p className="remote-card-help">{renderMessage(t("settings.remote.links.rule"), { minutes: REMOTE_GRANT_TTL_MINUTES })}</p>

      {link ? (
        <>
          <div className="remote-link-field">
            <input readOnly value={link.link} aria-label={t("settings.remote.linkLabel")} onFocus={(event) => event.currentTarget.select()} />
            <button type="button" onClick={onCopy}>{copied ? t("settings.remote.copied") : t("settings.remote.copy")}</button>
          </div>
          {/*
            링크는 인코딩된 봉투일 뿐 암호가 아니다 — 받은 쪽은 물론 그 문자열이 지나간 곳도 풀어
            볼 수 있다. 섹션 머리의 경고는 원격 접속 전체를 말하므로, 방금 만들어진 이 문자열이
            무엇을 여는지는 그 문자열 옆에서 다시 말한다. monitoring 링크는 명령을 실행하지
            못하므로 full일 때만 그 문장을 붙인다.
          */}
          {link.access === "full" ? <p className="remote-card-help">{t("settings.remote.warning")}</p> : null}
        </>
      ) : null}

      <label className="remote-monitoring">
        <input type="checkbox" checked={monitoringOnly} disabled={busy !== null} onChange={(event) => onMonitoringOnly(event.target.checked)} />
        <span>{t("settings.remote.monitoringOnly")}</span>
      </label>

      <table className="remote-table">
        <thead>
          <tr>
            <th scope="col">{t("settings.remote.table.device")}</th>
            <th scope="col">{t("settings.remote.table.access")}</th>
            <th scope="col">{t("settings.remote.table.lastUsedHead")}</th>
            <th scope="col">{t("settings.remote.table.actionsHead")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={4} className="remote-table-empty">{t("settings.remote.table.empty")}</td></tr>
          ) : rows.map((row) => (
            <tr key={row.key}>
              <td>{row.name}</td>
              <td><span className={`remote-access-chip is-${row.access}`}>{row.access}</span></td>
              <td>{row.when}</td>
              <td className="remote-row-actions">
                {row.disconnect ? (
                  <button type="button" className="remote-disconnect" disabled={busy !== null} onClick={row.disconnect}>{t("settings.remote.disconnect")}</button>
                ) : null}
                <button type="button" className="remote-revoke" disabled={busy !== null} onClick={row.revoke}>{row.revokeLabel}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 같은 셀에 "접속 중"과 나란히 서므로 이 문장도 화면 언어를 따라야 한다. */
function formatRelative(epochMs: number, t: (key: CoreMessageKey) => string): string {
  const minutes = Math.round((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return t("settings.remote.table.justNow");
  if (minutes < 60) return t("settings.remote.table.minutesAgo").replace("{minutes}", String(minutes));
  const hours = Math.round(minutes / 60);
  return hours < 24 ? t("settings.remote.table.hoursAgo").replace("{hours}", String(hours)) : new Date(epochMs).toLocaleDateString();
}

function WarningIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2.5 14.5 13.5H1.5L8 2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 6.5v3.2M8 11.6v.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
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
