import { useState } from "react";

import { revokeRemoteAccessSession } from "../global-settings-api.js";
import { useConsoleState } from "../hooks/use-store.js";
import { formatRelativeTime, useConsoleLocale, useT } from "../i18n/index.js";

export function ControlBar() {
  const state = useConsoleState();
  const locale = useConsoleLocale();
  const t = useT();
  const [reclaiming, setReclaiming] = useState(false);
  const [reclaimError, setReclaimError] = useState(false);
  const holder = state.controlHolder;

  if (holder === null || !state.controlCurtainDismissed) return null;
  const device = holder.device ?? t("settings.remote.table.unnamedDevice");
  const joined = formatRelativeTime(holder.openedAt, locale);
  const takeBackControl = () => {
    if (reclaiming) return;
    setReclaiming(true);
    setReclaimError(false);
    void revokeRemoteAccessSession(holder.handle)
      .catch(() => setReclaimError(true))
      .finally(() => setReclaiming(false));
  };

  return (
    <div className="control-bar" role="status" aria-live="polite">
      <span className="control-bar-signal" aria-hidden="true" />
      <span className="control-bar-copy">
        <strong>{t("chrome.control.bar.title", { name: device })}</strong>
        <span>{t("chrome.control.bar.joined", { time: joined })}</span>
        {reclaimError ? <span className="control-bar-error" role="alert">{t("chrome.control.reclaimError")}</span> : null}
      </span>
      <button type="button" disabled={reclaiming} onClick={takeBackControl}>
        {reclaiming ? t("chrome.control.reclaiming") : t("chrome.control.takeBack")}
      </button>
    </div>
  );
}
