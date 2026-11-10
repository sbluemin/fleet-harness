import { ChevronGlyph } from "@fleet-console/ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CONSOLE_DIRECTORY_CAPABILITY, CONSOLE_ROSTER_CAPABILITY, CONSOLE_ROSTER_EVENT, CONSOLE_SECTION_EVENT, consoleSectionCommandUrl,
  isConsoleRosterState, isConsoleSectionState,
  type ConsoleRosterEntry, type ConsoleRosterState, type ConsoleSectionCommand, type ConsoleSectionEntry, type ConsoleSectionState,
} from "@fleet-console/protocol/desktop/console-section";
import { holdDesktopReady } from "../../../core/client/src/integration/desktop-ready.js";
import { isDesktopShell, useDesktopHomeOrigin } from "../../../core/client/src/integration/desktop-shell.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { useT } from "../../../core/client/src/i18n/index.js";
import { ConsoleGlyph } from "./console-section.js";
import { subscribeRemoteHostsChanged } from "./remote-hosts.js";
import "./console-sections.css";

/** 도착할 사령관을 모른 채 「다 그렸다」고 알리지 않도록 붙잡아 두는 상한. 넘기면 그냥 알린다. */
const ARRIVAL_HOLD_MS = 600;

export interface ConsoleSections {
  /** 셸이 콘솔 목록을 건네는가. 브라우저로 연 Console은 false다. */
  readonly capable: boolean;
  /** 콘솔이 둘 이상이라 섹션 머리글을 세우는가. */
  readonly sectioned: boolean;
  readonly entries: readonly ConsoleSectionEntry[];
  readonly active: ConsoleSectionEntry | null;
  /** 셸이 명부를 건네는가. 옛 셸이면 머리글만 선다. */
  readonly rosterCapable: boolean;
  readonly roster: (id: string) => ConsoleRosterEntry | null;
  readonly folded: (id: string) => boolean;
  readonly fold: (id: string, folded: boolean) => void;
  readonly arrival: ConsoleRosterState["arrival"];
  /** 도착한 사령관을 열었거나 열 수 없음을 알았다. */
  readonly arrived: () => void;
  readonly command: (value: ConsoleSectionCommand) => void;
}

/** 셸이 건넨 최소 상태만 쓴다. 다른 콘솔의 서버에는 이 문서가 직접 묻지 않는다. */
export function useConsoleSections(): ConsoleSections {
  const shell = useDesktopHomeOrigin();
  const { consoleName } = useConsoleState();
  const capable = isDesktopShell() && shell.capabilities.includes(CONSOLE_DIRECTORY_CAPABILITY);
  const rosterCapable = capable && shell.capabilities.includes(CONSOLE_ROSTER_CAPABILITY);
  const [state, setState] = useState<ConsoleSectionState | null>(null);
  const [rosters, setRosters] = useState<ConsoleRosterState | null>(null);
  const [localFolds, setLocalFolds] = useState<Readonly<Record<string, boolean>>>({});
  const release = useRef<(() => void) | null>(null);
  const command = useCallback((value: ConsoleSectionCommand) => { location.assign(consoleSectionCommandUrl(location.origin, value)); }, []);
  // 첫 목록이 서기 전에 붙잡아야 하므로 렌더 중에 한 번 건다. 셸이 아니면 붙잡지 않는다.
  if (release.current === null) release.current = isDesktopShell() ? holdDesktopReady(ARRIVAL_HOLD_MS) : () => {};
  useEffect(() => {
    if (!capable) { setState(null); return; }
    const update = (event: Event) => { const value: unknown = (event as CustomEvent).detail; if (isConsoleSectionState(value)) setState(value); };
    window.addEventListener(CONSOLE_SECTION_EVENT, update);
    // 이름·저장 목록이 바뀌어도 표시는 셸이 다시 준 상태만 쓴다.
    const reload = () => command({ request: "state" });
    const unsubscribe = subscribeRemoteHostsChanged(reload);
    window.addEventListener("focus", reload);
    reload();
    return () => { unsubscribe(); window.removeEventListener("focus", reload); window.removeEventListener(CONSOLE_SECTION_EVENT, update); };
  }, [capable, consoleName, command]);
  useEffect(() => {
    if (!rosterCapable) { setRosters(null); return; }
    const update = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail;
      if (!isConsoleRosterState(value)) return;
      setRosters(value);
      // 도착할 사령관이 없으면 더 붙잡을 이유가 없다. 있으면 사이드바가 연 뒤 arrived()가 놓는다.
      if (value.arrival === null) release.current?.();
    };
    window.addEventListener(CONSOLE_ROSTER_EVENT, update);
    return () => window.removeEventListener(CONSOLE_ROSTER_EVENT, update);
  }, [rosterCapable]);
  // 셸의 답이 왔는데 명부 능력이 없으면 도착도 없다.
  useEffect(() => { if (!shell.pending && !rosterCapable) release.current?.(); }, [shell.pending, rosterCapable]);
  useEffect(() => () => release.current?.(), []);
  const entries = state?.entries ?? [];
  const byId = useMemo(() => new Map((rosters?.rosters ?? []).map((entry) => [entry.id, entry])), [rosters]);
  const shellFolds = useMemo(() => new Set(rosters?.folded ?? []), [rosters]);
  const arrived = useCallback(() => {
    release.current?.();
    setRosters((current) => current && current.arrival ? { ...current, arrival: null } : current);
    if (rosterCapable) command({ arrived: true });
  }, [rosterCapable, command]);
  const fold = useCallback((id: string, folded: boolean) => {
    setLocalFolds((current) => ({ ...current, [id]: folded }));
    if (rosterCapable) command({ fold: { id, folded } });
  }, [rosterCapable, command]);
  return {
    capable, rosterCapable, entries, command, arrived, fold,
    sectioned: capable && entries.length > 1,
    active: entries.find((entry) => entry.active) ?? null,
    roster: (id) => byId.get(id) ?? null,
    folded: (id) => localFolds[id] ?? shellFolds.has(id),
    arrival: rosters?.arrival ?? null,
  };
}

