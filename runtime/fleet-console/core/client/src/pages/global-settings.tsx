import { useEffect, useState, type ReactNode } from "react";
import { plugins } from "virtual:fleet-plugins";

import { BackendApiSection } from "../components/backend-api-section.js";
import { ModelAuthSection } from "../components/model-auth-section.js";
import { loadGlobalSettings, setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";
import { useConsoleState } from "../hooks/use-store.js";
import { setActiveTheme, setCustomTerminalFont, setTerminalFont, setTerminalFontSize, setTerminalRenderer } from "../store.js";
import { CURATED_TERMINAL_FONTS, TERMINAL_FONT_SIZE_RANGE, curatedTerminalFontById, resolveTerminalFont } from "../terminal-font.js";
import type { GlobalSettingsState, TerminalFontId, TerminalFontSettings, TerminalRenderer, ThemeId } from "../types.js";

interface ThemeOption {
  readonly id: ThemeId;
  readonly label: string;
  readonly swatch: readonly [string, string, string];
}

interface RendererOption {
  readonly id: TerminalRenderer;
  readonly label: string;
}

interface PortModeOption {
  readonly id: GlobalSettingsState["consolePortMode"];
  readonly label: string;
}

interface TerminalFontCardProps {
  readonly active: boolean;
  readonly font: {
    readonly id: TerminalFontId;
    readonly name: string;
    readonly family: string;
    readonly meta: string;
  };
  readonly onSelect: () => void;
}

type CoreSettingsSectionId = "appearance" | "general" | "model-auth" | "backend-api";
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

const RENDERERS: readonly RendererOption[] = [
  { id: "webgl", label: "WebGL" },
  { id: "dom", label: "DOM" },
];

const PORT_MODES: readonly PortModeOption[] = [
  { id: "dynamic", label: "Dynamic" },
  { id: "static", label: "Static" },
];

const MIN_CONSOLE_STATIC_PORT = 1024;
const MAX_CONSOLE_STATIC_PORT = 65535;

const CORE_SETTINGS_SECTIONS: readonly SettingsSectionNavItem[] = [
  { id: "appearance", label: "Appearance", eyebrow: "Theme · Renderer" },
  { id: "general", label: "General", eyebrow: "Port" },
  { id: "model-auth", label: "Model Auth", eyebrow: "Sign-in" },
  { id: "backend-api", label: "Backend API", eyebrow: "Loopback routes" },
];

export function GlobalSettings() {
  const settings = useGlobalSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>("appearance");
  const pluginSections = collectPluginSettingsSections();
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
    return pluginSection?.render ? pluginSection.render() : <p className="global-settings-help">Plugin settings unavailable.</p>;
  }
  switch (sectionId) {
    case "appearance":
      return <AppearanceCard />;
    case "general":
      return <GeneralSettingsCard state={state} saving={saving} />;
    case "model-auth":
      return <ModelAuthSection />;
    case "backend-api":
      return <BackendApiSection />;
  }
}

