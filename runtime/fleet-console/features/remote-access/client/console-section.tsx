import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CONSOLE_SECTION_CONTEXT_EVENT, CONSOLE_SECTION_FOCUS_EVENT, CONSOLE_SECTION_REFRESH_EVENT, consoleSectionSignalUrl, type ConsoleSectionContext } from "@fleet-console/protocol/desktop/console-section";
import { desktopPickerUrl, isDesktopShell, PICKER_SURFACE_DISMISS, useDesktopHomeOrigin } from "../../../core/client/src/integration/desktop-shell.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { useT } from "../../../core/client/src/i18n/index.js";
import { hostDetail, hostStatus, isLoopbackOrigin, nearbyDetail } from "../../../core/client/src/chrome/components/command-band-system-cluster.js";
import { openSettingsSurface } from "../../settings/client/settings-door.js";
import { AddHostDialog } from "./add-host-dialog.js";
import { fetchLocalConsoles, forgetRemoteHost, probeRemoteHost, refreshRemoteHosts, renameRemoteHost, useRemoteHosts, type LocalConsole, type RemoteHostReach } from "./remote-hosts.js";

const EXPANDED_KEY = "fleet-console.console-section-expanded";
function readExpanded(): boolean { try { return localStorage.getItem(EXPANDED_KEY) !== "false"; } catch { return true; } }

