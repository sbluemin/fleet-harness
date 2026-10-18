import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { quotaSettingsSection } from "./mobile-settings.js";
import { disposeLogins } from "./provider-login.js";
import { connectQuotaSummaryApi } from "./summary-store.js";
import { connectQuotaToolbarSetting } from "./toolbar-setting.js";
import { QuotaToolbarSummary } from "./toolbar-summary.js";
import "./quota.css";

const quotaPlugin = definePlugin({
  id: "quota",
  // 사이드바 바닥의 사용 한도 요약 — 아바타 오른쪽에 서며, 바로 위에 상세 팝업을 연다.
  // 폰의 「설정 › 사용량」 — 데스크톱에는 서지 않는다(mobile.only).
  settingsSections: [quotaSettingsSection],
  sidebarFooterEntries: [{ id: "summary", render: (context) => <QuotaToolbarSummary {...context} /> }],
  install: (context) => {
    const offApi = connectQuotaSummaryApi(context.api);
    const offSetting = connectQuotaToolbarSetting(context.settings);
    return () => {
      offApi();
      offSetting();
      disposeLogins();
    };
  },
});

export const plugins = [quotaPlugin] as const;
