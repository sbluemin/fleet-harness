import { useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";
import { SettingsCard, SettingsRow, SettingsToggle, defineSettingsSection } from "@fleet-console/sdk/settings/browser";

import { getT } from "./i18n/index.js";
import { getQuotaToolbarSetting, subscribeQuotaToolbarSetting, writeQuotaToolbarSummary } from "./toolbar-setting.js";

/** 사용 한도 — 도구모음 요약의 옵트인. 패널 바닥의 토글과 같은 한 값을 바꾼다. */
export const quotaSettingsSection = defineSettingsSection({
  id: "quota",
  title: (locale) => getT(locale)("quota.panel.title"),
  keywords: [
    (locale) => [getT(locale)("quota.toolbar.toggle"), getT(locale)("quota.toolbar.hint")].join(" "),
    "quota usage limits toolbar bridge summary",
    "사용 한도 도구모음 함교 요약",
  ],
  render: () => <QuotaSettingsSection />,
});

function QuotaSettingsSection() {
  const t = getT(document.documentElement.lang === "ko" ? "ko" : "en");
  const { toolbarSummary } = useStoreSnapshot(subscribeQuotaToolbarSetting, getQuotaToolbarSetting);
  return (
    <SettingsCard title={t("quota.panel.title")}>
      <SettingsRow label={t("quota.toolbar.toggle")} hint={t("quota.toolbar.hint")}>
        <SettingsToggle
          checked={toolbarSummary}
          ariaLabel={t("quota.toolbar.toggle")}
          onChange={(next) => { writeQuotaToolbarSummary(next).catch(() => undefined); }}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
