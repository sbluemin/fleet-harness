import { useEffect, useRef, useState } from "react";
import { CONSOLE_SECTION_EVENT, consoleSectionCommandUrl, isConsoleSectionState, type ConsoleSectionCommand, type ConsoleSectionEntry } from "@fleet-console/protocol/desktop/console-section";

import { desktopPickerUrl, PICKER_SURFACE_DISMISS } from "../../../core/client/src/integration/desktop-shell.js";
import { useT, type CoreMessageKey } from "../../../core/client/src/i18n/index.js";
import { ConsoleGlyph } from "./console-section.js";
import "./manage-console-card.css";

const MANAGEMENT: Record<NonNullable<ConsoleSectionEntry["management"]>, readonly [CoreMessageKey, CoreMessageKey | null]> = {
  "this-desktop": ["chrome.consoles.management.thisDesktop", "chrome.consoles.management.thisDesktopNote"],
  "other-desktop": ["chrome.consoles.management.otherDesktop", "chrome.consoles.management.otherDesktopNote"],
  cli: ["chrome.consoles.management.cli", "chrome.consoles.management.cliNote"],
  unknown: ["chrome.consoles.management.unknown", null],
};
const FAILURE: Record<NonNullable<NonNullable<ConsoleSectionEntry["managed"]>["failure"]>, CoreMessageKey> = {
  "build-tools": "chrome.consoles.failure.buildTools",
  download: "chrome.consoles.failure.download",
  install: "chrome.consoles.failure.install",
  start: "chrome.consoles.failure.start",
  "other-owner": "chrome.consoles.failure.otherOwner",
  stop: "chrome.consoles.failure.stop",
};
const PATH: Record<NonNullable<ConsoleSectionEntry["path"]>, CoreMessageKey> = {
  loopback: "chrome.consoles.path.loopback",
  wsl: "chrome.consoles.path.wsl",
  remote: "chrome.consoles.path.remote",
};

/** 행의 상태 문구. 관리 대상의 생명주기가 연결 상태보다 먼저다 — 꺼진 콘솔은 "연결 불가"가 아니라 "중지됨"이다. */
export function consoleLifecycleKey(entry: ConsoleSectionEntry): CoreMessageKey | null {
  if (entry.managed?.updating) return "chrome.consoles.lifecycle.updating";
  if (entry.managed?.installing) return "chrome.consoles.lifecycle.installing";
  if (entry.lifecycle === "stopped") return "chrome.consoles.lifecycle.stopped";
  if (entry.lifecycle === "starting") return "chrome.consoles.lifecycle.starting";
  if (entry.lifecycle === "stopping") return "chrome.hosts.stopping";
  if (entry.lifecycle === "failed") return "chrome.consoles.lifecycle.failed";
  return null;
}

/**
 * 콘솔 하나의 관리 화면. 집 Console이 자기 루프백에서 그리고, 셸이 지금 보는 콘솔 위에 얹는다.
 *
 * 화면은 셸이 준 최소 상태만 읽는다 — 관리·조작·경로 세 관계와, 셸이 지금 받아 줄 동작. 누를 수 있는
 * 동작은 셸이 정하고, 눌린 명령은 셸이 관리자의 새 증명으로 다시 판정한다. 이 화면은 권한을 갖지 않는다.
 */
