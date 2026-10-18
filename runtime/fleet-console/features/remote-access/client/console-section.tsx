import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ConsoleSectionCommand, ConsoleSectionEntry, ConsoleSectionState } from "@fleet-console/protocol/desktop/console-section";
import { desktopPickerUrl, PICKER_SURFACE_DISMISS } from "../../../core/client/src/integration/desktop-shell.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { useT } from "../../../core/client/src/i18n/index.js";
import { AddHostDialog } from "./add-host-dialog.js";
import { fetchLocalConsoles, forgetRemoteHost, probeRemoteHost, refreshRemoteHosts, renameRemoteHost, useRemoteHosts, type LocalConsole, type RemoteHostReach } from "./remote-hosts.js";

/** 옛 원격 Console이 부르는 집 전용 목록. 활성 문서의 새 섹션은 이 API 경로를 쓰지 않는다. */
export function ConsoleSection({ pickerAt, initialAdd = false }: { readonly pickerAt: string | null; readonly initialAdd?: boolean }) {
  const t = useT();
  const state = useConsoleState();
  const hosts = useRemoteHosts();
  const [local, setLocal] = useState<readonly LocalConsole[]>([]);
  const [reach, setReach] = useState<Readonly<Record<string, RemoteHostReach>>>({});
  const [addOpen, setAddOpen] = useState(initialAdd);
  const [error, setError] = useState(false);
  const at = pickerAt ?? location.origin;
  const dismiss = () => location.assign(desktopPickerUrl(location.origin, PICKER_SURFACE_DISMISS));
  useEffect(() => {
    const controller = new AbortController();
    void refreshRemoteHosts(controller.signal).catch(() => { if (!controller.signal.aborted) setError(true); });
    void fetchLocalConsoles(controller.signal).then(setLocal).catch(() => undefined);
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    for (const host of hosts) void probeRemoteHost(host.id, controller.signal).then((result) => {
      if (!controller.signal.aborted) setReach((previous) => ({ ...previous, [host.id]: result }));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [hosts]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !addOpen && !event.defaultPrevented) { event.preventDefault(); dismiss(); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [addOpen]);
  if (addOpen) return <AddHostDialog onClose={dismiss} />;
  const home = local.find((entry) => entry.origin === location.origin) ?? { origin: location.origin, version: "", state: "ready" };
  const entries: ConsoleSectionEntry[] = [home, ...local.filter((entry) => entry.origin !== location.origin)].map((entry) => ({
    id: entry.origin, kind: "local", label: entry.origin === location.origin ? state.consoleName || t("chrome.hosts.managedConsole") : t("chrome.hosts.console"), address: new URL(entry.origin).host,
    version: entry.version || null, active: entry.origin === at, home: entry.origin === location.origin, status: entry.state === "stopping" ? "stopping" : entry.state === "unresponsive" ? "slow" : "ready",
  }));
  entries.push(...hosts.map((host): ConsoleSectionEntry => ({ id: host.id, kind: "remote", label: host.label, address: new URL(host.origin).host, version: null, active: host.origin === at, home: false,
    status: reach[host.id]?.reachable === false ? "unreachable" : reach[host.id]?.trusted === false ? "untrusted" : null })));
  if (!entries.some((entry) => entry.active)) entries.push({ id: at, kind: "remote", label: new URL(at).host, address: new URL(at).host, version: null, active: true, home: false, status: null });
  const command = async (value: ConsoleSectionCommand) => {
    if ("add" in value) setAddOpen(true);
    else if ("switch" in value) {
      const host = hosts.find((entry) => entry.id === value.switch);
      const origin = host?.origin ?? entries.find((entry) => entry.id === value.switch)?.id;
      if (origin) location.assign(new URL("/console/", origin).toString());
    } else if ("rename" in value) await renameRemoteHost(value.rename.id, value.rename.label);
    else if ("forget" in value) await forgetRemoteHost(value.forget);
  };
  return <><ConsoleSectionView state={{ v: 1, expanded: true, entries }} command={command} picker />{error ? <p role="alert" className="console-section-error">{t("chrome.consoles.loadFailed")}</p> : null}</>;
}

/** 상태는 셸 또는 집 목록 어댑터가 소유한다. 이 컴포넌트는 표시와 입력만 맡는다. */
export function ConsoleSectionView({ state, command, compact = false, picker = false, popup = false }: {
  readonly state: ConsoleSectionState; readonly command: (value: ConsoleSectionCommand) => void | Promise<void>;
  readonly compact?: boolean; readonly picker?: boolean; readonly popup?: boolean;
}) {
  const t = useT();
  const listId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const [editing, setEditing] = useState(() => picker && new URLSearchParams(location.search).get("intent") === "manage");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [overlayExpanded, setOverlayExpanded] = useState(true);
  const expanded = popup || picker ? overlayExpanded : state.expanded;
  const expand = (value: boolean) => { if (popup || picker) setOverlayExpanded(value); if (!picker) send({ expanded: value }); };
  const current = state.entries.find((entry) => entry.active);
  const home = state.entries.find((entry) => entry.home);
  const away = current !== undefined && !current.home;
  const send = (value: ConsoleSectionCommand) => { void Promise.resolve(command(value)).catch(() => setError(true)); };
  const mutate = async (value: ConsoleSectionCommand) => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await command(value); setRenaming(null); setConfirming(null); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const toggle = () => { if (expanded) { setEditing(false); setRenaming(null); setConfirming(null); } expand(!expanded); };
  const row = (entry: ConsoleSectionEntry): ReactNode => {
    const blocked = entry.active || entry.status === "unreachable" || entry.status === "untrusted" || entry.status === "stopping";
    const status = entry.status === "unreachable" ? t("chrome.hosts.unreachable") : entry.status === "untrusted" ? t("chrome.hosts.untrusted") : entry.status === "stopping" ? t("chrome.hosts.stopping") : entry.status === "slow" ? t("chrome.hosts.slow") : null;
    const detail = `${entry.address}${entry.version ? ` · v${entry.version}` : ""}`;
    return <div className="console-section-row-wrap"><button type="button" className={`console-section-row${entry.active ? " is-current" : ""}`} aria-current={entry.active ? "location" : undefined} aria-disabled={blocked} title={`${entry.label} · ${detail}`} onClick={() => { if (!blocked) send({ switch: entry.id }); }}>
      <ConsoleGlyph remote={entry.kind === "remote"} /><span className="console-section-name">{entry.label}</span><span className="console-section-address">{detail}</span>{status ? <span className={`console-section-status${entry.status === "unreachable" ? " is-coral" : entry.status === "untrusted" || entry.status === "slow" ? " is-warn" : ""}`}>{status}</span> : null}
    </button>{entry.active && away && home ? <button type="button" className="console-section-action" title={t("chrome.consoles.home")} aria-label={t("chrome.consoles.home")} onClick={() => send({ switch: home.id })}><HomeGlyph /></button> : null}</div>;
  };
  return <nav className={`console-section${compact ? " is-compact" : ""}${picker ? " is-picker" : ""}`} aria-label={t("chrome.consoles.document")}>
    {compact ? <button ref={toggleRef} type="button" className="console-section-compact" aria-current="location" aria-label={`${t("chrome.hosts.aria")}: ${current?.label ?? ""}`} title={`${t("chrome.hosts.aria")}: ${current?.label ?? ""}`} onClick={() => setPopupOpen(true)}><ConsoleGlyph remote={away} /></button> : <>
      <header className="console-section-header"><button ref={toggleRef} type="button" className="console-section-toggle" aria-expanded={expanded} aria-controls={listId} onClick={toggle}><span className={expanded ? "" : "is-folded"} aria-hidden="true">⌄</span>{t("chrome.hosts.heading")}</button>
        <button type="button" className="console-section-action console-section-glyph" title={t("chrome.hosts.add")} aria-label={t("chrome.hosts.add")} onClick={() => { setPopupOpen(false); send({ add: true }); }}><PlusGlyph /></button>
        <button type="button" className="console-section-action console-section-glyph" aria-pressed={editing} title={t("chrome.hosts.manage")} aria-label={t("chrome.hosts.manage")} onClick={() => { setEditing(!editing); setRenaming(null); setConfirming(null); if (!expanded) expand(true); }}><SlidersGlyph /></button></header>
      {expanded ? <div id={listId} className="console-section-list">{(["local", "remote"] as const).map((kind) => {
        const entries = state.entries.filter((entry) => entry.kind === kind);
        return entries.length ? <div key={kind}><p className="console-section-group">{t(kind === "local" ? "chrome.hosts.nearby" : "chrome.hosts.saved")}</p>{entries.map((entry) => <div key={entry.id}>
          {renaming === entry.id ? <form className="console-section-rename" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void mutate({ rename: { id: entry.id, label: name.trim() } }); }}>
            <input autoFocus value={name} aria-label={t("settings.remote.hosts.rename")} maxLength={120} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); setRenaming(null); } }} />
            <button type="submit" disabled={busy || !name.trim()}>{t("chrome.consoles.save")}</button><button type="button" onClick={() => setRenaming(null)}>{t("common.cancel")}</button>
          </form> : <div className="console-section-edit-row">{row(entry)}{editing && kind === "remote" ? <><button type="button" className="console-section-action" aria-label={`${entry.label}: ${t("settings.remote.hosts.rename")}`} title={t("settings.remote.hosts.rename")} onClick={() => { setRenaming(entry.id); setName(entry.label); setConfirming(null); }}>✎</button><button type="button" className="console-section-action" aria-label={`${entry.label}: ${t("settings.remote.hosts.forget")}`} title={t("settings.remote.hosts.forget")} onClick={() => { setConfirming(entry.id); setRenaming(null); }}>−</button></> : null}</div>}
          {confirming === entry.id ? <div className="console-section-confirm"><button type="button" onClick={() => setConfirming(null)} disabled={busy}>{t("common.cancel")}</button><button type="button" className="is-danger" title={t("chrome.consoles.forgetWarning")} aria-description={t("chrome.consoles.forgetWarning")} disabled={busy} onClick={() => void mutate({ forget: entry.id })}>{t("settings.remote.hosts.forget")}</button></div> : null}
        </div>)}</div> : null;
      })}</div> : current ? <div className="console-section-row-wrap"><button type="button" className="console-section-row is-current" aria-current="location" aria-expanded={false} onClick={toggle}><ConsoleGlyph remote={away} /><span className="console-section-name">{current.label}</span><span className="console-section-address">{away ? t("chrome.consoles.remote") : t("chrome.hosts.nearby")}</span></button>{away && home ? <button type="button" className="console-section-action" aria-label={t("chrome.consoles.home")} title={t("chrome.consoles.home")} onClick={() => send({ switch: home.id })}><HomeGlyph /></button> : null}</div> : null}
    </>}
    {error ? <p role="alert" className="console-section-error">{t("chrome.consoles.editFailed")}</p> : null}
    {popupOpen ? <ConsolePopup onClose={() => { setPopupOpen(false); requestAnimationFrame(() => toggleRef.current?.focus()); }}><ConsoleSectionView state={state} command={(value) => { if ("add" in value) setPopupOpen(false); return command(value); }} popup /></ConsolePopup> : null}
  </nav>;
}
function ConsolePopup({ onClose, children }: { readonly onClose: () => void; readonly children: ReactNode }) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".console-shell");
    const previous = shell?.inert;
    if (shell) shell.inert = true;
    root.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { if (shell) shell.inert = previous ?? false; };
  }, []);
  return createPortal(<div className="console-section-popup-scrim" onPointerDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><div ref={root} role="dialog" aria-modal="true" aria-label={t("chrome.hosts.aria")} className="console-section-browser-popup" onKeyDown={(event) => {
    if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const entries = Array.from(root.current?.querySelectorAll<HTMLElement>("button, input") ?? []).filter((el) => !el.matches(":disabled") && el.getClientRects().length > 0);
    if (event.shiftKey && document.activeElement === entries[0]) { event.preventDefault(); entries.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === entries.at(-1)) { event.preventDefault(); entries[0]?.focus(); }
  }}><button type="button" className="console-section-popup-close" aria-label={t("common.close")} onClick={onClose}>×</button>{children}</div></div>, document.body);
}
function ConsoleGlyph({ remote = false }: { readonly remote?: boolean }) { return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M6 14h4M8 11v3" />{remote ? <path d="M5 7h6M8 4v6" /> : null}</svg>; }
function HomeGlyph() { return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="m2 7 6-5 6 5M4 6v8h8V6" /></svg>; }
function PlusGlyph() { return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>; }
function SlidersGlyph() { return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M2 5h6m4 0h2M2 11h2m4 0h6" /><circle cx="10" cy="5" r="2" /><circle cx="6" cy="11" r="2" /></svg>; }
