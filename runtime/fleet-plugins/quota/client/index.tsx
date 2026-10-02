import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { quotaEntry, quotaPane } from "./rail-panel.js";
import { quotaSettingsSection } from "./settings-section.js";
import { connectQuotaSummaryApi } from "./summary-store.js";
import { connectQuotaToolbarSetting } from "./toolbar-setting.js";
import { connectQuotaToolbarRail, QuotaToolbarSummary } from "./toolbar-summary.js";

const quotaPlugin = definePlugin({
  id: "quota",
  railEntries: [quotaEntry],
  panes: [quotaPane],
  // 도구모음 Bridge의 사용 한도 요약. 꺼져 있으면(기본) 아무것도 그리지 않는다 — 부관 앞에 선다.
  commandBandEntries: [{ id: "summary", render: () => <QuotaToolbarSummary /> }],
  settingsSections: [quotaSettingsSection],
  install: (context) => {
    const offApi = connectQuotaSummaryApi(context.api);
    const offRail = connectQuotaToolbarRail(context.rail);
    const offSetting = connectQuotaToolbarSetting(context.settings);
    return () => {
      offApi();
      offRail();
      offSetting();
    };
  },
});

export const plugins = [quotaPlugin] as const;
