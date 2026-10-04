import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import { useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";
import type { SettingsSectionDescriptor } from "@fleet-console/sdk/settings";

import { PROVIDER_ORDER_DEFAULT } from "../provider-order.js";
import { getT } from "./i18n/index.js";
import type { QuotaWindow } from "@fleet-console/ai-gateway";
import { EXPIRED_KEY, NO_SUBSCRIPTION_KEY, PROVIDER_NAME, SIGNED_OUT_KEY, UNREPORTED_PROVIDER, displayPlanName, isConnectable, meterSeverity, useQuotaData, windowLabel } from "./quota-panel.js";
import type { ProviderId } from "../provider-order.js";
import "./mobile.css";
import { getQuotaApi, getQuotaSummarySnapshot, holdQuotaSummary, subscribeQuotaApi, subscribeQuotaSummary } from "./summary-store.js";
import { summaryLines } from "./toolbar-summary.js";

/**
 * 폰의 「설정 › 사용량」 — 데스크톱에는 이미 도구모음 요약과 팝업이 있어 이 섹션은 폰에서만 선다(`mobile.only`).
 * 같은 원천·같은 판정(useQuotaData·meterSeverity)을 쓰고 그림만 시안 문법이다: 공급자마다 머리 + 묶음 카드(한도 창마다 두 줄 행 + 막대),
 * 연결되지 않은 공급자는 그 묶음에 「연결」 행. 목록 행의 보조 줄은 가장 짧은 창 하나(예: 「5시간 한도 42% 사용」)다.
 */
function UsageBody() {
  const api = useStoreSnapshot(subscribeQuotaApi, getQuotaApi);
  if (api === null) return null;
  return <UsageList api={api} />;
}

function UsageList({ api }: { readonly api: ClientApiCapability }) {
  const locale: ConsoleLocale = document.documentElement.lang === "ko" ? "ko" : "en";
  const t = getT(locale);
  const { data, now, requestError, connect } = useQuotaData(api);
  if (requestError && data === null) return <p className="quota-m-note">{t("quota.error.summary")}</p>;
  if (data === null) return <p className="quota-m-note" role="status">{t("quota.loading.title")}</p>;
  return (
    <div className="quota-m">
      {PROVIDER_ORDER_DEFAULT.map((id) => {
        const provider = data.providers[id] ?? UNREPORTED_PROVIDER;
        const name = PROVIDER_NAME[id];
        const readable = provider.status === "ok" || provider.status === "stale";
        const windows = readable ? provider.windows ?? [] : [];
        return (
          <section className="quota-m-provider" key={id} data-provider={id}>
            <h3 className="quota-m-head">{name}{provider.plan ? <small>{displayPlanName(id, provider.plan)}</small> : null}</h3>
            <div className="quota-m-group">
              {isConnectable(id) && provider.status === "not_connected" ? (
                <button type="button" className="quota-m-row quota-m-action" onClick={() => connect(id, true)}>
                  <span className="quota-m-copy">{t("mobile.usage.connect")}<small>{t("quota.connect.body")}</small></span>
                </button>
              ) : null}
              {windows.map((window, index) => {
                const severity = meterSeverity(window);
                const label = mobileWindowLabel(window, t);
                const percent = Math.max(0, Math.min(100, window.usedPercent));
                const reset = window.resetsAt === undefined ? null : t("mobile.usage.reset", { t: countdownText(window.resetsAt - now, locale) });
                return (
                  <div className="quota-m-row" key={`${window.id}-${window.label ?? index}`}>
                    <span className="quota-m-copy">
                      {label}
                      <small>{[t("quota.meter.used", { pct: window.usedPercent }), reset].filter(Boolean).join(" · ")}</small>
                      <span className="quota-m-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent}>
                        <i className={`is-${severity}`} style={{ width: `${percent}%` }} />
                      </span>
                    </span>
                  </div>
                );
              })}
              {!readable && !(isConnectable(id) && provider.status === "not_connected") ? (
                <div className="quota-m-row">
                  <span className="quota-m-copy">{statusLine(id, provider.status, t)}</span>
                </div>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** 시안의 창 이름 — 이름이 없는 세션·주간 창은 「5시간 한도」·「주간 한도」로 부른다(공급자가 이름을 준 창은 그대로). */
function mobileWindowLabel(window: QuotaWindow, t: ReturnType<typeof getT>): string {
  if (window.label === undefined && window.id === "session") return t("mobile.usage.session");
  if (window.label === undefined && window.id === "weekly") return t("mobile.usage.weekly");
  return windowLabel(window, t);
}

/** 「2시간 13분」·「2일 23시간」 — 가장 큰 두 단위. */
function countdownText(ms: number, locale: ConsoleLocale): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (locale === "ko") return days > 0 ? `${days}일 ${hours}시간` : hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`;
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** 읽을 수 있는 한도가 없는 공급자의 한 줄 — 팝업과 같은 문구 키를 쓴다. */
function statusLine(id: ProviderId, status: string, t: ReturnType<typeof getT>): string {
  if (status === "signed_out") return t(SIGNED_OUT_KEY[id]);
  if (status === "no_subscription") return t(NO_SUBSCRIPTION_KEY[id]);
  if (status === "expired") return t(EXPIRED_KEY[id]);
  return t("quota.error", { provider: PROVIDER_NAME[id] });
}

function summary(locale: ConsoleLocale): string | null {
  const data = getQuotaSummarySnapshot().data;
  if (data === null) return null;
  const t = getT(locale);
  for (const id of PROVIDER_ORDER_DEFAULT) {
    const provider = data.providers[id];
    if (provider === undefined || (provider.status !== "ok" && provider.status !== "stale")) continue;
    const line = summaryLines(provider.windows ?? [])[0];
    if (line !== undefined) return `${mobileWindowLabel(line, t)} ${t("quota.meter.used", { pct: line.usedPercent })}`;
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
