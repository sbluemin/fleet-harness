import { useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";

import { BackendApiSection } from "../components/backend-api-section.js";
import { loadGlobalSettings, useGlobalSettingsStore } from "../global-settings-store.js";
import { useConsoleLocale, useT, type CoreMessageKey } from "../i18n/index.js";
import {
  collectPluginSettingsSections,
  ConsolePortCard,
  LanguageCard,
  PluginSettingsSectionBody,
  RemoteAccessSection,
  ThemeCard,
  TypographyCard,
  type PluginSettingsNavItem,
} from "../pages/global-settings.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { DEFAULT_UI_FONT, UI_FONT_BUILT_INS } from "../ui-font.js";
import type { GlobalSettingsState, ThemeId } from "../types.js";
import "../styles/mobile.css";

/**
 * The phone's Settings surface. The desktop keeps a section list beside the section it opens; on a
 * phone that list has nowhere to stand beside anything, so it takes the screen and pushes the
 * section below the fold. Here the two are separate destinations: the list is a screen, and opening
 * a row is a navigation, so the section that was asked for gets the whole width.
 *
 * The section lives in the URL rather than in state, which is what makes the platform back gesture
 * return to the list instead of leaving Settings.
 */

type MobileSectionId = "appearance" | "console" | "remote-access" | "backend-api" | `${string}:${string}`;

interface MobileSettingsRow {
  readonly id: MobileSectionId;
  readonly title: string;
  /** What this row currently holds, so the list answers without being opened. */
  readonly value: string | null;
  readonly icon: ReactNode;
}

interface MobileSettingsGroup {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly MobileSettingsRow[];
}

/** A detail screen was reached from the list here, so its Back retraces that step. */
interface MobileSettingsLocationState {
  readonly mobileSettingsEntry?: true;
}

export function MobileSettingsPage() {
  const settings = useGlobalSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;
  const registry = usePluginRegistry();
  const locale = useConsoleLocale();
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    void loadGlobalSettings(controller.signal);
    return () => controller.abort();
  }, []);

  const pluginSections = collectPluginSettingsSections(registry.plugins, locale, t);
  const groups = buildMobileSettingsGroups(state, pluginSections, t);
  const requested = new URLSearchParams(location.search).get("section");
  const active = groups.flatMap((group) => group.rows).find((row) => row.id === requested) ?? null;

  const open = (id: MobileSectionId) => {
    const entry: MobileSettingsLocationState = { mobileSettingsEntry: true };
    navigate({ pathname: "/settings", search: `?section=${encodeURIComponent(id)}` }, { state: entry });
  };
  const close = () => {
    // Popping is only correct when the entry above is this list. A direct load or a reload has no
    // such entry, and popping there would leave the Console entirely.
    if ((location.state as MobileSettingsLocationState | null)?.mobileSettingsEntry) { navigate(-1); return; }
    navigate({ pathname: "/settings", search: "" }, { replace: true });
  };

  // An unknown section — a stale link, or one whose plugin is gone — resolves to the list rather
  // than to an empty screen, and the address is corrected so a reload does not repeat the miss.
  useEffect(() => {
    if (requested === null || active !== null || state === null) return;
    navigate({ pathname: "/settings", search: "" }, { replace: true });
  }, [active, navigate, requested, state]);

  if (active !== null) {
    return (
      <section className="mobile-settings-page" aria-labelledby="mobile-settings-detail-title">
        <header className="mobile-list-header">
          <button type="button" className="mobile-settings-back" onClick={close} aria-label={t("mobile.settings.back")}>
            <BackIcon />
          </button>
          <h1 id="mobile-settings-detail-title">{active.title}</h1>
          <span className="mobile-settings-saving" role="status" aria-live="polite">{saving ? t("settings.saving") : ""}</span>
        </header>
        <div className="mobile-settings-scroll">
          <div className="mobile-settings-detail">
            {settings.error !== null ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
            {renderMobileSection(active.id, state, saving, pluginSections, t)}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mobile-settings-page" aria-labelledby="mobile-settings-title">
      <header className="mobile-list-header">
        <h1 id="mobile-settings-title">{t("mobile.tabs.settings")}</h1>
      </header>
      <div className="mobile-settings-scroll">
        <div className="mobile-settings-groups">
          {settings.error !== null ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
          {groups.map((group) => (
            <div className="mobile-settings-group" key={group.key}>
              <p className="mobile-settings-group-label">{group.label}</p>
              <div className="mobile-settings-rows">
                {group.rows.map((row) => (
                  <button type="button" className="mobile-settings-row" key={row.id} onClick={() => open(row.id)}>
                    <span className="mobile-settings-row-icon" aria-hidden="true">{row.icon}</span>
                    <span className="mobile-settings-row-copy">
                      <strong>{row.title}</strong>
                      {row.value === null ? null : <span>{row.value}</span>}
                    </span>
                    <span className="mobile-operation-chevron" aria-hidden="true">›</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function renderMobileSection(
  sectionId: MobileSectionId,
  state: GlobalSettingsState | null,
  saving: boolean,
  pluginSections: readonly PluginSettingsNavItem[],
  t: (key: CoreMessageKey) => string,
): ReactNode {
  if (sectionId.includes(":")) {
    const plugin = pluginSections.find((section) => section.id === sectionId);
    return plugin?.render ? (
      <PluginErrorBoundary fallback={<div className="fc-plugin-error">{t("settings.pluginFailed")}</div>}>
        <PluginSettingsSectionBody render={plugin.render} />
      </PluginErrorBoundary>
    ) : <p className="global-settings-help">{t("settings.pluginUnavailable")}</p>;
  }
  switch (sectionId) {
    case "appearance":
      return <><ThemeCard state={state} saving={saving} /><TypographyCard state={state} saving={saving} /></>;
    case "console":
      if (state === null) return <p className="global-settings-help">{t("settings.general.loading")}</p>;
      return <><ConsolePortCard state={state} saving={saving} /><LanguageCard state={state} saving={saving} /></>;
    case "remote-access":
      if (state === null) return <p className="global-settings-help">{t("settings.general.loading")}</p>;
      return state.remoteAccess === undefined ? null : <RemoteAccessSection remote={state.remoteAccess} saving={saving} />;
    case "backend-api":
      return <BackendApiSection />;
  }
}

/**
 * The desktop's "General" holds theme, type, port and language in one section because a wide
 * column can carry all four. A row that stood for all four could not say what it holds, so the
 * phone splits it where the summaries split: what the Console looks like, and how it runs.
 */
function buildMobileSettingsGroups(
  state: GlobalSettingsState | null,
  pluginSections: readonly PluginSettingsNavItem[],
  t: (key: CoreMessageKey) => string,
): readonly MobileSettingsGroup[] {
  const consoleRows: MobileSettingsRow[] = [
    { id: "appearance", title: t("mobile.settings.appearance"), value: describeAppearance(state, t), icon: <AppearanceIcon /> },
    { id: "console", title: t("mobile.settings.console"), value: describeConsole(state, t), icon: <ConsoleIcon /> },
  ];
  // Absent remoteAccess means this Console does not carry the feature at all; the desktop drops the
  // section rather than showing an empty one, and the phone follows that reading.
  if (state === null || state.remoteAccess !== undefined) {
    consoleRows.push({
      id: "remote-access",
      title: t("settings.core.connectivity.label"),
      value: state?.remoteAccess === undefined ? null : t(state.remoteAccess.enabled ? "mobile.settings.on" : "mobile.settings.off"),
      icon: <RemoteIcon />,
    });
  }
  consoleRows.push({ id: "backend-api", title: t("settings.core.backendApi.label"), value: null, icon: <ApiIcon /> });

  const groups: MobileSettingsGroup[] = [{ key: "console", label: t("settings.group.machine"), rows: consoleRows }];
  for (const section of pluginSections) {
    const last = groups.at(-1);
    const row: MobileSettingsRow = { id: section.id, title: section.sectionTitle, value: null, icon: <PluginIcon /> };
    if (last !== undefined && last.key === section.pluginId) {
      groups[groups.length - 1] = { ...last, rows: [...last.rows, row] };
      continue;
    }
    groups.push({ key: section.pluginId, label: section.pluginLabel, rows: [row] });
  }
  return groups;
}

function describeAppearance(state: GlobalSettingsState | null, t: (key: CoreMessageKey) => string): string | null {
  if (state === null) return null;
  return [themeLabel(state.theme, t), fontLabel(state)].join(" · ");
}

function describeConsole(state: GlobalSettingsState | null, t: (key: CoreMessageKey) => string): string | null {
  if (state === null) return null;
  const language = state.language === "auto" ? t("settings.language.auto") : state.language === "ko" ? t("settings.language.ko") : t("settings.language.en");
  return [language, t(state.consolePortMode === "static" ? "settings.port.static" : "settings.port.dynamic")].join(" · ");
}

function themeLabel(theme: ThemeId, t: (key: CoreMessageKey) => string): string {
  switch (theme) {
    case "maritime": return t("settings.theme.maritime");
    case "carbon": return t("settings.theme.carbon");
    case "whites": return t("settings.theme.whites");
    default: return t("settings.theme.instrument");
  }
}

function fontLabel(state: GlobalSettingsState): string {
  const uiFont = state.uiFont ?? DEFAULT_UI_FONT;
  if (uiFont.source === "system") return uiFont.familyName;
  return UI_FONT_BUILT_INS.find((font) => font.id === uiFont.id)?.label ?? uiFont.id;
}

function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4.5 6.5 10l5.5 5.5" />
    </svg>
  );
}

function AppearanceIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="10" r="6.4" />
      <path d="M10 3.6v12.8" />
    </svg>
  );
}

function ConsoleIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4.5" width="14" height="11" rx="2" />
      <path d="M6.5 9 8.5 11l-2 2M11 13h3" />
    </svg>
  );
}

function RemoteIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.4 12.4a5.6 5.6 0 0 1 11.2 0M1.9 9.4a9 9 0 0 1 16.2 0" />
      <circle cx="10" cy="15.1" r="1.2" />
    </svg>
  );
}

function ApiIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7.2 4 3.6 10l3.6 6M12.8 4l3.6 6-3.6 6" />
    </svg>
  );
}

function PluginIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3.2 16 6.6v6.8L10 16.8 4 13.4V6.6Z" />
    </svg>
  );
}
