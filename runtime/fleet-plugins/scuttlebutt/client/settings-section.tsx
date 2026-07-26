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
      <p className="scuttlebutt-settings-experimental">
        <span className="scuttlebutt-settings-experimental-badge">{t("settings.section.experimental")}</span>
        {t("settings.section.experimentalHint")}
      </p>
      <SettingsRow label={t("settings.section.enable")} hint={t("settings.section.enableHint")}>
        <SettingsToggle checked={settings.enabled} disabled={saving} onChange={(enabled) => void save({ enabled })} />
      </SettingsRow>
      <SettingsRow label={t("settings.section.roster")} hint={t("settings.section.rosterHint")}>
        <div className="scuttlebutt-settings-roster">
          {(["tori", "bori", "dori"] as const).map((admiral) => (
            <SettingsToggle
              key={admiral}
              label={t(`bird.${admiral}`)}
              checked={settings[admiral]}
              disabled={saving || !settings.enabled}
              onChange={(enabled) => void save({ [admiral]: enabled })}
            />
          ))}
        </div>
      </SettingsRow>
    </SettingsCard>
  );
}
