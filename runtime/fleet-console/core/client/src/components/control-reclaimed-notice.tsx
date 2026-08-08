import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n/index.js";

const CONTROL_RECLAIMED_EVENT = "fleet-console:control-reclaimed";

export function ControlReclaimedNotice() {
  const t = useT();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const showNotice = () => setVisible(true);
    window.addEventListener(CONTROL_RECLAIMED_EVENT, showNotice);
    return () => window.removeEventListener(CONTROL_RECLAIMED_EVENT, showNotice);
  }, []);

  if (!visible) return null;
  return createPortal(
    <div className="control-reclaimed-notice" role="alert" aria-live="assertive">
      <section className="control-reclaimed-card">
        <span className="control-reclaimed-signal" aria-hidden="true" />
        <span className="control-reclaimed-eyebrow">{t("chrome.control.reclaimed.eyebrow")}</span>
        <h2>{t("chrome.control.reclaimed.title")}</h2>
        <p>{t("chrome.control.reclaimed.body")}</p>
      </section>
    </div>,
    document.body,
  );
}
