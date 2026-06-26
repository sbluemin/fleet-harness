import { React } from "@fleet-console/sdk/plugin/browser";
import { defineSettingsSection } from "@fleet-console/sdk/settings/browser";

import { loadSystemPromptSettings, setSystemPromptSettingsField, useSystemPromptSettingsStore } from "./settings-store.js";

interface SettingToggleRowProps {
  readonly title: string;
  readonly help: string;
  readonly onLabel: string;
  readonly offLabel: string;
  readonly value: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}

export const systemPromptSettingsSection = defineSettingsSection({
  id: "system-prompt",
  title: "System Prompt",
  render: () => <SystemPromptSettingsSection />,
});

function SystemPromptSettingsSection() {
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;

  React.useEffect(() => {
    const controller = new AbortController();
    void loadSystemPromptSettings(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <section className="settings-section global-settings-card" aria-label="System Prompt">
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      {state ? (
        <>
          <SettingToggleRow
            title="System Prompt Injection"
            help="Append keeps the Agent CLI's built-in system prompt and layers Fleet doctrine on top. Replace swaps it entirely for Fleet doctrine. Affects Claude-family CLIs only; Codex always receives doctrine through its profile."
            onLabel="Replace"
            offLabel="Append"
            value={state.replaceSystemPrompt}
            disabled={saving}
            onToggle={() => void setSystemPromptSettingsField("replaceSystemPrompt", !state.replaceSystemPrompt)}
          />
          <SettingToggleRow
            title="Metaphor"
            help="Enabled layers the naval tone overlay — clipped reporting cadence and Fleet vocabulary — onto every session. Off keeps the Admiral persona without the tone."
            onLabel="Enabled"
            offLabel="Off"
            value={state.enableMetaphor}
            disabled={saving}
            onToggle={() => void setSystemPromptSettingsField("enableMetaphor", !state.enableMetaphor)}
          />
        </>
      ) : (
        <p className="global-settings-help">{settings.loading ? "Loading settings." : "Settings unavailable."}</p>
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