export function ManageConsoleCard({ target }: { readonly target: string }) {
  const t = useT();
  const [entry, setEntry] = useState<ConsoleSectionEntry | null | undefined>(undefined);
  const [confirming, setConfirming] = useState<"restart" | "stop" | "takeover" | "update" | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const send = (value: ConsoleSectionCommand) => location.assign(consoleSectionCommandUrl(location.origin, value));
  const close = () => location.assign(desktopPickerUrl(location.origin, PICKER_SURFACE_DISMISS));

  useEffect(() => {
    const update = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail;
      if (isConsoleSectionState(value)) setEntry(value.entries.find((item) => item.id === target) ?? null);
    };
    window.addEventListener(CONSOLE_SECTION_EVENT, update);
    // 셸은 이 문서가 다 읽힌 뒤 상태를 한 번 밀어 준다. 그보다 늦게 붙은 경우를 위해 한 번 더 청한다.
    send({ request: "state" });
    return () => window.removeEventListener(CONSOLE_SECTION_EVENT, update);
  }, [target]);
  const loaded = entry !== undefined;
  useEffect(() => { card.current?.querySelector<HTMLElement>("button")?.focus(); }, [loaded]);
  // 배타적인 창이다 — Tab은 카드 안을 돈다. Escape는 셸이 덮개째 걷는다.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || card.current === null) return;
      const focusable = [...card.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!card.current.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  // 동작이 더는 허용되지 않으면(이미 다른 상태가 됐으면) 확인도 거둔다.
  useEffect(() => { if (confirming && !(confirming === "takeover" ? entry?.managed?.takeover : confirming === "update" ? entry?.managed?.update : entry?.actions?.includes(confirming))) setConfirming(null); }, [entry, confirming]);

  const lifecycle = entry ? consoleLifecycleKey(entry) : null;
  const management = entry?.management ? MANAGEMENT[entry.management] : null;
  const actions = entry?.actions ?? [];
  return (
    <div className="add-host-overlay" role="presentation">
      <button type="button" className="add-host-scrim" aria-label={t("common.close")} onClick={close} />
      <div ref={card} className="add-host-card manage-console-card" role="dialog" aria-modal="true" aria-label={t("chrome.hosts.manage")}>
        <div className="add-host-head">
          <div className="manage-console-title">
            <h2 className="add-host-title">{entry?.label ?? t("chrome.hosts.manage")}</h2>
            {entry ? <p className="manage-console-state">
              {lifecycle ? <span className={`manage-console-lifecycle is-${entry.lifecycle}`}>{t(lifecycle)}</span> : null}
              {lifecycle && (entry.address !== entry.label || entry.version) ? " · " : ""}{entry.address !== entry.label ? entry.address : ""}{entry.version ? `${entry.address !== entry.label ? " · " : ""}v${entry.version}` : ""}
            </p> : null}
          </div>
          <button type="button" className="add-host-close" onClick={close} aria-label={t("common.close")}>×</button>
        </div>
        {entry === null ? <p className="add-host-lede">{t("chrome.consoles.manageGone")}</p> : null}
        {entry ? <>
          <dl className="manage-console-relations">
            <dt>{t("chrome.consoles.relation.management")}</dt>
            <dd>{management ? <>{t(management[0])}{management[1] && (entry.management !== "this-desktop" || entry.lifecycle === "running") ? <small>{t(management[1])}</small> : null}</> : null}</dd>
            <dt>{t("chrome.consoles.relation.operation")}</dt>
            <dd>{t(entry.active ? "chrome.consoles.operation.active" : "chrome.consoles.operation.inactive")}</dd>
            <dt>{t("chrome.consoles.relation.path")}</dt>
            <dd><span className="manage-console-path"><ConsoleGlyph remote={entry.kind === "remote"} />{entry.path ? t(PATH[entry.path]) : null}</span></dd>
          </dl>
          {entry.managed?.update ? <div className="manage-console-update">
            <p className="add-host-lede">{t("chrome.consoles.updateAvailable")}</p>
            <dl className="manage-console-relations">
              <dt>Node</dt><dd>{t("chrome.consoles.updateVersions", entry.managed.update.node)}</dd>
              <dt>Console</dt><dd>{t("chrome.consoles.updateVersions", entry.managed.update.console)}</dd>
            </dl>
          </div> : null}
          {entry.managed?.failure ? <p className="add-host-error" role="alert">{t(FAILURE[entry.managed.failure])}</p> : null}
          {confirming ? <div className="manage-console-confirm">
            <p className="add-host-lede">{t(confirming === "restart" ? "chrome.consoles.restartConfirm" : confirming === "stop" ? "chrome.consoles.stopConfirm" : confirming === "update" ? "chrome.consoles.updateConfirm" : "chrome.consoles.takeoverConfirm")}</p>
            <div className="add-host-actions">
              <button type="button" className="add-host-cancel" onClick={() => setConfirming(null)}>{t("common.cancel")}</button>
              <button type="button" className="add-host-submit" onClick={() => { send(confirming === "takeover" ? { takeover: entry.id } : confirming === "update" ? { update: entry.id } : { lifecycle: { id: entry.id, action: confirming } }); setConfirming(null); }}>
                {t(confirming === "restart" ? "chrome.consoles.restart" : confirming === "stop" ? "chrome.consoles.stop" : confirming === "update" ? "chrome.consoles.update" : "chrome.consoles.takeover")}</button>
            </div>
          </div> : actions.length || entry.managed?.update || entry.managed?.takeover || entry.managed?.removable ? <div className="manage-console-actions">
            {entry.managed?.update ? <button type="button" className="add-host-submit manage-console-update-button" onClick={() => setConfirming("update")}>{t("chrome.consoles.update")}</button> : null}
            {actions.includes("start") ? <button type="button" className="add-host-submit" onClick={() => send({ lifecycle: { id: entry.id, action: "start" } })}>{t("chrome.consoles.start")}</button> : null}
            {actions.includes("restart") ? <button type="button" className="add-host-cancel" onClick={() => setConfirming("restart")}>{t("chrome.consoles.restart")}</button> : null}
            {actions.includes("stop") ? <button type="button" className="add-host-cancel" onClick={() => setConfirming("stop")}>{t("chrome.consoles.stop")}</button> : null}
            {entry.managed?.takeover ? <button type="button" className="add-host-cancel" onClick={() => setConfirming("takeover")}>{t("chrome.consoles.takeover")}</button> : null}
            {/* 관리 해제의 확인은 셸이 자기 대화상자로 묻는다 — 여기서 한 번 더 묻지 않는다. */}
            {entry.managed?.removable ? <button type="button" className="add-host-cancel manage-console-quiet" onClick={() => send({ forget: entry.id })}>{t("chrome.consoles.unmanage")}</button> : null}
          </div> : null}
          {entry.home && entry.management === "this-desktop" ? <p className="add-host-note">{t("chrome.consoles.homeStopNote")}</p> : null}
        </> : null}
      </div>
    </div>
  );
}