function collectPluginSettingsSections(): readonly PluginSettingsNavItem[] {
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

// 외관 설정 — 테마, 터미널 렌더러, 터미널 폰트. 콘솔 로컬(브라우저별) 선호값이며 선택 즉시 적용된다(세션 설정과 달리 재실행 불요).
function AppearanceCard() {
  const { activeTheme, terminalRenderer, terminalFont } = useConsoleState();
  const resolution = resolveTerminalFont(terminalFont);
  const currentFontLabel = terminalFontLabel(terminalFont);
  return (
    <section className="global-settings-card" aria-label="Appearance">
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">Theme</p>
          <p className="global-settings-help">Console color scheme. Applies immediately and is remembered on this browser.</p>
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
                onClick={() => setActiveTheme(theme.id)}
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

      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">Terminal Renderer</p>
          <p className="global-settings-help">WebGL paints the terminal on the GPU for sharper, faster output; DOM is a compatibility fallback. Switching applies to the live terminal instantly without dropping the session.</p>
        </div>
        <div className="segmented" role="group" aria-label="Terminal renderer">
          {RENDERERS.map((renderer) => {
            const isActive = renderer.id === terminalRenderer;
            return (
              <button
                key={renderer.id}
                type="button"
                aria-pressed={isActive}
                className={`segmented-option ${isActive ? "is-active" : ""}`}
                onClick={() => setTerminalRenderer(renderer.id)}
              >
                {renderer.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="global-settings-row is-stack">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">Terminal Font <span className="new-badge">New</span></p>
          <p className="global-settings-help" id="terminal-font-help">Typeface and size for every terminal panel — agent-cli and shell alike. Applies live to all open terminals; remembered on this browser.</p>
        </div>

        <div className="font-control" aria-describedby="terminal-font-help">
          <div className="current-readout" aria-live="polite">
            <span className="cr-label">Currently</span>
            <span className="cr-value">{currentFontLabel}</span>
            <span className="cr-sep">·</span>
            <span className="cr-value">{terminalFont.size}px</span>
            <span className="cr-sep">·</span>
            <span className={`cr-value ${resolution.status === "fallback" ? "is-fallback" : "is-ok"}`}>{resolution.status}</span>
          </div>

          <div className="font-cards" role="group" aria-label="Terminal font family">
            {CURATED_TERMINAL_FONTS.map((font) => (
              <TerminalFontCard
                key={font.id}
                font={font}
                active={terminalFont.source === "curated" && terminalFont.id === font.id}
                onSelect={() => setTerminalFont(font.id)}
              />
            ))}
            <button
              type="button"
              aria-pressed={terminalFont.source === "custom"}
              className={`font-card ${terminalFont.source === "custom" ? "is-active" : ""}`}
              onClick={() => {
                if (terminalFont.source !== "custom") setCustomTerminalFont("");
              }}
            >
              <span className="fc-name">Custom…<span className="fc-check" aria-hidden="true">✓</span></span>
              <span className="fc-sample is-custom" aria-hidden="true">type a font</span>
              <span className="fc-meta">your installed face</span>
              <span className="fc-bundled fc-addon">local OS font</span>
            </button>
          </div>

          <div className={`custom-reveal ${terminalFont.source === "custom" ? "is-open" : ""}`}>
            <div className="font-field-wrap">
              <label className="font-field">
                <span className="field-icon" aria-hidden="true">Aa</span>
                <input
                  type="text"
                  spellCheck={false}
                  value={terminalFont.customName}
                  placeholder="e.g. MesloLGS NF, Fira Code, IBM Plex Mono"
                  aria-label="Custom terminal font family"
                  onChange={(event) => setCustomTerminalFont(event.currentTarget.value)}
                />
              </label>
              <div className={`resolve-chip ${resolution.status === "fallback" ? "is-fallback" : "is-ok"}`} aria-live="polite">
                <span className="rc-dot" aria-hidden="true" />
                <span>{terminalFontResolveText(terminalFont)}</span>
              </div>
            </div>
          </div>

          <div className="size-row">
            <div className="size-stepper" role="group" aria-label="Font size">
              <button
                type="button"
                aria-label="Decrease terminal font size"
                disabled={terminalFont.size <= TERMINAL_FONT_SIZE_RANGE.min}
                onClick={() => setTerminalFontSize(terminalFont.size - 1)}
              >
                −
              </button>
              <span className="size-val">{terminalFont.size}<span> px</span></span>
              <button
                type="button"
                aria-label="Increase terminal font size"
                disabled={terminalFont.size >= TERMINAL_FONT_SIZE_RANGE.max}
                onClick={() => setTerminalFontSize(terminalFont.size + 1)}
              >
                +
              </button>
            </div>
            <span className="size-label">Cell size — rescales every panel; zoom stays relative</span>
          </div>
        </div>
      </div>

      <p className="global-settings-foot">Appearance preferences apply immediately and are stored per browser, separate from session settings.</p>
    </section>
  );
}

function TerminalFontCard({ active, font, onSelect }: TerminalFontCardProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`font-card ${active ? "is-active" : ""}`}
      onClick={onSelect}
    >
      <span className="fc-name">{font.name}<span className="fc-check" aria-hidden="true">✓</span></span>
      <span className="fc-sample" style={{ fontFamily: font.family }} aria-hidden="true">Ag 0O ─┼ =&gt;</span>
      <span className="fc-meta">{font.meta}</span>
      <span className="fc-bundled">self-hosted</span>
    </button>
  );
}

function terminalFontLabel(font: TerminalFontSettings): string {
  if (font.source === "custom") return font.customName || `${curatedTerminalFontById(null).name} (default)`;
  return curatedTerminalFontById(font.id).name;
}

function terminalFontResolveText(font: TerminalFontSettings): string {
  if (!font.customName) return `Empty — using default ${curatedTerminalFontById(null).name}`;
  const resolution = resolveTerminalFont(font);
  return resolution.status === "resolved"
    ? `"${font.customName}" resolves on this machine`
    : `"${font.customName}" not found — falls back to ${resolution.fallbackName}`;
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
        </>
      ) : (
        <p className="global-settings-help">Loading settings.</p>
      )}
      <p className="global-settings-foot">Changes apply to newly launched sessions. Running sessions keep their current configuration until relaunched.</p>
    </section>
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