/** 전환을 막는 상태 — 지금의 전환 메뉴와 같은 규칙이다. */
export function consoleSwitchBlocked(entry: ConsoleSectionEntry): boolean {
  return entry.active || entry.status === "unreachable" || entry.status === "untrusted" || entry.status === "stopping";
}

/** 콘솔 하나의 머리글. 누르면 그 섹션이 접힌다. 원격 콘솔은 이름을 바꾸거나 뺄 수 있다. */
export function ConsoleSectionHead({ entry, folded, count, sections }: {
  readonly entry: ConsoleSectionEntry; readonly folded: boolean; readonly count: number | null; readonly sections: ConsoleSections;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(entry.label);
  const status = entry.status === "unreachable" ? t("chrome.hosts.unreachable") : entry.status === "untrusted" ? t("chrome.hosts.untrusted")
    : entry.status === "stopping" ? t("chrome.hosts.stopping") : entry.status === "slow" ? t("chrome.hosts.slow") : null;
  const title = `${entry.label} · ${entry.address}${status ? ` · ${status}` : ""}`;
  if (editing) {
    return <div className="side-console-head is-editing" data-status={entry.status ?? undefined}>
      {confirming ? <div className="side-console-form">
        <p>{t("chrome.consoles.forgetWarning")}</p>
        <div><button type="button" autoFocus onClick={() => setConfirming(false)}>{t("common.cancel")}</button>
          <button type="button" className="is-danger" onClick={() => { sections.command({ forget: entry.id }); setEditing(false); setConfirming(false); }}>{t("settings.remote.hosts.forget")}</button></div>
      </div> : <form className="side-console-form" onSubmit={(event) => { event.preventDefault(); const next = name.trim(); if (!next) return; sections.command({ rename: { id: entry.id, label: next } }); setEditing(false); }}>
        <input autoFocus aria-label={t("settings.remote.hosts.rename")} value={name} maxLength={120} onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); setEditing(false); } }} />
        <div><button type="submit" disabled={!name.trim()}>{t("chrome.consoles.save")}</button><button type="button" onClick={() => setEditing(false)}>{t("common.cancel")}</button>
          {!entry.active ? <button type="button" className="is-danger" onClick={() => setConfirming(true)}>{t("settings.remote.hosts.forget")}</button> : null}</div>
      </form>}
    </div>;
  }
  return <div className={`side-console-head${entry.active ? " is-active" : ""}${folded ? " is-folded" : ""}`} data-status={entry.status ?? undefined}>
    <button type="button" className="side-console-toggle" aria-expanded={!folded} title={title} onClick={() => sections.fold(entry.id, !folded)}>
      <ConsoleGlyph remote={entry.kind === "remote"} />
      <span className="side-console-name"><b>{entry.label}</b>{entry.home ? null : <small>{entry.address}</small>}</span>
      {entry.home ? <span className="side-console-home" title={t("chrome.consoles.thisComputer")} aria-label={t("chrome.consoles.thisComputer")} role="img"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="m2 7 6-5 6 5M4 6v8h8V6" /></svg></span> : null}
      {entry.active ? <span className="side-console-here">{t("chrome.consoles.here")}</span> : null}
      {status ? <span className="side-console-status">{status}</span> : null}
      {folded && count !== null && count > 0 ? <span className="side-console-count">{count}</span> : null}
      <ChevronGlyph direction="down" className="side-console-chevron" />
    </button>
    {entry.kind === "remote" ? <button type="button" className="side-console-edit" aria-label={`${entry.label}: ${t("settings.remote.hosts.rename")}`} title={t("settings.remote.hosts.rename")}
      onClick={() => { setName(entry.label); setConfirming(false); setEditing(true); }}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="m3 11-.5 2.5L5 13l7-7-2-2-7 7Zm6-6 2 2" /></svg>
    </button> : null}
  </div>;
}

/** 목록 끝의 콘솔 추가 — 지금의 추가 창을 그대로 연다. */
export function ConsoleAddRow({ sections }: { readonly sections: ConsoleSections }) {
  const t = useT();
  return <li className="side-console-add-item">
    <button type="button" className="side-console-add" title={t("chrome.hosts.add")} onClick={() => sections.command({ add: true })}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
      <span>{t("chrome.hosts.add")}</span>
    </button>
  </li>;
}
