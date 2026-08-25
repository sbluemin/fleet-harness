import { React, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";
import {
  ExperimentalBadge,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  defineSettingsSection,
} from "@fleet-console/sdk/settings/browser";

import { getT } from "./scuttlebutt-catalog.js";
import {
  getScuttlebuttSettings,
  subscribeScuttlebuttSettings,
  writeScuttlebuttSettings,
} from "./settings-store.js";

export const scuttlebuttSettingsSection = defineSettingsSection({
  id: "scuttlebutt",
  title: (locale) => getT(locale)("settings.section.title"),
  group: "work",
  keywords: [
    (locale) => [getT(locale)("settings.section.roster"), getT(locale)("settings.section.departure")].join(" "),
    "aide quaker tori bori dori mascot bell announce chat",
    "부관 퀘이커 마스코트 알림 대화",
  ],
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
      title={
        <>
          {t("settings.section.title")}
          <ExperimentalBadge>{t("settings.section.experimental")}</ExperimentalBadge>
        </>
      }
    >
      <SettingsRow label={t("settings.section.roster")} hint={t("settings.section.rosterHint")}>
        <div className="scuttlebutt-settings-roster">
          {(["tori", "bori", "dori"] as const).map((admiral) => (
            <SettingsToggle
              key={admiral}
              label={t(`bird.${admiral}`)}
              checked={settings[admiral]}
              disabled={saving}
              onChange={(enabled) => void save({ [admiral]: enabled })}
            />
          ))}
        </div>
      </SettingsRow>
      <SettingsRow label={t("settings.section.departure")} hint={t("settings.section.departureHint")}>
        <SettingsToggle
          label={t("settings.section.departureToggle")}
          checked={settings.departureBell}
          disabled={saving}
          onChange={(enabled) => void save({ departureBell: enabled })}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