/** 목록과 편집은 집 Console이 소유하며, Desktop은 이 문서의 자리만 정한다. */
export function ConsoleSection({ compact = false, resident = false, pickerAt, initialAdd = false, inlinePopup = false }: {
  readonly compact?: boolean; readonly resident?: boolean; readonly pickerAt?: string | null; readonly initialAdd?: boolean; readonly inlinePopup?: boolean;
}) {
  const t = useT();
  const shell = useDesktopHomeOrigin();
  const state = useConsoleState();
  const desktop = isDesktopShell();
  const hosts = useRemoteHosts();
  const home = shell.origin ?? ((resident || pickerAt !== undefined || !desktop) ? location.origin : null);
  const [context, setContext] = useState<ConsoleSectionContext>({ at: pickerAt ?? location.origin, compact, maxHeight: 400, theme: document.documentElement.dataset.theme ?? "dark" });
  const isCompact = resident ? context.compact : compact;
  const at = resident ? context.at : pickerAt ?? location.origin;
  const away = home !== null && at !== home;
  const canRead = isLoopbackOrigin(location.origin) && (resident || pickerAt !== undefined || !desktop || home === location.origin);
  const fallbackAway = !resident && pickerAt === undefined && desktop && home !== location.origin;
  const [expanded, setExpanded] = useState(() => pickerAt !== undefined || inlinePopup ? true : readExpanded());
  const [browserPopup, setBrowserPopup] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(initialAdd);
  const [local, setLocal] = useState<readonly LocalConsole[]>([]);
  const [reach, setReach] = useState<Readonly<Record<string, RemoteHostReach>>>({});
  const rootRef = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const manageRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const inPicker = pickerAt !== undefined;
  useEffect(() => {
    if (!inlinePopup || addOpen) return;
    const shellElement = document.querySelector<HTMLElement>(".console-shell");
    if (shellElement) shellElement.inert = true;
    return () => { if (shellElement) shellElement.inert = false; };
  }, [inlinePopup, addOpen]);

  useLayoutEffect(() => {
    if (!resident) return;
    const update = (event: Event) => {
      const next = (event as CustomEvent<ConsoleSectionContext>).detail;
      setContext(next);
      // 현재 Console의 테마로 표시하되 집에 저장된 테마는 바꾸지 않는다.
      document.documentElement.dataset.theme = next.theme;
    };
    const focus = (event: Event) => {
      const entries = focusable(rootRef.current);
      ((event as CustomEvent).detail === "last" ? entries.at(-1) : entries[0])?.focus();
    };
    const reload = () => setRefresh((value) => value + 1);
    document.title = t("chrome.consoles.document");
    window.addEventListener(CONSOLE_SECTION_CONTEXT_EVENT, update);
    window.addEventListener(CONSOLE_SECTION_FOCUS_EVENT, focus);
    window.addEventListener(CONSOLE_SECTION_REFRESH_EVENT, reload);
    return () => {
      window.removeEventListener(CONSOLE_SECTION_CONTEXT_EVENT, update);
      window.removeEventListener(CONSOLE_SECTION_FOCUS_EVENT, focus);
      window.removeEventListener(CONSOLE_SECTION_REFRESH_EVENT, reload);
    };
  }, [resident, t]);

  useEffect(() => {
    if (!canRead) return;
    const controller = new AbortController();
    void refreshRemoteHosts(controller.signal).then(() => { if (!controller.signal.aborted) setError(null); }).catch(() => { if (!controller.signal.aborted) setError(t("chrome.consoles.loadFailed")); });
    void fetchLocalConsoles(controller.signal).then(setLocal).catch(() => undefined);
    return () => controller.abort();
  }, [canRead, expanded, refresh, t]);
  useEffect(() => {
    if (!canRead || !expanded || !desktop) return;
    const controller = new AbortController();
    void fetchLocalConsoles(controller.signal).then(setLocal).catch(() => undefined);
    for (const host of hosts) void probeRemoteHost(host.id, controller.signal).then((result) => {
      if (!controller.signal.aborted) setReach((previous) => ({ ...previous, [host.id]: result }));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [canRead, desktop, expanded, hosts]);
  useLayoutEffect(() => {
    if (!resident || !rootRef.current) return;
    const root = rootRef.current;
    let last = -1;
    const report = () => {
      const height = Math.ceil(root.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      location.assign(consoleSectionSignalUrl(location.origin, { height }));
    };
    const observer = new ResizeObserver(report);
    observer.observe(root); report();
    return () => observer.disconnect();
  }, [resident]);

  const picker = (intent?: "add" | "manage", trigger: HTMLElement | null = toggleRef.current) => {
    if (!desktop) { setBrowserPopup(true); return; }
    if (!home) return;
    // 상주 문서의 원점은 사이드바 안이다. 덮개는 창 전체이므로 셸이 준 기준으로 좌표를 옮긴다.
    const frame = resident ? context.frame : undefined;
    const width = Math.round(frame?.width ?? innerWidth);
    const height = Math.round(frame?.height ?? innerHeight);
    const rect = trigger?.getBoundingClientRect();
    const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(value)));
    const anchor = rect ? [clamp(rect.left + (frame?.x ?? 0), width), clamp(rect.top + (frame?.y ?? 0), height), clamp(rect.right + (frame?.x ?? 0), width), clamp(rect.bottom + (frame?.y ?? 0), height), width, height].join(",") : undefined;
    const url = new URL(desktopPickerUrl(home, undefined, at, anchor, isCompact));
    if (intent) url.searchParams.set("intent", intent);
    location.assign(url.toString());
  };
  const toggle = (trigger: HTMLElement | null = toggleRef.current) => {
    if (fallbackAway || isCompact) { picker(undefined, trigger); return; }
    const next = !expanded;
    setExpanded(next);
    if (!next) setEditing(false);
    try { localStorage.setItem(EXPANDED_KEY, String(next)); } catch { /* 저장할 수 없어도 펼침 동작은 유지한다. */ }
  };
  const go = (origin: string) => { if (origin !== at) location.assign(new URL("/console/", origin).toString()); };
  const mutate = async (run: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await run(); setRenaming(null); setConfirming(null); }
    catch { setError(t("chrome.consoles.editFailed")); }
    finally { setBusy(false); }
  };
  const add = () => { if (resident || fallbackAway) picker("add", addRef.current); else setAddOpen(true); };
  const manage = () => {
    if (fallbackAway) { picker("manage", manageRef.current); return; }
    setEditing((value) => !value); setExpanded(true); setRenaming(null); setConfirming(null);
  };
  useEffect(() => {
    if (inPicker && new URLSearchParams(location.search).get("intent") === "manage") { setEditing(true); setExpanded(true); }
  }, [inPicker]);
  useEffect(() => {
    if (!inPicker) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || addOpen || renaming) return;
      event.preventDefault(); location.assign(desktopPickerUrl(location.origin, PICKER_SURFACE_DISMISS));
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [inPicker, addOpen, renaming]);

  // 덮개에서 추가할 때는 목록을 다시 그리지 않는다. 취소·성공 모두 덮개를 걷어 집 뷰의 재조회를 실행한다.
  if (inPicker && addOpen) return <AddHostDialog onClose={() => location.assign(desktopPickerUrl(location.origin, PICKER_SURFACE_DISMISS))} />;

  const current = hosts.find((host) => host.origin === at);
  const currentName = current?.label || (at === location.origin ? state.consoleName : "") || new URL(at).host;
  const homeRow = home ?? location.origin;
  const nearby = canRead ? [
    local.find((entry) => entry.origin === homeRow) ?? { origin: homeRow, version: "", owner: null, distro: null, state: "ready" as const },
    ...local.filter((entry) => entry.origin !== homeRow),
  ] : [];
  const row = (origin: string, label: string, detail: string, status?: { label: string; tone?: "coral" | "warn" }, blocked = false, remote = false): ReactNode => <div className="console-section-row-wrap">
    <button type="button" className={`console-section-row${origin === at ? " is-current" : ""}`} aria-current={origin === at ? "location" : undefined}
      aria-disabled={blocked || origin === at} title={`${label} · ${detail}`} onClick={() => { if (!blocked) go(origin); }}>
      <ConsoleGlyph remote={remote} /><span className="console-section-name">{label}</span><span className="console-section-address">{detail}</span>
      {status ? <span className={`console-section-status${status.tone ? ` is-${status.tone}` : ""}`}>{status.label}</span> : origin === at ? <span aria-hidden="true">✓</span> : null}
    </button>
    {origin === at && away ? <button type="button" className="console-section-action" title={t("chrome.consoles.home")} aria-label={t("chrome.consoles.home")} onClick={() => go(homeRow)}><HomeGlyph /></button> : null}
  </div>;

  return <nav ref={rootRef} className={`console-section${isCompact ? " is-compact" : ""}${inPicker ? " is-picker" : ""}`} aria-label={t("chrome.consoles.document")}
    style={resident ? { "--console-section-max-height": `${context.maxHeight}px` } as CSSProperties : undefined}
    onKeyDown={(event) => {
      if (!resident || event.key !== "Tab") return;
      const entries = focusable(rootRef.current);
      if ((!event.shiftKey && document.activeElement === entries.at(-1)) || (event.shiftKey && document.activeElement === entries[0])) {
        event.preventDefault(); location.assign(consoleSectionSignalUrl(location.origin, { focus: event.shiftKey ? "before" : "after" }));
      }
    }}>
    {isCompact ? <button ref={toggleRef} type="button" className="console-section-compact" aria-label={`${t("chrome.hosts.aria")}: ${currentName}`} title={`${t("chrome.hosts.aria")}: ${currentName}`} onClick={() => picker()}><ConsoleGlyph remote={away} /></button> : <>
      <header className="console-section-header">
        <button ref={toggleRef} type="button" className="console-section-toggle" aria-expanded={expanded && !fallbackAway} aria-controls={listId} onClick={(event) => toggle(event.currentTarget)}><span className={expanded ? "" : "is-folded"} aria-hidden="true">⌄</span>{t("chrome.hosts.heading")}</button>
        <button ref={addRef} type="button" className="console-section-action console-section-glyph" title={t("chrome.hosts.add")} aria-label={t("chrome.hosts.add")} onClick={add}><PlusGlyph /></button>
        <button ref={manageRef} type="button" className="console-section-action console-section-glyph" aria-pressed={editing} title={t("chrome.hosts.manage")} aria-label={t("chrome.hosts.manage")} onClick={manage}><SlidersGlyph /></button>
      </header>
      {expanded && !fallbackAway ? <div id={listId} className="console-section-list">
        <p className="console-section-group">{t("chrome.hosts.nearby")}</p>
        {nearby.map((entry) => <div key={entry.origin}>{row(entry.origin, entry.origin === location.origin ? state.consoleName || t("chrome.hosts.managedConsole") : t("chrome.hosts.console"), nearbyDetail(entry, entry.origin === homeRow), entry.state === "ready" || entry.origin === at ? undefined : { label: t(entry.state === "stopping" ? "chrome.hosts.stopping" : "chrome.hosts.slow") }, entry.state === "stopping")}</div>)}
        <p className="console-section-group">{t("chrome.hosts.saved")}</p>
        {!desktop ? <p className="console-section-hint">{t("chrome.consoles.desktopHint")}</p> : canRead ? hosts.map((host) => <div key={host.id}>
          {renaming === host.id ? <form className="console-section-rename" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void mutate(() => renameRemoteHost(host.id, name.trim())); }}>
            <input autoFocus value={name} aria-label={t("settings.remote.hosts.rename")} maxLength={120} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); setRenaming(null); } }} />
            <button type="submit" disabled={busy || !name.trim()}>{t("chrome.consoles.save")}</button><button type="button" onClick={() => setRenaming(null)}>{t("common.cancel")}</button>
          </form> : <div className="console-section-edit-row">
            {row(host.origin, host.label, hostDetail(host, reach[host.id], t), hostStatus(reach[host.id], t), reach[host.id]?.reachable === false || reach[host.id]?.trusted === false, true)}
            {editing ? <><button type="button" className="console-section-action" aria-label={`${host.label}: ${t("settings.remote.hosts.rename")}`} title={t("settings.remote.hosts.rename")} onClick={() => { setRenaming(host.id); setName(host.label); setConfirming(null); }}>✎</button>
              <button type="button" className="console-section-action" aria-label={`${host.label}: ${t("settings.remote.hosts.forget")}`} title={t("settings.remote.hosts.forget")} onClick={() => { setConfirming(host.id); setRenaming(null); }}>−</button></> : null}
          </div>}
          {confirming === host.id ? <div className="console-section-confirm"><p>{t("chrome.consoles.forgetWarning")}</p><button type="button" onClick={() => setConfirming(null)} disabled={busy}>{t("common.cancel")}</button><button type="button" className="is-danger" disabled={busy} onClick={() => void mutate(() => forgetRemoteHost(host.id))}>{t("settings.remote.hosts.forget")}</button></div> : null}
        </div>) : null}
        {desktop && canRead && hosts.length === 0 ? <p className="console-section-hint">{t("chrome.consoles.empty")}</p> : null}
        {away && !nearby.some((entry) => entry.origin === at) && !current ? row(at, currentName, new URL(at).host, { label: t("chrome.hosts.notSaved") }) : null}
        {editing ? <button type="button" className="console-section-settings" onClick={() => {
          if (resident || inPicker || inlinePopup) location.assign(new URL("/console/settings?section=remote-access", location.origin).toString());
          else openSettingsSurface("connectivity");
        }}>{t("chrome.consoles.allowAccess")}</button> : null}
      </div> : <div className="console-section-row-wrap"><button type="button" className="console-section-row is-current" aria-expanded={false} onClick={(event) => toggle(event.currentTarget)}><ConsoleGlyph remote={away} /><span className="console-section-name">{currentName}</span><span className="console-section-address">{away ? t("chrome.consoles.remote") : t("chrome.hosts.nearby")}</span></button>{away ? <button type="button" className="console-section-action" aria-label={t("chrome.consoles.home")} title={t("chrome.consoles.home")} onClick={() => go(homeRow)}><HomeGlyph /></button> : null}</div>}
    </>}
    {error ? <p role="alert" className="console-section-error">{error}</p> : null}
    {addOpen ? <AddHostDialog openerRef={addRef} onClose={() => setAddOpen(false)} /> : null}
    {browserPopup ? <BrowserConsolePopup onClose={() => { setBrowserPopup(false); requestAnimationFrame(() => toggleRef.current?.focus()); }} /> : null}
  </nav>;
}

