import { useEffect, useState } from "react";
import { COMPUTER_USE_PERMISSION_REQUEST_PATH, type ComputerUseSettingsStatus } from "../../computer-use/shared/status.js";
import { SettingsRow, SettingsToggle } from "./preferences-context.js";
import { MobileIcon } from "../../../core/client/src/chrome/mobile/mobile-icons.js";
import { SettingsHelp } from "../../../core/client/src/chrome/components/settings-help.js";
import { renderMessage, useT } from "../../../core/client/src/i18n/index.js";

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
  const [requesting, setRequesting] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const key = noticeFor(status);
  const locked = typeof status === "string" || !status.supported || !status.helperAvailable;
  const permissionMissing = key === "permissionsBoth" || key === "permissionAccessibility" || key === "permissionScreenRecording";
  // 빠진 권한을 macOS 요청 창으로 묻는다. 최근에 이미 물었다면 서버가 대신 시스템 설정을 연다.
  const requestPermissions = async () => {
    setRequesting(true);
    setRequestFailed(false);
    try {
      const response = await fetch(COMPUTER_USE_PERMISSION_REQUEST_PATH, { method: "POST" });
      setRequestFailed(!response.ok);
    } catch { setRequestFailed(true); }
    finally { setRequesting(false); }
  };
  const title = t("settings.computerUse.title");
  const switchControl = <SettingsToggle checked={key !== "unsupported" && enabled} busy={saving} disabled={locked} ariaLabel={title} onChange={onChange} />;
  const actionClass = mobile ? "settings-mobile-textlink" : "fc-settings-reset";
  const notice = key ? <>
    {permissionMissing && typeof status === "object"
      // 권한은 헬퍼를 띄운 앱의 이름으로 판정된다(설치본 Fleet Console, pnpm dev Fleet Console Dev). 읽지 못하면 Fleet Console로 둔다.
      ? renderMessage(t(`settings.computerUse.${key}`), { app: status.permissionHolder ?? "Fleet Console" })
      : t(`settings.computerUse.${key}`)}
    {/* 화면 기록이 빠졌을 때만: 목록에 없으면 + 추가(요청 창이 뜨지 않는 빌드), 옛 빌드 허용이 켜짐으로 남았으면 껐다 켜기,
        켠 뒤 macOS의 종료 및 다시 열기에서 앱이 다시 열리지 않는 경우, 첫 캡처의 macOS 확인 창(실측 근거는 임무 4 기록). */}
    {typeof status === "object" && status.missingPermissions?.includes("screenRecording") && <>
      {" "}{t("settings.computerUse.permissionScreenRecordingList")} {t("settings.computerUse.permissionScreenRecordingReopen")} {t("settings.computerUse.permissionScreenRecordingConfirm")}
    </>}
    {permissionMissing && <> <button type="button" className={actionClass} disabled={requesting} onClick={(event) => { event.stopPropagation(); void requestPermissions(); }}>{t("settings.computerUse.requestPermissions")}</button>{requestFailed && <> {t("settings.computerUse.requestPermissionsFailed")}</>}</>}
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
