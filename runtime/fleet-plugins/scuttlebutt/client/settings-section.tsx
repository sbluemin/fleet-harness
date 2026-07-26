import { React, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";
import {
  SettingsCard,
  SettingsRow,
  SettingsSelect,
  SettingsToggle,
  defineSettingsSection,
} from "@fleet-console/sdk/settings/browser";

import type { ChatCatalog } from "./catalog.js";
import {
  getScuttlebuttSettings,
  subscribeScuttlebuttSettings,
  writeScuttlebuttSettings,
} from "./settings-store.js";

export const scuttlebuttSettingsSection = defineSettingsSection({
  id: "scuttlebutt",
  title: "Scuttlebutt",
  render: () => <ScuttlebuttSettingsSection />,
});

function ScuttlebuttSettingsSection() {
  const settings = useStoreSnapshot(subscribeScuttlebuttSettings, getScuttlebuttSettings);
  const [catalog, setCatalog] = React.useState<ChatCatalog | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    void fetch("/plugins/scuttlebutt/chat/catalog", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<ChatCatalog> : Promise.reject(new Error("Catalog unavailable")))
      .then(setCatalog)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const availableClis = catalog?.clis.filter((cli) => cli.available) ?? [];
  const activeCli = availableClis.find((cli) => cli.cliId === settings.cliId) ?? availableClis[0];
  const model = activeCli?.models.find((candidate) => candidate.id === settings.model) ?? activeCli?.models[0];
  const save = async (patch: Parameters<typeof writeScuttlebuttSettings>[0]) => {
    setSaving(true);
    try {
      await writeScuttlebuttSettings(patch);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="Admiral Sam"
      description="Keep a read-only web research companion available across the Console."
    >
      <SettingsRow label="Enable Admiral Sam" hint="When off, the floating mascot is removed.">
        <SettingsToggle checked={settings.enabled} disabled={saving} onChange={(enabled) => void save({ enabled })} />
      </SettingsRow>
      <SettingsRow label="Default CLI">
        <SettingsSelect
          value={activeCli?.cliId ?? settings.cliId}
          disabled={saving || availableClis.length === 0}
          options={availableClis.map((cli) => ({ value: cli.cliId, label: cli.label }))}
          onChange={(cliId) => {
            const cli = availableClis.find((candidate) => candidate.cliId === cliId);
            if (cli) void save({ cliId, model: cli.defaultModel, effort: cli.models.find((item) => item.id === cli.defaultModel)?.defaultEffort ?? null });
          }}
        />
      </SettingsRow>
      <SettingsRow label="Default model">
        <SettingsSelect
          value={model?.id ?? settings.model}
          disabled={saving || !activeCli}
          options={(activeCli?.models ?? []).map((item) => ({ value: item.id, label: item.label }))}
          onChange={(modelId) => {
            const next = activeCli?.models.find((candidate) => candidate.id === modelId);
            if (next) void save({ model: modelId, effort: next.defaultEffort ?? null });
          }}
        />
      </SettingsRow>
      <SettingsRow label="Default effort">
        <SettingsSelect
          value={settings.effort ?? ""}
          disabled={saving || !model || model.effortLevels.length === 0}
          options={model?.effortLevels.map((effort) => ({ value: effort, label: effort })) ?? []}
          onChange={(effort) => void save({ effort: effort || null })}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