function BrowserConsolePopup({ onClose }: { readonly onClose: () => void }) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  return createPortal(<div className="console-section-popup-scrim" onPointerDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <div ref={root} role="dialog" aria-modal="true" aria-label={t("chrome.hosts.aria")} className="console-section-browser-popup" onKeyDown={(event) => {
      if (document.querySelector(".add-host-card")) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const entries = focusable(root.current);
      if (event.shiftKey && document.activeElement === entries[0]) { event.preventDefault(); entries.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === entries.at(-1)) { event.preventDefault(); entries[0]?.focus(); }
    }}><button type="button" className="console-section-popup-close" aria-label={t("common.close")} onClick={onClose}>×</button><ConsoleSection inlinePopup /></div>
  </div>, document.body);
}

function focusable(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>('button, input, a[href]') ?? []).filter((el) => !el.matches(":disabled") && el.getClientRects().length > 0);
}
function ConsoleGlyph({ remote = false }: { readonly remote?: boolean }) { return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M6 14h4M8 11v3" />{remote ? <path d="M5 7h6M8 4v6" /> : null}</svg>; }
function HomeGlyph() { return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="m2 7 6-5 6 5M4 6v8h8V6" /></svg>; }
function PlusGlyph() { return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>; }
function SlidersGlyph() { return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M2 5h6m4 0h2M2 11h2m4 0h6" /><circle cx="10" cy="5" r="2" /><circle cx="6" cy="11" r="2" /></svg>; }
