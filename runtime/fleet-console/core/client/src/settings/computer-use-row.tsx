import { useEffect, useState } from "react";
import { SettingsToggle } from "@fleet-console/sdk/settings/browser";
import { SettingsHelp } from "../components/settings-help.js";
import { useT } from "../i18n/index.js";

type State = "off" | "idle" | "starting" | "ready" | "running" | "stopping";
interface Status {
  readonly supported: boolean;
  readonly installation: "unchecked" | "available" | "missing" | "unsupported";
  readonly warning: string | null;
  readonly state: State;
  readonly activeTool: string | null;
  readonly stage: string | null;
  readonly elapsedMs: number;
  readonly apps: readonly string[];
  readonly error: string | null;
}

export function ComputerUseRow({ enabled, saving, onChange }: { readonly enabled: boolean; readonly saving: boolean; readonly onChange: (enabled: boolean) => void }) {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch("/api/v1/computer-use", { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value = await response.json() as Status;
        if (!controller.signal.aborted) { setStatus(value); setUnavailable(false); }
      } catch { if (!controller.signal.aborted) setUnavailable(true); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), enabled ? 1000 : 5000); }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [enabled, refreshKey]);

  const stop = async () => {
    setWorking(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/computer-use/stop", { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus(await response.json() as Status);
      setUnavailable(false);
      setRefreshKey((key) => key + 1);
    } catch (error) { setError(error instanceof Error ? error.message : "request_failed"); }
    finally { setWorking(false); }
  };
  const code = error ?? (enabled ? status?.error : null);
  const errorKey = code === "computer_use_automation_permission_denied" ? "permission"
    : code === "computer_use_no_action_window" ? "noActionWindow"
      : code?.includes("timeout") ? "timeout"
        : code && /app_not_found|ambiguous_app|element_not_found|secondary_action_unavailable|coordinate_target_unavailable/.test(code) ? "target" : "failed";
  const active = enabled && status && status.state !== "idle" && status.state !== "off";
  const label = unavailable ? t("settings.computerUse.connectionFailed")
    : !status || status.installation === "unchecked" ? t("settings.computerUse.checking")
      : !status.supported ? t("settings.computerUse.unavailable")
        : status.installation === "missing" ? t("settings.computerUse.missingLabel")
          : t(`settings.computerUse.${enabled ? status.state : "off"}`);
  return <>
    <div className="global-settings-row experiments-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">
          {t("settings.computerUse.title")}
          <SettingsHelp title={t("settings.computerUse.title")}>
            <p>{t("settings.computerUse.help")}</p>
            <p>{t("settings.computerUse.notice")}</p>
            {status?.installation === "missing" && <p>{t("settings.computerUse.missing")}</p>}
          </SettingsHelp>
        </p>
        <p className="global-settings-help" role="status">{label}</p>
      </div>
      <div className="experiments-row-controls">
        {unavailable && <button type="button" className="fc-settings-reset" onClick={() => setRefreshKey((key) => key + 1)}>{t("settings.computerUse.retry")}</button>}
        {active && <button type="button" className="fc-settings-reset" disabled={working || status.state === "stopping"} onClick={() => void stop()}>{t("settings.computerUse.stop")}</button>}
        <SettingsToggle checked={enabled} disabled={saving || working || (!enabled && (!status?.supported || unavailable || status.installation !== "available"))} ariaLabel={t("settings.computerUse.title")} onChange={onChange} />
      </div>
    </div>
    {enabled && status?.activeTool && <p className="global-settings-help" role="status">{t("settings.computerUse.progressLabel", { seconds: String(Math.floor(status.elapsedMs / 1000)) })}</p>}
    {status?.warning && <p className="global-settings-help" role="status">{t("settings.computerUse.cleanupWarning")}</p>}
    {code && <p role="alert" className="global-settings-help">
      {t(`settings.computerUse.${errorKey}`)}
      <SettingsHelp title={t("settings.computerUse.details")}><code>{code}</code>{status?.activeTool && <p>{status.activeTool} · {status.stage}</p>}</SettingsHelp>
    </p>}
  </>;
}
