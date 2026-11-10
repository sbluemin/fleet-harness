import { useEffect, useState } from "react";
import { CONSOLE_WSL_EVENT, consoleSectionCommandUrl, isConsoleWslState, type ConsoleSectionCommand, type ConsoleWslInspection, type ConsoleWslState } from "@fleet-console/protocol/desktop/console-section";

import { useT, type CoreMessageKey } from "../../../core/client/src/i18n/index.js";
import "./add-wsl-console.css";

const EXISTING: Partial<Record<ConsoleWslInspection["existing"], CoreMessageKey>> = {
  stale: "chrome.consoles.wsl.existing.stale",
  cli: "chrome.consoles.wsl.existing.cli",
  "this-desktop": "chrome.consoles.wsl.existing.thisDesktop",
  "other-desktop": "chrome.consoles.wsl.existing.otherDesktop",
  unknown: "chrome.consoles.wsl.existing.unknown",
};

/**
 * 콘솔 추가 카드의 WSL 배포판 고르기. Windows의 Fleet Desktop이 집 Console의 덮개에서만 그린다.
 *
 * 화면은 셸이 알려 준 것만 보여 준다 — 배포판 목록, 그리고 사람이 「확인」을 누른 배포판 하나의 안쪽.
 * 목록을 여는 것은 멈춘 배포판을 깨우지 않는다. 안쪽을 보는 일과 등록은 사람이 누를 때만 일어나고,
 * 등록은 아무것도 설치하거나 켜지 않는다. 설치와 시작은 추가된 구역의 「시작」에서 한다.
 */
export function AddWslConsole({ onAdded }: { readonly onAdded: () => void }) {
  const t = useT();
  const [state, setState] = useState<ConsoleWslState | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const send = (value: ConsoleSectionCommand) => location.assign(consoleSectionCommandUrl(location.origin, value));

  useEffect(() => {
    const update = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail;
      if (isConsoleWslState(value)) setState(value);
    };
    window.addEventListener(CONSOLE_WSL_EVENT, update);
    send({ wsl: { list: true } });
    return () => window.removeEventListener(CONSOLE_WSL_EVENT, update);
  }, []);
  const added = state?.added ?? null;
  useEffect(() => { if (added !== null) onAdded(); }, [added, onAdded]);

  if (state === null || state.distros.length === 0) return null;
  const distro = state.distros.find((item) => item.name === picked) ?? null;
  const seen = state.inspection !== null && state.inspection.distro === picked ? state.inspection : null;
  const checking = state.busy === "inspect";
  const existing = seen ? EXISTING[seen.existing] : undefined;
  return (
    <section className="add-wsl" aria-label={t("chrome.consoles.wsl.title")}>
      <h3 className="add-wsl-title">{t("chrome.consoles.wsl.title")}</h3>
      <p className="add-host-note">{t("chrome.consoles.wsl.lede")}</p>
      <ul className="add-wsl-list">
        {state.distros.map((item) => <li key={item.name}>
          <button type="button" className={`add-wsl-row${item.name === picked ? " is-picked" : ""}`} aria-pressed={item.name === picked} disabled={item.managed || checking}
            onClick={() => setPicked(item.name)}>
            <b>{item.name}</b>
            <small>{item.version === null ? "WSL" : `WSL ${item.version}`} · {t(item.managed ? "chrome.consoles.wsl.managed" : item.running ? "chrome.consoles.wsl.running" : "chrome.consoles.wsl.stopped")}</small>
          </button>
        </li>)}
      </ul>
      {distro && !seen ? <div className="add-wsl-step">
        {/* 안쪽을 보려면 멈춘 배포판이 켜진다. 누르기 전에 말한다. */}
        {!distro.running ? <p className="add-host-note">{t("chrome.consoles.wsl.wakeNote")}</p> : null}
        <button type="button" className="add-host-cancel" disabled={checking} onClick={() => send({ wsl: { inspect: distro.name } })}>
          {t(checking ? "chrome.consoles.wsl.checking" : distro.running ? "chrome.consoles.wsl.check" : "chrome.consoles.wsl.checkWake")}
        </button>
      </div> : null}
      {seen ? <div className="add-wsl-step">
        <dl className="add-wsl-plan">
          <dt>{t("chrome.consoles.wsl.user")}</dt><dd>{seen.user}</dd>
          <dt>{t("chrome.consoles.wsl.runtime")}</dt>
          <dd>{t(seen.runtime === "ready" ? "chrome.consoles.wsl.runtimeReady" : "chrome.consoles.wsl.runtimeMissing")}
            {seen.runtime === "missing" && seen.missingTools.length > 0 ? <small className="add-wsl-warn">{t("chrome.consoles.wsl.tools", { tools: seen.missingTools.join(", ") })}</small> : null}</dd>
          {existing || seen.ownFleet ? <><dt>{t("chrome.consoles.wsl.found")}</dt>
            <dd>{existing ? t(existing) : null}{seen.ownFleet ? <small>{t("chrome.consoles.wsl.ownFleet")}</small> : null}</dd></> : null}
        </dl>
        <div className="add-host-actions">
          <button type="button" className="add-host-submit" onClick={() => send({ wsl: { add: seen.distro } })}>{t("chrome.consoles.wsl.add")}</button>
        </div>
      </div> : null}
      {state.error ? <p className="add-host-error" role="alert">{t(state.error === "unusable" ? "chrome.consoles.wsl.errorUnusable" : "chrome.consoles.wsl.errorFailed")}</p> : null}
    </section>
  );
}
