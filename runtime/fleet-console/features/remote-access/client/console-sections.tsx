import { ChevronGlyph } from "@fleet-console/ui/react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  CONSOLE_DIRECTORY_CAPABILITY, CONSOLE_ROSTER_CAPABILITY, CONSOLE_ROSTER_EVENT, CONSOLE_SECTION_EVENT, consoleSectionCommandUrl,
  isConsoleRosterState, isConsoleSectionState,
  type ConsoleRosterEntry, type ConsoleRosterState, type ConsoleSectionCommand, type ConsoleSectionEntry, type ConsoleSectionState,
} from "@fleet-console/protocol/desktop/console-section";
import { isDesktopShell, useDesktopHomeOrigin } from "../../../core/client/src/integration/desktop-shell.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { useT } from "../../../core/client/src/i18n/index.js";
import { ConsoleGlyph } from "./console-section.js";
import { subscribeRemoteHostsChanged } from "./remote-hosts.js";
import "./console-sections.css";

/**
 * 셸은 문서가 적재되자마자 상태를 건넨다 — 사이드바가 서기 전일 수 있다. 그래서 묶음이 평가되는 순간부터 듣고
 * 마지막 값을 쥐고 있는다. 셸이 능력을 게시하는 조회는 첫 화면 뒤로 미뤄져 있으므로, 받은 상태 자체를 능력의 증거로 쓴다.
 */
