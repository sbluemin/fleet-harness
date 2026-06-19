import { useEffect } from "react";

import { ModelAuthSection } from "../components/model-auth-section.js";
import { loadGlobalSettings, setGlobalSettingsField, useGlobalSettingsStore } from "../global-settings-store.js";

interface SettingToggleRowProps {
  readonly title: string;
  readonly help: string;
  readonly onLabel: string;
  readonly offLabel: string;
  readonly value: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}

export function GlobalSettings() {
  const settings = useGlobalSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;

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

      <section className="global-settings-card" aria-label="Fleet global settings">
        {settings.loading && !state ? <p className="global-settings-help">Loading settings.</p> : null}
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
        ) : null}
        <p className="global-settings-foot">Changes apply to newly launched sessions. Running sessions keep their current configuration until relaunched.</p>
      </section>

      <ModelAuthSection />
    </main>
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
