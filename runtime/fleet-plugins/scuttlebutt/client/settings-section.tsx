import { React, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";
import {
  SettingsCard,
  SettingsRow,
  SettingsSelect,
  SettingsToggle,
  defineSettingsSection,
} from "@fleet-console/sdk/settings/browser";

import type { ChatCatalog } from "./catalog.js";
import { getT } from "./i18n.js";
import {
  getScuttlebuttSettings,
  subscribeScuttlebuttSettings,
  writeScuttlebuttSettings,
} from "./settings-store.js";

export const scuttlebuttSettingsSection = defineSettingsSection({
  id: "scuttlebutt",
  title: (locale) => getT(locale)("settings.section.title"),
  render: () => <ScuttlebuttSettingsSection />,
});

function ScuttlebuttSettingsSection() {
  const t = getT(document.documentElement.lang === "ko" ? "ko" : "en");
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
      title={t("settings.section.title")}
    >
      <SettingsRow label={t("settings.section.enable")} hint={t("settings.section.enableHint")}>
        <SettingsToggle checked={settings.enabled} disabled={saving} onChange={(enabled) => void save({ enabled })} />
      </SettingsRow>
      <SettingsRow label={t("settings.row.cli")}>
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
      <SettingsRow label={t("settings.row.model")}>
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
      <SettingsRow label={t("settings.row.reasoning")}>
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
