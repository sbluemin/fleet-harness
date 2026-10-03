import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { connectQuotaSummaryApi } from "./summary-store.js";
import { connectQuotaToolbarSetting } from "./toolbar-setting.js";
import { QuotaToolbarSummary } from "./toolbar-summary.js";
import "./quota.css";

const quotaPlugin = definePlugin({
  id: "quota",
  // 도구모음 Bridge의 사용 한도 요약 — 누르면 바로 아래에 상세 팝업이 열린다. 부관 앞에 선다.
  commandBandEntries: [{ id: "summary", render: () => <QuotaToolbarSummary /> }],
  install: (context) => {
    const offApi = connectQuotaSummaryApi(context.api);
    const offSetting = connectQuotaToolbarSetting(context.settings);
    return () => {
      offApi();
      offSetting();
    };
  },
});

export const plugins = [quotaPlugin] as const;
