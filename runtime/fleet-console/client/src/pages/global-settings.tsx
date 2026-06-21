import { useEffect, useState } from "react";

import { AgentCliSection } from "../components/agent-cli-section.js";
import { BackendApiSection } from "../components/backend-api-section.js";
import { ModelAuthSection } from "../components/model-auth-section.js";
import { loadGlobalSettings, setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";
import { useConsoleState } from "../hooks/use-store.js";
import { setActiveTheme, setTerminalRenderer } from "../store.js";
import type { GlobalSettingsState, TerminalRenderer, ThemeId } from "../types.js";

interface SettingToggleRowProps {
  readonly title: string;
  readonly help: string;
  readonly onLabel: string;
  readonly offLabel: string;
  readonly value: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}

interface ThemeOption {
  readonly id: ThemeId;
  readonly label: string;
  readonly swatch: readonly [string, string, string];
}

interface RendererOption {
  readonly id: TerminalRenderer;
  readonly label: string;
}

type SettingsSectionId = "appearance" | "general" | "agent-cli" | "backend-api";

interface SettingsSectionNavItem {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly eyebrow: string;
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

const SETTINGS_SECTIONS: readonly SettingsSectionNavItem[] = [
  { id: "appearance", label: "Appearance", eyebrow: "Theme · Renderer" },
  { id: "general", label: "General", eyebrow: "Prompt · Metaphor" },
  { id: "agent-cli", label: "Agent CLI", eyebrow: "Availability · Sign-in" },
  { id: "backend-api", label: "Backend API", eyebrow: "Loopback routes" },
];

export function GlobalSettings() {
  const settings = useGlobalSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>("appearance");

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
          {SETTINGS_SECTIONS.map((section) => (
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
        </div>

        <div key={activeSectionId} className="global-settings-detail">
          {renderSettingsSection(activeSectionId, state, saving)}
        </div>
      </section>
    </main>
  );
}

function renderSettingsSection(sectionId: SettingsSectionId, state: GlobalSettingsState | null, saving: boolean) {
  switch (sectionId) {
    case "appearance":
      return <AppearanceCard />;
    case "general":
      return <GeneralSettingsCard state={state} saving={saving} />;
    case "agent-cli":
      return (
        <>
          <AgentCliSection />
          <ModelAuthSection />
        </>
      );
    case "backend-api":
      return <BackendApiSection />;
  }
}

// 외관 설정 — 테마와 터미널 렌더러. 콘솔 로컬(브라우저별) 선호값이며 선택 즉시 적용된다(세션 설정과 달리 재실행 불요).
function AppearanceCard() {
  const { activeTheme, terminalRenderer } = useConsoleState();
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

      <p className="global-settings-foot">Appearance preferences apply immediately and are stored per browser, separate from session settings.</p>
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
  return (
    <section className="global-settings-card" aria-label="General">
      {state ? (
        <>
          <SettingToggleRow
            title="System Prompt Injection"
            help="Append keeps the Agent CLI's built-in system prompt and layers Fleet doctrine on top. Replace swaps it entirely for Fleet doctrine. Affects Claude-family CLIs only; Codex always receives doctrine through its profile."
            onLabel="Replace"
            offLabel="Append"
            value={state.replaceSystemPrompt}
            disabled={saving}
            onToggle={() => void setGlobalSettingsField("replaceSystemPrompt", !state.replaceSystemPrompt)}
          />
          <SettingToggleRow
            title="Metaphor"
            help="Enabled layers the naval tone overlay — clipped reporting cadence and Fleet vocabulary — onto every session. Off keeps the Admiral persona without the tone."
            onLabel="Enabled"
            offLabel="Off"
            value={state.enableMetaphor}
            disabled={saving}
            onToggle={() => void setGlobalSettingsField("enableMetaphor", !state.enableMetaphor)}
          />
        </>
      ) : (
        <p className="global-settings-help">Loading settings.</p>
      )}
      <p className="global-settings-foot">Changes apply to newly launched sessions. Running sessions keep their current configuration until relaunched.</p>
    </section>
  );
}

function SettingToggleRow({ title, help, onLabel, offLabel, value, disabled, onToggle }: SettingToggleRowProps) {
  return (
    <div className="global-settings-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">{title}</p>
        <p className="global-settings-help">{help}</p>
      </div>
      <button
        type="button"
        className={`global-settings-toggle ${value ? "is-on" : ""}`}
        disabled={disabled}
        aria-pressed={value}
        onClick={onToggle}
      >
        <span>{value ? onLabel : offLabel}</span>
      </button>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5 12.5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
