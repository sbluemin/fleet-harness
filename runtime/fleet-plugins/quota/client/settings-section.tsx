import { useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";
import { SettingsCard, SettingsCheckbox, defineSettingsSection } from "@fleet-console/sdk/settings/browser";

import { PROVIDER_ORDER_DEFAULT } from "../provider-order.js";
import { getT } from "./i18n/index.js";
import { PROVIDER_NAME } from "./rail-panel.js";
import { getQuotaToolbarSetting, subscribeQuotaToolbarSetting, toggleQuotaToolbarProvider } from "./toolbar-setting.js";

/** 사용 한도 — 도구모음 요약에 세울 공급자를 고른다. 패널 바닥의 글리프 토글과 같은 한 값을 바꾼다. */
export const quotaSettingsSection = defineSettingsSection({
  id: "quota",
  title: (locale) => getT(locale)("quota.panel.title"),
  keywords: [
    (locale) => [getT(locale)("quota.toolbar.toggle"), getT(locale)("quota.toolbar.hint")].join(" "),
    "quota usage limits toolbar bridge summary provider",
    "사용 한도 도구모음 함교 요약 공급자",
  ],
  render: () => <QuotaSettingsSection />,
});

function QuotaSettingsSection() {
  const t = getT(document.documentElement.lang === "ko" ? "ko" : "en");
  const { toolbarProviders } = useStoreSnapshot(subscribeQuotaToolbarSetting, getQuotaToolbarSetting);
  return (
    <SettingsCard title={t("quota.toolbar.toggle")} description={t("quota.toolbar.hint")}>
      {PROVIDER_ORDER_DEFAULT.map((id) => (
        <SettingsCheckbox
          key={id}
          checked={toolbarProviders.includes(id)}
          label={PROVIDER_NAME[id]}
          onChange={(next) => { toggleQuotaToolbarProvider(id, next).catch(() => undefined); }}
        />
      ))}
    </SettingsCard>
  );
}
