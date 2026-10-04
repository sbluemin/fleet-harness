import { useId } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";
import type { SettingsSectionDescriptor } from "@fleet-console/sdk/settings";

import { PROVIDER_ORDER_DEFAULT } from "../provider-order.js";
import { getT } from "./i18n/index.js";
import { QuotaPanel, windowLabel } from "./quota-panel.js";
import { getQuotaApi, getQuotaSummarySnapshot, holdQuotaSummary, subscribeQuotaApi, subscribeQuotaSummary } from "./summary-store.js";
import { summaryLines } from "./toolbar-summary.js";

/**
 * 폰의 「설정 › 사용량」 — 데스크톱에는 이미 도구모음 요약과 팝업이 있어 이 섹션은 폰에서만 선다(`mobile.only`).
 * 상세는 팝업과 같은 패널을 그대로 쓴다(같은 원천·같은 판정). 목록 행의 보조 줄은 가장 짧은 창 하나(예: 「5시간 한도 42% 사용」)다.
 */
function UsageBody() {
  const api = useStoreSnapshot(subscribeQuotaApi, getQuotaApi);
  const labelId = useId();
  const locale: ConsoleLocale = document.documentElement.lang === "ko" ? "ko" : "en";
  if (api === null) return null;
  return <QuotaPanel api={api} locale={locale} labelId={labelId} />;
}

function summary(locale: ConsoleLocale): string | null {
  const data = getQuotaSummarySnapshot().data;
  if (data === null) return null;
  const t = getT(locale);
  for (const id of PROVIDER_ORDER_DEFAULT) {
    const provider = data.providers[id];
    if (provider === undefined || (provider.status !== "ok" && provider.status !== "stale")) continue;
    const line = summaryLines(provider.windows ?? [])[0];
    if (line !== undefined) return `${windowLabel(line, t)} ${t("quota.meter.used", { pct: line.usedPercent })}`;
  }
  return null;
}

/** 목록이 서 있는 동안 요약 폴링을 쥔다 — 값이 읽혀야 보조 줄이 선다. */
function subscribe(listener: () => void): () => void {
  const release = holdQuotaSummary();
  const off = subscribeQuotaSummary(listener);
  return () => { off(); release(); };
}

export const quotaSettingsSection: SettingsSectionDescriptor = {
  id: "usage",
  title: (locale) => getT(locale)("quota.panel.title"),
  group: "work",
  render: () => <UsageBody />,
  mobile: { only: true, group: "use", order: -1, summary, subscribe },
};
