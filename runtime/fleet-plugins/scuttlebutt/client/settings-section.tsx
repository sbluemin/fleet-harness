import { React, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";
import {
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  defineSettingsSection,
} from "@fleet-console/sdk/settings/browser";

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
  const [saving, setSaving] = React.useState(false);

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
    </SettingsCard>
  );
}
