import { useEffect, useState, type ReactNode } from "react";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";

import { BackendApiSection } from "../components/backend-api-section.js";
import { getGlobalSettingsStoreState, loadGlobalSettings, setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";
import { useConsoleState } from "../hooks/use-store.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { setActiveTheme, setActiveUiFont } from "../store.js";
import type { GlobalSettingsState, ThemeId, UiFontId } from "../types.js";

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

interface UiFontOption {
  readonly id: UiFontId;
  readonly label: string;
  readonly name: string;
  readonly note: string;
  readonly family: string;
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

// 테마 선택지 — 각 항목의 3톤 스와치는 해당 테마의 brass/aurora/ink 시그니처를 미리보기로 보존한다(콘텐츠 색이라 역할색 규칙과 무관).
const THEMES: readonly ThemeOption[] = [
  { id: "maritime", label: "Maritime", swatch: ["oklch(78% 0.13 75)", "oklch(82% 0.13 195)", "oklch(32% 0.04 248)"] },
  { id: "carbon", label: "Carbon", swatch: ["oklch(76% 0.115 62)", "oklch(80% 0.105 205)", "oklch(25% 0.007 252)"] },
];

const PORT_MODES: readonly PortModeOption[] = [
  { id: "dynamic", label: "Dynamic" },
  { id: "static", label: "Static" },
];

const UI_FONT_OPTIONS: readonly UiFontOption[] = [
  { id: "manrope", label: "Fleet UI", name: "Manrope", note: "Balanced · Fleet default", family: '"Manrope Variable", "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: "jetbrains-mono", label: "Instrument Mono", name: "JetBrains Mono", note: "Uniform · technical scan", family: '"JetBrains Mono Variable", "Manrope Variable", "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: "source-code-pro", label: "Source Mono", name: "Source Code Pro", note: "Open forms · compact", family: '"Source Code Pro Variable", "Manrope Variable", "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
];

const LANGUAGES: readonly LanguageOption[] = [
  { id: "auto", label: "Auto" },
  { id: "en", label: "English" },
  { id: "ko", label: "한국어" },
];

const MIN_CONSOLE_STATIC_PORT = 1024;
const MAX_CONSOLE_STATIC_PORT = 65535;

const CORE_SETTINGS_SECTIONS: readonly SettingsSectionNavItem[] = [
  { id: "general", label: "General", eyebrow: "Theme · Type · Port" },
  { id: "backend-api", label: "Backend API", eyebrow: "Loopback routes" },
];

export function GlobalSettings() {
  const settings = useGlobalSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>("general");
  const registry = usePluginRegistry();
  const pluginSections = collectPluginSettingsSections(registry.plugins);
  const pluginGroups = groupPluginSettingsSections(pluginSections);

  useEffect(() => {
    const controller = new AbortController();
    void loadGlobalSettings(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <main className="global-settings-page">
      <section className="global-settings-hero" aria-labelledby="global-settings-title">
        <div>
          <p className="bridge-kicker">Fleet Control Surface</p>
          <h2 id="global-settings-title">Settings</h2>
        </div>
        <div className="global-settings-status" role="status" aria-live="polite">
          {saving ? "Saving…" : ""}
        </div>
      </section>

      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}

      <section className="global-settings-grid">
        <div className="global-settings-list" aria-label="Settings sections">
          <p className="global-settings-nav-group">Console</p>
          {CORE_SETTINGS_SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`global-settings-nav-item ${section.id === activeSectionId ? "is-active" : ""}`}
              aria-pressed={section.id === activeSectionId}
              onClick={() => setActiveSectionId(section.id)}
            >
              <span className="global-settings-nav-label">{section.label}</span>
              <span className="global-settings-nav-eyebrow">{section.eyebrow}</span>
            </button>
          ))}
          {pluginSections.length > 0 ? (
            <>
              <p className="global-settings-nav-group">Plugins</p>
              {pluginGroups.map((group) => (
                <div key={group.pluginId} className="global-settings-plugin-group">
                  <p className="global-settings-plugin-heading">{group.pluginLabel}</p>
                  {group.sections.map((section) => (
                    <button
                      key={section.id}
                      type="button"
                      className={`global-settings-nav-item ${section.id === activeSectionId ? "is-active" : ""}`}
                      aria-pressed={section.id === activeSectionId}
                      onClick={() => setActiveSectionId(section.id)}
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
          {renderSettingsSection(activeSectionId, state, saving, pluginSections)}
        </div>
      </section>
    </main>
  );
}

function renderSettingsSection(sectionId: SettingsSectionId, state: GlobalSettingsState | null, saving: boolean, pluginSections: readonly PluginSettingsNavItem[]) {
  if (sectionId.includes(":")) {
    const pluginSection = pluginSections.find((section) => section.id === sectionId);
    return pluginSection?.render ? (
      <PluginErrorBoundary fallback={<div className="fc-plugin-error">Plugin settings failed to render.</div>}>
        {pluginSection.render()}
      </PluginErrorBoundary>
    ) : <p className="global-settings-help">Plugin settings unavailable.</p>;
  }
  switch (sectionId) {
    case "general":
      return (
        <>
          <ThemeCard saving={saving} />
          <TypographyCard state={state} saving={saving} />
          <GeneralSettingsCard state={state} saving={saving} />
        </>
      );
    case "backend-api":
      return <BackendApiSection />;
  }
}

function collectPluginSettingsSections(plugins: readonly { readonly id: string; readonly settingsSections?: readonly { readonly id: string; readonly title: string; readonly render?: () => ReactNode }[] }[]): readonly PluginSettingsNavItem[] {
  return plugins.flatMap((plugin) =>
    (plugin.settingsSections ?? []).map((section) => ({
      id: `${plugin.id}:${section.id}` as const,
      pluginId: plugin.id,
      pluginLabel: formatPluginLabel(plugin.id),
      sectionTitle: section.title,
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

function formatPluginLabel(pluginId: string): string {
  if (pluginId === "terminal") return "Terminal";
  return pluginId.split(/[-_]/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || pluginId;
}

function ThemeCard({ saving }: { readonly saving: boolean }) {
  const { activeTheme } = useConsoleState();
  const selectTheme = (theme: ThemeId) => {
    if (getGlobalSettingsStoreState().savingField !== null) return;
    const previousTheme = activeTheme;
    setActiveTheme(theme);
    void setGlobalSettingsField("theme", theme).then((saved) => {
      if (!saved) setActiveTheme(previousTheme);
    });
  };
  return (
    <section className="global-settings-card" aria-label="Theme">
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">Theme</p>
          <p className="global-settings-help">Console color scheme. Applies immediately and is saved server-side.</p>
        </div>
        {/* role="group" + aria-pressed — 단일선택 패턴. 선택 = brass(지금 보고 있는 곳). */}
        <div className="theme-picker" role="group" aria-label="Theme">
          {THEMES.map((theme) => {
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
      <p className="global-settings-foot">Theme applies immediately and is stored server-side.</p>
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
  const activeUiFont = state?.uiFont ?? "manrope";
  const selectUiFont = (uiFont: UiFontId) => {
    if (getGlobalSettingsStoreState().savingField !== null) return;
    const previousUiFont = activeUiFont;
    setActiveUiFont(uiFont);
    void setGlobalSettingsField("uiFont", uiFont).then((saved) => {
      if (!saved) setActiveUiFont(previousUiFont);
    });
  };

  return (
    <section className="global-settings-card" aria-label="Typography">
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">Typography</p>
          <p className="global-settings-help">Typeface for interface text and reading surfaces. Display, code, and terminal fonts stay unchanged.</p>
        </div>
        <button
          type="button"
          className="typography-reset"
          disabled={!state || saving || activeUiFont === "manrope"}
          onClick={() => selectUiFont("manrope")}
        >
          Reset to Fleet default
        </button>
      </div>
      <div className="font-cards" role="group" aria-label="Global UI font">
        {UI_FONT_OPTIONS.map((font) => {
          const isActive = activeUiFont === font.id;
          return (
            <button
              key={font.id}
              type="button"
              aria-pressed={isActive}
              className={`font-card ${isActive ? "is-active" : ""}`}
              disabled={!state || saving}
              onClick={() => selectUiFont(font.id)}
            >
              <span className="fc-name">
                <span>{font.label}</span>
                <span className="fc-check" aria-hidden="true">{isActive ? <CheckIcon /> : null}</span>
              </span>
              <span className="fc-sample" style={{ fontFamily: font.family }}>{font.name}</span>
              <span className="fc-meta">{font.note}</span>
            </button>
          );
        })}
      </div>
      <p className="global-settings-foot">Typography applies immediately and is stored server-side for every browser and restart.</p>
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
  const consoleState = useConsoleState();
  return (
    <section className="global-settings-card" aria-label="General">
      {state ? (
        <>
          <ConsolePortSettings state={state} saving={saving} consoleState={consoleState} />
          <LanguageSettings state={state} saving={saving} />
        </>
      ) : (
        <p className="global-settings-help">Loading settings.</p>
      )}
      <p className="global-settings-foot">Changes apply to newly launched sessions. Running sessions keep their current configuration until relaunched.</p>
    </section>
  );
}

function LanguageSettings({ state, saving }: { readonly state: GlobalSettingsState; readonly saving: boolean }) {
  return (
    <div className="global-settings-row is-stack language-settings-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">Release notes language</p>
        <p className="global-settings-help">Choose the language for What's New. Auto follows this browser's language.</p>
      </div>
      <div className="segmented language-picker" role="group" aria-label="Release notes language">
        {LANGUAGES.map((language) => {
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
      <p className="console-port-note">Stored with Console settings and shared across every browser.</p>
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
        <p className="global-settings-resp-title">Console Port <span className="new-badge">New</span></p>
        <p className="global-settings-help">
          Dynamic lets the OS pick a free loopback port each time the console starts. Static pins a port you choose so the console URL stays the same across restarts.
        </p>
      </div>
      <div className="console-port-control">
        <div className="segmented" role="group" aria-label="Console port mode">
          {PORT_MODES.map((mode) => {
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
            <label className="console-port-input-label" htmlFor="console-static-port-input">Static port</label>
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
              1024–65535
            </span>
          </div>
        </div>

        <div className={`console-port-effective ${fallbackActive ? "is-fallback" : ""}`} aria-live="polite">
          <span className="console-port-effective-dot" aria-hidden="true" />
          <div>
            <p className="console-port-effective-label">Currently reachable on</p>
            <p className="console-port-effective-value">
              127.0.0.1:<span>{effectivePort || "..."}</span>{fallbackActive ? " · Dynamic" : ""}
            </p>
          </div>
        </div>

        {fallbackActive && runtimeRequestedPort ? (
          <div className="console-port-warning" role="status">
            Port <strong>{runtimeRequestedPort}</strong> was unavailable — the console fell back to a <strong>Dynamic</strong> port and is running on <strong>127.0.0.1:{effectivePort || "..."}</strong>.{" "}
            {nextRestartStatic ? (
              <>Next restart will try <strong>{state.consoleStaticPort}</strong>.</>
            ) : (
              <>Next restart will use a dynamic port.</>
            )}
          </div>
        ) : null}

        <p className="console-port-note">Applies when the console restarts. Console-wide — shared across every browser.</p>
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
