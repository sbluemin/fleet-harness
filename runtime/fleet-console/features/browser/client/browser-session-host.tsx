import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";
import { createPortal } from "react-dom";

import { Toast } from "../../../core/client/src/chrome/components/toast.js";
import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { subscribeConsoleChannel } from "../../../core/client/src/integration/operations-sse.js";
import { publishBrowserEngine, type BrowserUnavailableReason } from "./browser-panel-store.js";
import { useBrowserShortcutsSync } from "./browser-shortcuts-sync.js";
import { dismissSharedFallback, useSharedFallbackNotice } from "./browser-shared-fallback.js";
import { getT } from "./i18n.js";

/**
 * Session 브라우저가 쓰는 Console 전역 호스트.
 * 네이티브 뷰가 포커스를 가져도 단축키가 따라가게 하고, 패널이 닫혀 있어도 엔진 가용성을 지구본에 알리며,
 * shared 중 내 브라우저로 연 링크를 한 번 안내한다. 전역 브라우저 화면은 없다.
 */
export function BrowserSessionHost({ language }: { readonly language: ConsoleLocale | undefined }) {
  useBrowserShortcutsSync(isDesktopShell());
  useBrowserAvailabilityWatch();
  const t = getT(language);
  const fallbackNotice = useSharedFallbackNotice();
  const toastHost = typeof document === "undefined" ? null : document.querySelector(".app-toast-host");
  return fallbackNotice && toastHost ? createPortal(
    <Toast open tone="info" title={t("terminal.browser.sharedFallback")} onDismiss={() => dismissSharedFallback()} />,
    toastHost,
  ) : null;
}

function publishAvailability(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const body = payload as { available?: unknown; reason?: unknown };
  if (typeof body.available !== "boolean") return;
  const reason: BrowserUnavailableReason = body.reason === "shared" ? "shared" : "desktop_required";
  publishBrowserEngine(body.available ? { available: true } : { available: false, reason });
}

function useBrowserAvailabilityWatch(): void {
  React.useEffect(() => {
    if (!isDesktopShell()) return;
    const unsubscribeState = subscribeConsoleChannel("browser:state", publishAvailability);
    const unsubscribeAvailability = subscribeConsoleChannel("browser:availability", publishAvailability);
    return () => { unsubscribeState(); unsubscribeAvailability(); };
  }, []);
}
