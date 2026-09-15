import { useEffect, useState } from "react";
import { useT } from "../i18n/index.js";
import { SettingsHelp } from "../components/settings-help.js";
import { refreshBrowserEngine } from "../browser/browser-panel-store.js";
import "./browser-engine-row.css";

interface EngineSettings {
  readonly configuredPath: string;
  readonly executable: string | null;
  readonly available: boolean;
  readonly environmentOverride: boolean;
}

export function BrowserEngineRow() {
  const t = useT();
  const [status, setStatus] = useState<EngineSettings | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const accept = (value: EngineSettings) => { setStatus(value); setDraft(value.configuredPath); };
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/browser/engine", { method: "POST", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("unavailable");
      const value = await response.json() as EngineSettings;
      if (!controller.signal.aborted) accept(value);
    }).catch(() => { if (!controller.signal.aborted) setError("unavailable"); });
    return () => controller.abort();
  }, []);

  const save = async (value: string, restart = false) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/v1/browser/engine", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: value, restart }) });
      const result = await response.json() as EngineSettings & { error?: string };
      if (!response.ok) {
        if (result.error === "browser_engine_restart_required") { setPending(value); return; }
        throw new Error(result.error ?? "failed");
      }
      accept(result); setPending(null); refreshBrowserEngine();
    } catch (error) { setError(error instanceof Error ? error.message : "failed"); }
    finally { setBusy(false); }
  };
  const locked = busy || !status || status.environmentOverride;
  return <div className="browser-engine-settings">
    <div className="global-settings-row experiments-row">
      <div className="global-settings-row-text"><p className="global-settings-resp-title">
        {t("settings.browserEngine.title")}
        <SettingsHelp title={t("settings.browserEngine.title")}>
          {t("settings.browserEngine.help").split("\n").map(line => <p key={line}>{line}</p>)}
        </SettingsHelp>
      </p></div>
      {status?.environmentOverride && <span className="global-settings-help">{t("settings.browserEngine.environment")}</span>}
    </div>
    <form className="browser-engine-settings__form" onSubmit={event => { event.preventDefault(); void save(draft.trim()); }}>
      <input className="global-settings-input" aria-label={t("settings.browserEngine.path")} value={draft} placeholder={status?.executable ?? t("settings.browserEngine.placeholder")} disabled={locked || pending !== null} spellCheck={false} autoComplete="off" onChange={event => { setDraft(event.target.value); setError(null); }} />
      <button type="submit" className="fc-settings-reset" disabled={locked || pending !== null}>{t(busy ? "settings.browserEngine.checking" : "settings.browserEngine.save")}</button>
      {status?.configuredPath && <button type="button" className="fc-settings-reset" disabled={locked || pending !== null} onClick={() => void save("")}>{t("settings.browserEngine.reset")}</button>}
    </form>
    {status && !status.available && <p className="global-settings-help">{t("settings.browserEngine.missing")}</p>}
    {pending !== null && <div className="browser-engine-settings__confirmation" role="alert">
      <p className="global-settings-help">{t("settings.browserEngine.restart")}</p>
      <button type="button" className="fc-settings-reset" disabled={busy} onClick={() => void save(pending, true)}>{t("settings.browserEngine.apply")}</button>
      <button type="button" className="fc-settings-reset" disabled={busy} onClick={() => setPending(null)}>{t("settings.browserEngine.cancel")}</button>
    </div>}
    {error && <p className="global-settings-help" role="alert">{t(error === "unavailable" || error === "browser_unavailable" ? "settings.browserEngine.unavailable" : error === "browser_engine_invalid" ? "settings.browserEngine.invalid" : "settings.browserEngine.failed")}</p>}
  </div>;
}