let sectionState: ConsoleSectionState | null = null;
let rosterState: ConsoleRosterState | null = null;
const stateListeners = new Set<() => void>();
const emitState = (): void => { for (const listener of stateListeners) listener(); };
const subscribeState = (listener: () => void): (() => void) => { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; };
if (typeof window !== "undefined") {
  window.addEventListener(CONSOLE_SECTION_EVENT, (event) => { const value: unknown = (event as CustomEvent).detail; if (isConsoleSectionState(value)) { sectionState = value; emitState(); } });
  window.addEventListener(CONSOLE_ROSTER_EVENT, (event) => { const value: unknown = (event as CustomEvent).detail; if (isConsoleRosterState(value)) { rosterState = value; emitState(); } });
}

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
  const desktop = isDesktopShell();
  const state = useSyncExternalStore(subscribeState, () => sectionState, () => null);
  const rosters = useSyncExternalStore(subscribeState, () => rosterState, () => null);
  const capable = desktop && (state !== null || shell.capabilities.includes(CONSOLE_DIRECTORY_CAPABILITY));
  const rosterCapable = capable && (rosters !== null || shell.capabilities.includes(CONSOLE_ROSTER_CAPABILITY));
  const [localFolds, setLocalFolds] = useState<Readonly<Record<string, boolean>>>({});
  const [arrivalDone, setArrivalDone] = useState<string | null>(null);
  const command = useCallback((value: ConsoleSectionCommand) => { location.assign(consoleSectionCommandUrl(location.origin, value)); }, []);
  useEffect(() => {
    if (!capable) return;
    // 이름·저장 목록이 바뀌어도 표시는 셸이 다시 준 상태만 쓴다.
    const reload = () => command({ request: "state" });
    const unsubscribe = subscribeRemoteHostsChanged(reload);
    window.addEventListener("focus", reload);
    reload();
    return () => { unsubscribe(); window.removeEventListener("focus", reload); };
  }, [capable, consoleName, command]);
  const entries = capable ? state?.entries ?? [] : [];
  const byId = useMemo(() => new Map((rosters?.rosters ?? []).map((entry) => [entry.id, entry])), [rosters]);
  const shellFolds = useMemo(() => new Set(rosters?.folded ?? []), [rosters]);
  // 명부 이벤트마다 새 객체가 오므로, 같은 도착은 같은 값으로 돌려준다 — 받는 쪽 효과가 한 번만 돈다.
  const arrivalCommodore = rosters?.arrival?.commodore ?? null;
  const arrivalAnchor = rosters?.arrival?.anchorY ?? null;
  const arrival = useMemo(() => arrivalCommodore === null || arrivalCommodore === arrivalDone ? null : { commodore: arrivalCommodore, anchorY: arrivalAnchor }, [arrivalCommodore, arrivalAnchor, arrivalDone]);
  const arrived = useCallback(() => {
    // 셸이 도착을 지운 상태를 다시 줄 때까지 같은 도착을 두 번 열지 않는다.
    setArrivalDone(arrivalCommodore);
    if (rosterCapable) command({ arrived: true });
  }, [rosterCapable, command, arrivalCommodore]);
  const fold = useCallback((id: string, folded: boolean) => {
    setLocalFolds((current) => ({ ...current, [id]: folded }));
    if (rosterCapable) command({ fold: { id, folded } });
  }, [rosterCapable, command]);
  return {
    capable, rosterCapable, entries, command, arrived, fold, arrival,
    sectioned: capable && entries.length > 1,
    active: entries.find((entry) => entry.active) ?? null,
    roster: (id) => byId.get(id) ?? null,
    folded: (id) => localFolds[id] ?? shellFolds.has(id),
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
  const [name, setName] = useState(entry.label);
  const status = entry.status === "unreachable" ? t("chrome.hosts.unreachable") : entry.status === "untrusted" ? t("chrome.hosts.untrusted")
    : entry.status === "stopping" ? t("chrome.hosts.stopping") : entry.status === "slow" ? t("chrome.hosts.slow") : null;
  const title = `${entry.label} · ${entry.address}${status ? ` · ${status}` : ""}`;
  if (editing) {
    return <div className="side-console-head is-editing" data-status={entry.status ?? undefined}>
      <form className="side-console-form" onSubmit={(event) => { event.preventDefault(); const next = name.trim(); if (!next) return; sections.command({ rename: { id: entry.id, label: next } }); setEditing(false); }}>
        <input autoFocus aria-label={t("settings.remote.hosts.rename")} value={name} maxLength={120} onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); setEditing(false); } }} />
        <div><button type="submit" disabled={!name.trim()}>{t("chrome.consoles.save")}</button><button type="button" onClick={() => setEditing(false)}>{t("common.cancel")}</button>
          {/* 빼기 전의 확인은 셸이 자기 대화상자로 묻는다 — 여기서 한 번 더 묻지 않는다. */}
          {!entry.active ? <button type="button" className="is-danger" onClick={() => { sections.command({ forget: entry.id }); setEditing(false); }}>{t("settings.remote.hosts.forget")}</button> : null}</div>
      </form>
    </div>;
  }
  return <div className={`side-console-head${entry.active ? " is-active" : ""}${folded ? " is-folded" : ""}`} data-status={entry.status ?? undefined}>
    <button type="button" className="side-console-toggle" aria-expanded={!folded} title={title} onClick={() => sections.fold(entry.id, !folded)}>
      <ConsoleGlyph remote={entry.kind === "remote"} />
      <span className="side-console-name"><b>{entry.label}</b>{entry.home || entry.address === entry.label ? null : <small>{entry.address}</small>}</span>
      {entry.home ? <span className="side-console-home" title={t("chrome.consoles.thisComputer")} aria-label={t("chrome.consoles.thisComputer")} role="img"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="m2 7 6-5 6 5M4 6v8h8V6" /></svg></span> : null}
      {entry.active ? <span className="side-console-here">{t("chrome.consoles.here")}</span> : null}
      {status ? <span className="side-console-status">{status}</span> : null}
      {folded && count !== null && count > 0 ? <span className="side-console-count">{count}</span> : null}
      <ChevronGlyph direction="down" className="side-console-chevron" />
    </button>
    {entry.kind === "remote" ? <button type="button" className="side-console-edit" aria-label={`${entry.label}: ${t("settings.remote.hosts.rename")}`} title={t("settings.remote.hosts.rename")}
      onClick={() => { setName(entry.label); setEditing(true); }}>
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
