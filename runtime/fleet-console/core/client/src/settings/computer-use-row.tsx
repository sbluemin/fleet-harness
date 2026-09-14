import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useSelect } from "@fleet-console/sdk/react/browser";
import type { ComputerUseBackendId } from "@fleet-console/sdk/settings";
import { isComputerUseBackendId } from "@fleet-console/sdk/settings/browser";
import { SettingsToggle, widenModelPickerPopup } from "@fleet-console/sdk/settings/browser";
import { SettingsHelp } from "../components/settings-help.js";
import { ComputerUseGlyph } from "./computer-use-glyph.js";
import { useT } from "../i18n/index.js";

type State = "off" | "idle" | "starting" | "ready" | "running" | "stopping";
interface Status {
  readonly backend?: ComputerUseBackendId;
  readonly supported: boolean;
  readonly installation: "unchecked" | "available" | "missing" | "unsupported";
  readonly warning: string | null;
  readonly state: State;
  readonly activeTool: string | null;
  readonly stage: string | null;
  readonly elapsedMs: number;
  readonly apps: readonly string[];
  readonly error: string | null;
  readonly installer?: { phase: string; error: string | null; supported: boolean; version: string };
}

const BACKENDS = [{ value: "sky-computer-use", label: "SkyComputerUse" }, { value: "cua-driver", label: "Cua Driver" }];

export function ComputerUseRow({ enabled, backend, saving, onChange, onBackendChange }: { readonly enabled: boolean; readonly backend: ComputerUseBackendId; readonly saving: boolean; readonly onChange: (enabled: boolean) => void; readonly onBackendChange: (backend: ComputerUseBackendId) => void }) {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [popupWidth, setPopupWidth] = useState(190);
  const select = useSelect({ value: backend, options: BACKENDS, disabled: saving || working, onChange: value => { if (isComputerUseBackendId(value) && value !== backend) { onBackendChange(value); } } });
  useLayoutEffect(() => {
    const trigger = select.triggerRef.current;
    if (!trigger) return;
    const measure = () => {
      const style = getComputedStyle(trigger);
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const labelWidth = Math.max(...BACKENDS.map(option => context.measureText(option.label).width));
      // 팝업 패딩·글리프·체크·간격을 포함하되 모델 메뉴의 메타데이터 여백은 빌리지 않는다.
      setPopupWidth(Math.ceil(labelWidth + 76));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [select.triggerRef]);
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
  }, [enabled, backend, refreshKey]);

  const stop = async () => {
    setWorking(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/computer-use/stop", { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus({ ...await response.json() as Status, backend });
      setUnavailable(false);
      setRefreshKey((key) => key + 1);
    } catch (error) { setError(error instanceof Error ? error.message : "request_failed"); }
    finally { setWorking(false); }
  };
  const installing = working || ["downloading", "verifying", "installing"].includes(status?.installer?.phase ?? "");
  const install = async () => {
    setWorking(true); setError(null);
    try {
      const response = await fetch("/api/v1/computer-use/install", { method: "POST" });
      if (!response.ok) throw new Error("computer_use_install_failed");
      setRefreshKey(key => key + 1);
    } catch { setError("computer_use_install_failed"); }
    finally { setWorking(false); }
  };
  const code = error ?? (backend === "cua-driver" ? status?.installer?.error : null) ?? (enabled ? status?.error : null);
  const errorKey = code === "computer_use_automation_permission_denied" ? "permission"
    : code === "computer_use_runtime_incompatible" ? "incompatible"
      : code === "computer_use_no_action_window" ? "noActionWindow"
      : code?.includes("timeout") ? "timeout"
        : code && /app_not_found|ambiguous_app|element_not_found|secondary_action_unavailable|coordinate_target_unavailable/.test(code) ? "target" : "failed";
  const active = enabled && status && status.state !== "idle" && status.state !== "off";
  return <>
    <div className="global-settings-row experiments-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">
          {t("settings.computerUse.title")}
          <SettingsHelp title={t("settings.computerUse.title")}>
            <p>{t("settings.computerUse.help")}</p>
            <p>{t("settings.computerUse.notice")}</p>
            {status?.warning && <p>{t("settings.computerUse.cleanupWarning")}</p>}
            {status?.installation === "missing" && <p>{t(backend === "cua-driver" ? "settings.computerUse.missing" : "settings.computerUse.skyMissing")}</p>}
          </SettingsHelp>
        </p>
      </div>
      <div className="experiments-row-controls computer-use-controls">
        <div className="fc-model-picker computer-use-backend-picker">
        <div {...select.rootProps} className={`${select.rootProps.className} fc-model-picker__select`}>
          <button {...select.triggerProps} className="fc-select__trigger fc-model-picker__trigger" aria-label={t("settings.computerUse.backend")}>
            <span className="fc-model-picker__glyph fc-model-picker__glyph--mark" aria-hidden="true"><ComputerUseGlyph backend={backend} /></span>
            <span className="fc-select__value fc-model-picker__name">{BACKENDS.find(option => option.value === backend)?.label}</span>
            <span className="fc-select__caret" aria-hidden="true">⌄</span>
          </button>
          {select.isOpen && createPortal(<ul {...select.listboxProps} className={`${select.listboxProps.className} fc-model-picker__popup`} style={widenModelPickerPopup(select.listboxProps.style, popupWidth)} aria-label={t("settings.computerUse.backend")}>
            {BACKENDS.map((option, index) => <li key={option.value} {...select.getOptionProps(index)} className="fc-select__option fc-model-picker__option"><span className="fc-model-picker__glyph fc-model-picker__glyph--mark" aria-hidden="true"><ComputerUseGlyph backend={option.value as ComputerUseBackendId} /></span><span className="fc-model-picker__name">{option.label}</span></li>)}
          </ul>, document.body)}
        </div>
        </div>
        {backend === "cua-driver" && status?.installation === "missing" && status.installer?.supported && <button type="button" className="fc-settings-reset" disabled={installing || saving} onClick={() => void install()}>{t(installing ? "settings.computerUse.installing" : "settings.computerUse.install")}</button>}
        {unavailable && <button type="button" className="fc-settings-reset" onClick={() => setRefreshKey((key) => key + 1)}>{t("settings.computerUse.retry")}</button>}
        {active && <button type="button" className="fc-settings-reset" disabled={working || status.state === "stopping"} onClick={() => void stop()}>{t("settings.computerUse.stop")}</button>}
        <SettingsToggle checked={enabled} disabled={saving || working || (!enabled && (status?.backend !== backend || !status?.supported || unavailable || status.installation !== "available"))} ariaLabel={t("settings.computerUse.title")} onChange={onChange} />
      </div>
    </div>
    {code && <p role="alert" className="global-settings-help">
      {t(`settings.computerUse.${errorKey}`)}
      <SettingsHelp title={t("settings.computerUse.details")}><code>{code}</code>{status?.activeTool && <p>{status.activeTool} · {status.stage}</p>}</SettingsHelp>
    </p>}
  </>;
}
