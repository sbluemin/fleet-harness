import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale } from "@fleet-console/i18n";
import { useStoreSnapshot } from "@fleet-console/ui/store";

import { getT } from "./i18n/index.js";
import { QuotaPanel } from "./quota-panel.js";
import { getQuotaApi, subscribeQuotaApi } from "./summary-store.js";
import { QUOTA_PANEL_OPEN_EVENT } from "./toolbar-summary.js";

/**
 * 대화 컴포저(사용량 단추)가 없는 화면에서 로그인 패널을 연다.
 * 단추가 있으면 `requestQuotaPanelOpen`이 그 팝오버를 열고 이 이벤트는 보내지 않는다.
 */
export function QuotaSignInHost(): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const api = useStoreSnapshot(subscribeQuotaApi, getQuotaApi);
  const labelId = useId();
  const locale: ConsoleLocale = document.documentElement.lang === "ko" ? "ko" : "en";
  const t = getT(locale, false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(QUOTA_PANEL_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(QUOTA_PANEL_OPEN_EVENT, onOpen);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="quota-signin-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="quota-signin-dialog" role="dialog" aria-modal="true" aria-labelledby={labelId}>
        <div className="quota-signin-bar">
          <button type="button" className="quota-signin-close" aria-label={t("quota.signin.close")} onClick={() => setOpen(false)}>✕</button>
        </div>
        {api
          ? <QuotaPanel api={api} locale={locale} labelId={labelId} />
          : <p className="quota-signin-note" id={labelId}>{t("quota.signin.unavailable")}</p>}
      </div>
    </div>,
    document.body,
  );
}
