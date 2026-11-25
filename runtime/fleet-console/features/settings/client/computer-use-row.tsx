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
  // Windows에는 TCC가 없어 권한 안내 행이 서지 않는다.
  if (status.os === "win32") return status.selfCheckFailed ? "selfCheckFailed" : null;
  const missing = status.missingPermissions ?? [];
  if (missing.includes("accessibility")) return missing.includes("screenRecording") ? "permissionsBoth" : "permissionAccessibility";
  if (missing.includes("screenRecording")) return "permissionScreenRecording";
  return status.selfCheckFailed ? "selfCheckFailed" : null;
}

export function ComputerUseRow({ enabled, saving, onChange, remotePreview, onRemotePreviewChange, mobile = false }: {
  readonly enabled: boolean;
  readonly saving: boolean;
  readonly onChange: (enabled: boolean) => void;
  /** 원격 기기와 창 미리보기 공유(결정 8cd1a62d). 컴퓨터 사용이 켜져 있을 때만 줄이 선다. */
  readonly remotePreview: boolean;
  readonly onRemotePreviewChange: (enabled: boolean) => void;
  readonly mobile?: boolean;
}) {
  const t = useT();
  const { status, retry } = useComputerUseStatus(enabled);
  const [requesting, setRequesting] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const key = noticeFor(status);
  const windows = typeof status === "object" && status.os === "win32";
  const helpKey = windows ? "settings.computerUse.helpWindows" : "settings.computerUse.help";
  const remotePreviewHelpKey = windows ? "settings.computerUse.remotePreviewHelpWindows" : "settings.computerUse.remotePreviewHelp";
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
      : t(windows && key === "selfCheckFailed" ? "settings.computerUse.selfCheckFailedWindows" : `settings.computerUse.${key}`)}
    {/* 화면 기록이 빠졌을 때만: 목록에 없으면 + 추가(요청 창이 뜨지 않는 빌드), 옛 빌드 허용이 켜짐으로 남았으면 껐다 켜기,
        켠 뒤 macOS의 종료 및 다시 열기에서 앱이 다시 열리지 않는 경우, 첫 캡처의 macOS 확인 창(실측 근거는 임무 4 기록). */}
    {typeof status === "object" && status.missingPermissions?.includes("screenRecording") && <>
      {" "}{t("settings.computerUse.permissionScreenRecordingList")} {t("settings.computerUse.permissionScreenRecordingReopen")} {t("settings.computerUse.permissionScreenRecordingConfirm")}
    </>}
    {permissionMissing && <> <button type="button" className={actionClass} disabled={requesting} onClick={(event) => { event.stopPropagation(); void requestPermissions(); }}>{t("settings.computerUse.requestPermissions")}</button>{requestFailed && <> {t("settings.computerUse.requestPermissionsFailed")}</>}</>}
    {status === "failed" && <> <button type="button" className={actionClass} onClick={(event) => { event.stopPropagation(); retry(); }}>{t("settings.computerUse.retry")}</button></>}
  </> : null;
  // 원격 화면에서는 바꿀 수 없다 — 사유는 위 줄의 기존 「원격 클라이언트에서는 관리할 수 없어요.」가 말한다.
  const remotePreviewTitle = t("settings.computerUse.remotePreview");
  const remotePreviewLocked = status === "remote";
  const remotePreviewControl = <SettingsToggle checked={remotePreview} busy={saving} disabled={saving || remotePreviewLocked} ariaLabel={remotePreviewTitle} onChange={onRemotePreviewChange} />;
  const showRemotePreview = enabled && key !== "unsupported";
  if (mobile) return <>
    <SettingsRow label={title} hint={t(helpKey)} helpTip={notice && <span className="fc-settings-row__hint" role="status">{notice}</span>} icon={<MobileIcon name="layout" />} disabled={locked}>{switchControl}</SettingsRow>
    {showRemotePreview ? <SettingsRow label={remotePreviewTitle} hint={t(remotePreviewHelpKey)} icon={<MobileIcon name="layout" />} disabled={remotePreviewLocked}>{remotePreviewControl}</SettingsRow> : null}
  </>;
  return <>
    <div className="global-settings-row experiments-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">{title}<SettingsHelp title={title}><p>{t(helpKey)}</p><p>{t("settings.computerUse.notice")}</p></SettingsHelp></p>
      </div>
      <div className="experiments-row-controls computer-use-controls">{switchControl}</div>
    </div>
    {notice && <p className="global-settings-help" role="status">{notice}</p>}
    {showRemotePreview ? <div className="global-settings-row experiments-row computer-use-remote-preview-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">{remotePreviewTitle}<SettingsHelp title={remotePreviewTitle}><p>{t(remotePreviewHelpKey)}</p></SettingsHelp></p>
      </div>
      <div className="experiments-row-controls">{remotePreviewControl}</div>
    </div> : null}
  </>;
}
