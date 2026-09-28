import { useT } from "../../../core/client/src/i18n/index.js";
import { useProxyDataSurface } from "./proxy-data-surface.js";

/**
 * 읽기 전용 안내. 이 표면에는 만들고 바꾸는 입구가 서지 않으므로(proxy-data-surface.ts), 무엇이 안 되는지와
 * 왜인지를 한 줄로 먼저 말한다 — 버튼이 없는 이유가 화면에 있어야 한다.
 */
export function ProxyDataBanner() {
  const t = useT();
  const proxy = useProxyDataSurface();
  if (proxy === null) return null;
  return (
    <div className="console-proxy-banner" role="status" aria-live="polite">
      <span>{t("chrome.proxy.readOnly", { name: proxy.hostLabel || t("chrome.proxy.unnamed") })}</span>
    </div>
  );
}
