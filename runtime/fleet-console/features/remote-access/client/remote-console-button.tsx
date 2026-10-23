import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ConsoleSectionCommand, ConsoleSectionEntry, ConsoleSectionState } from "@fleet-console/protocol/desktop/console-section";
import { useT } from "../../../core/client/src/i18n/index.js";
import { ConsoleGlyph } from "./console-section.js";
import "./remote-console-button.css";

/** 셸의 최소 표시 상태만 사용한다. 패널 열림은 기존 expanded 명령으로 알린다. */
export function RemoteConsoleButton({ state, command, compact }: {
  readonly state: ConsoleSectionState; readonly command: (value: ConsoleSectionCommand) => void;
  readonly compact: boolean;
}) {
  const t = useT();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const opening = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState("");
  const [position, setPosition] = useState<CSSProperties>({});
  const current = state.entries.find((entry) => entry.active);
  const statusText = (entry: ConsoleSectionEntry | undefined) => entry?.status === "unreachable" ? t("chrome.hosts.unreachable") : entry?.status === "untrusted" ? t("chrome.hosts.untrusted") : entry?.status === "stopping" ? t("chrome.hosts.stopping") : entry?.status === "slow" ? t("chrome.hosts.slow") : "";
  const label = `${t("chrome.hosts.aria")}: ${current?.label ?? ""}${statusText(current) ? `, ${statusText(current)}` : ""}`;
  const clearTimers = () => { clearTimeout(opening.current); clearTimeout(closing.current); };
  const close = (focus = false) => {
    clearTimers(); setOpen(false); setPinned(false); setEditing(null); setConfirming(false);
    if (focus) trigger.current?.focus();
  };
  const show = (pin: boolean, focus = false) => {
    clearTimers(); setOpen(true); if (pin) setPinned(true);
    if (focus) requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>('[aria-current="location"]') ?? panel.current?.querySelector<HTMLElement>("[data-console-nav]"))?.focus());
  };
  const scheduleClose = () => {
    clearTimeout(opening.current);
    if (!pinned && !editing) closing.current = setTimeout(() => close(), 250);
  };
  useEffect(() => () => clearTimers(), []);
  useEffect(() => { command({ expanded: open }); }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = trigger.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const sidebar = button.closest(".objective-records-side-bar")?.getBoundingClientRect();
      const width = Math.min(compact ? 300 : Math.max(248, (sidebar?.width ?? 280) - 16), window.innerWidth - 16);
      const left = Math.max(8, Math.min(compact ? (sidebar?.right ?? rect.right) + 6 : (sidebar?.left ?? rect.left) + 8, window.innerWidth - width - 8));
      // 계정 위의 문은 화면 아래에 있으므로 옆 패널을 위로 당겨 뷰포트 안에 담는다.
      const top = compact ? Math.max(8, Math.min(rect.top, window.innerHeight - Math.min(panel.current?.scrollHeight ?? 300, window.innerHeight - 16) - 8)) : rect.bottom + 7;
      setPosition({ left, top, width, maxHeight: Math.max(80, window.innerHeight - top - 8) });
    };
    place();
    const resize = new ResizeObserver(place);
    if (panel.current) resize.observe(panel.current);
    if (trigger.current?.closest(".objective-records-side-bar")) resize.observe(trigger.current.closest(".objective-records-side-bar")!);
    // 문서 끝에서 Tab이 순환하면 focusout.relatedTarget은 null일 수 있다. 실제 도착한 포커스로 경계를 판정한다.
    const outside = (event: PointerEvent | FocusEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation();
      if (editing) { setEditing(null); setConfirming(false); requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('[aria-current="location"]')?.focus()); }
      else close(true);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", place);
    return () => { resize.disconnect(); document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside, true); document.removeEventListener("keydown", escape, true); window.removeEventListener("resize", place); };
  }, [open, compact, editing]);
  const act = (value: ConsoleSectionCommand) => { close(); command(value); };
  return <>
    <button ref={trigger} type="button" className={`conversation-round remote-console-button${compact ? " is-compact" : ""}${current && !current.home ? " is-away" : ""}`} data-status={current?.status ?? undefined} aria-haspopup="dialog" aria-controls={id} aria-expanded={open} aria-label={label} title={label}
      onPointerEnter={(event) => { if (event.pointerType !== "mouse") return; clearTimeout(closing.current); if (!open) opening.current = setTimeout(() => show(false), 120); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") scheduleClose(); }}
      onClick={(event) => { if (open && pinned) close(); else show(true, event.detail === 0); }}
      onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); show(true, true); } }}>
      <ConsoleGlyph remote={current?.kind === "remote"} />
      {current?.status && ["slow", "untrusted", "unreachable"].includes(current.status) ? <span className="remote-console-dot" aria-hidden="true" /> : null}
    </button>
    {open ? createPortal(<div ref={panel} id={id} role="dialog" aria-label={t("chrome.hosts.aria")} className={`remote-console-panel${compact ? " is-side" : ""}`} style={position}
      onPointerEnter={() => clearTimeout(closing.current)} onPointerLeave={(event) => { if (event.pointerType === "mouse") scheduleClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-console-nav]")];
        const at = rows.indexOf(document.activeElement as HTMLElement);
        if (at < 0) return;
        event.preventDefault(); rows[(at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
      }}>
      {state.entries.map((entry) => {
        const blocked = entry.active || entry.status === "unreachable" || entry.status === "untrusted" || entry.status === "stopping";
        return <div key={entry.id} className={`remote-console-entry${entry.active ? " is-current" : ""}`}>
          {editing === entry.id ? confirming ? <div className="remote-console-form"><p>{t("chrome.consoles.forgetWarning")}</p><div><button type="button" autoFocus onClick={() => setConfirming(false)}>{t("common.cancel")}</button><button type="button" className="is-danger" onClick={() => { command({ forget: entry.id }); setEditing(null); setConfirming(false); }}>{t("settings.remote.hosts.forget")}</button></div></div> : <form className="remote-console-form" onSubmit={(event) => { event.preventDefault(); if (name.trim()) { command({ rename: { id: entry.id, label: name.trim() } }); setEditing(null); } }}>
            <input autoFocus aria-label={t("settings.remote.hosts.rename")} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
            <div><button type="submit" disabled={!name.trim()}>{t("chrome.consoles.save")}</button><button type="button" onClick={() => setEditing(null)}>{t("common.cancel")}</button>{!entry.active ? <button type="button" className="is-danger" onClick={() => setConfirming(true)}>{t("settings.remote.hosts.forget")}</button> : null}</div>
          </form> : <>
            <button type="button" data-console-nav className="remote-console-row" aria-current={entry.active ? "location" : undefined} aria-disabled={blocked} onClick={() => { if (!blocked) act({ switch: entry.id }); }} title={`${entry.label} · ${entry.address}`}>
              <ConsoleGlyph remote={entry.kind === "remote"} /><span className="remote-console-text"><span className="remote-console-name">{entry.label}{entry.home && current && !current.home ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-label={t("chrome.consoles.home")}><path d="m2 7 6-5 6 5M4 6v8h8V6" /></svg> : null}</span><span className="remote-console-detail">{statusText(entry) ? <><span className={`remote-console-status is-${entry.status}`}>{statusText(entry)}</span> · </> : null}{entry.address}{entry.version ? ` · v${entry.version}` : ""}</span></span>
            </button>
            {entry.kind === "remote" ? <button type="button" className="remote-console-edit" aria-label={`${entry.label}: ${t("settings.remote.hosts.rename")}`} title={t("settings.remote.hosts.rename")} onClick={() => { clearTimers(); setPinned(true); setEditing(entry.id); setName(entry.label); setConfirming(false); }}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="m10.5 2.8 2.7 2.7L6 12.7l-3.2.5.5-3.2z" /></svg></button> : null}
          </>}
        </div>;
      })}
      <div className="remote-console-separator" />
      <button type="button" data-console-nav className="remote-console-add" onClick={() => act({ add: true })}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>{t("chrome.hosts.add")}</button>
    </div>, document.body) : null}
  </>;
}
