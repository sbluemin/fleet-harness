import type { QuotaClientDeps } from "./deps.js";
import type { ClientFeatureDescriptor } from "../../workspace/shared/feature-surfaces.js";

import { quotaSettingsSection } from "./mobile-settings.js";
import { disposeLogins } from "./provider-login.js";
import { connectQuotaSummaryApi } from "./summary-store.js";
import { connectQuotaToolbarSetting } from "./toolbar-setting.js";
import { QuotaToolbarSummary } from "./toolbar-summary.js";
import "./quota.css";

export const quotaClient: ClientFeatureDescriptor = {
  id: "quota",
  // 사령관·목표 그룹 대화의 컴포저 오른쪽 위 요약 — 위로 상세 팝업을 연다.
  // 폰의 「설정 › 사용량」 — 데스크톱에는 서지 않는다(mobile.only).
  settingsSections: [quotaSettingsSection],
  composerTopEntries: [{ id: "summary", render: (context) => <QuotaToolbarSummary {...context} /> }],

};

export function installQuotaClient(context: QuotaClientDeps): () => void {
    const offApi = connectQuotaSummaryApi(context.api);
    const offSetting = connectQuotaToolbarSetting(context.settings);
    return () => {
      offApi();
      offSetting();
      disposeLogins();
    };

}
