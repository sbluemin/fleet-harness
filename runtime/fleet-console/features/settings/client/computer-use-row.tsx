import { useEffect, useState } from "react";
import type { ComputerUseSettingsStatus } from "../../computer-use/shared/status.js";
import { SettingsRow, SettingsToggle } from "./preferences-context.js";
import { MobileIcon } from "../../../core/client/src/chrome/mobile/mobile-icons.js";
import { SettingsHelp } from "../../../core/client/src/chrome/components/settings-help.js";
import { useT } from "../../../core/client/src/i18n/index.js";

type ReadStatus = ComputerUseSettingsStatus | "pending" | "remote" | "failed";

function useComputerUseStatus(enabled: boolean) {
  const [status, setStatus] = useState<ReadStatus>("pending");
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch("/api/v1/computer-use", { signal: controller.signal });
        const next: ReadStatus = response.ok ? await response.json() as ComputerUseSettingsStatus : response.status === 404 ? "remote" : "failed";
        if (!controller.signal.aborted) setStatus(next);
      } catch { if (!controller.signal.aborted) setStatus("failed"); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), enabled ? 1000 : 5000); }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [enabled, refreshKey]);
  return { status, retry: () => setRefreshKey((key) => key + 1) };
}

function noticeFor(status: ReadStatus) {
  if (status === "pending") return "checking";
  if (status === "remote") return "remote";
  if (status === "failed") return "connectionFailed";
  if (!status.supported) return "unsupported";
  if (!status.helperAvailable) return "missing";
  const missing = status.missingPermissions ?? [];
  if (missing.includes("accessibility")) return missing.includes("screenRecording") ? "permissionsBoth" : "permissionAccessibility";
  if (missing.includes("screenRecording")) return "permissionScreenRecording";
  return status.selfCheckFailed ? "selfCheckFailed" : null;
}

export function ComputerUseRow({ enabled, saving, onChange, mobile = false }: { readonly enabled: boolean; readonly saving: boolean; readonly onChange: (enabled: boolean) => void; readonly mobile?: boolean }) {
  const t = useT();
  const { status, retry } = useComputerUseStatus(enabled);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const key = noticeFor(status);
  const locked = typeof status === "string" || !status.supported || !status.helperAvailable;
  const permissionMissing = key === "permissionsBoth" || key === "permissionAccessibility" || key === "permissionScreenRecording";
  const openPrivacy = async () => {
    setOpening(true);
    setOpenFailed(false);
    try {
      const response = await fetch("/api/v1/computer-use/privacy-settings", { method: "POST" });
      setOpenFailed(!response.ok);
    } catch { setOpenFailed(true); }
    finally { setOpening(false); }
  };
  const title = t("settings.computerUse.title");
  const switchControl = <SettingsToggle checked={key !== "unsupported" && enabled} busy={saving} disabled={locked} ariaLabel={title} onChange={onChange} />;
  const actionClass = mobile ? "settings-mobile-textlink" : "fc-settings-reset";
  const notice = key ? <>
    {t(`settings.computerUse.${key}`)}
    {permissionMissing && <> <button type="button" className={actionClass} disabled={opening} onClick={(event) => { event.stopPropagation(); void openPrivacy(); }}>{t("settings.computerUse.openPrivacy")}</button>{openFailed && <> {t("settings.computerUse.openPrivacyFailed")}</>}</>}
    {status === "failed" && <> <button type="button" className={actionClass} onClick={(event) => { event.stopPropagation(); retry(); }}>{t("settings.computerUse.retry")}</button></>}
  </> : null;
  if (mobile) return <SettingsRow label={title} hint={t("settings.computerUse.help")} helpTip={notice && <span className="fc-settings-row__hint" role="status">{notice}</span>} icon={<MobileIcon name="layout" />} disabled={locked}>{switchControl}</SettingsRow>;
  return <>
    <div className="global-settings-row experiments-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">{title}<SettingsHelp title={title}><p>{t("settings.computerUse.help")}</p><p>{t("settings.computerUse.notice")}</p></SettingsHelp></p>
      </div>
      <div className="experiments-row-controls computer-use-controls">{switchControl}</div>
    </div>
    {notice && <p className="global-settings-help" role="status">{notice}</p>}
  </>;
}
