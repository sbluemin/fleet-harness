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
import { consoleLifecycleKey } from "./manage-console-card.js";
import { subscribeRemoteHostsChanged } from "./remote-hosts.js";
import "./console-sections.css";

/**
 * 셸은 문서가 적재되자마자 상태를 건넨다 — 사이드바가 서기 전일 수 있다. 그래서 묶음이 평가되는 순간부터 듣고
 * 마지막 값을 쥐고 있는다. 셸이 능력을 게시하는 조회는 첫 화면 뒤로 미뤄져 있으므로, 받은 상태 자체를 능력의 증거로 쓴다.
 */
/** 보이는 동안 명부를 다시 묻는 간격. 셸이 콘솔마다 읽기를 솎으므로 여기서는 물음만 띄운다. */
const ROSTER_REFRESH_MS = 30_000;
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
    // 창이 계속 앞에 있으면 포커스가 다시 오지 않는다 — 다른 콘솔의 명부가 굳지 않게, 보이는 동안에는 주기적으로 다시 묻는다.
    const timer = rosterCapable ? setInterval(() => { if (document.visibilityState === "visible") reload(); }, ROSTER_REFRESH_MS) : undefined;
    reload();
    return () => { unsubscribe(); window.removeEventListener("focus", reload); clearInterval(timer); };
  }, [capable, rosterCapable, consoleName, command]);
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
    // 콘솔이 하나뿐이어도 관리 대상이 꺼져 있거나 시작·종료 중이면 머리글을 세운다 — 그 사실과 시작 단추가 설 자리가 머리글뿐이다.
    sectioned: capable && (entries.length > 1 || entries.some((entry) => consoleLifecycleKey(entry) !== null)),
    active: entries.find((entry) => entry.active) ?? null,
    roster: (id) => byId.get(id) ?? null,
    folded: (id) => localFolds[id] ?? shellFolds.has(id),
  };
}

/** 전환을 막는 상태 — 지금의 전환 메뉴와 같은 규칙이다. */
export function consoleSwitchBlocked(entry: ConsoleSectionEntry): boolean {
  return entry.active || entry.status === "unreachable" || entry.status === "untrusted" || entry.status === "stopping";
}

/**
 * 콘솔 하나의 머리글. 누르면 그 섹션이 접힌다. 원격 콘솔은 이름을 바꾸거나 뺄 수 있다.
 * 좁은 열에는 글리프만 남고 접힘도 쓰지 않으므로, 거기서는 누르면 그 콘솔로 전환한다 — 사령관 행이 없는 콘솔로 가는 길이 이것뿐이다.
 */
export function ConsoleSectionHead({ entry, folded, count, sections, compact = false }: {
  readonly entry: ConsoleSectionEntry; readonly folded: boolean; readonly count: number | null; readonly sections: ConsoleSections; readonly compact?: boolean;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entry.label);
  // 관리 대상의 생명주기가 연결 상태보다 먼저다 — 꺼진 콘솔은 "연결 불가"가 아니라 "중지됨"이다.
  const lifecycle = consoleLifecycleKey(entry);
  const status = lifecycle ? t(lifecycle) : entry.status === "unreachable" ? t("chrome.hosts.unreachable") : entry.status === "untrusted" ? t("chrome.hosts.untrusted")
    : entry.status === "stopping" ? t("chrome.hosts.stopping") : entry.status === "slow" ? t("chrome.hosts.slow") : null;
  // 관리 화면은 집 Console이 그린다. 이 Desktop이 관계를 실어 보낸 이 컴퓨터의 콘솔에만, 그 콘솔이 답하는 동안에만 문을 둔다.
  const manageable = !compact && entry.management !== undefined && entry.path !== "remote" && entry.status !== "unreachable";
  const startable = !compact && entry.actions?.includes("start") === true;
  const switchable = compact && !consoleSwitchBlocked(entry);
  const title = `${entry.label} · ${entry.address}${status ? ` · ${status}` : ""}${switchable ? ` · ${t("chrome.consoles.switchHere")}` : ""}`;
  const press = compact ? () => { if (switchable) sections.command({ switch: entry.id }); } : () => sections.fold(entry.id, !folded);
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
  return <div className={`side-console-head${entry.active ? " is-active" : ""}${folded ? " is-folded" : ""}`} data-status={entry.status ?? undefined} data-lifecycle={lifecycle ? entry.lifecycle ?? undefined : undefined}>
    <button type="button" className="side-console-toggle" aria-expanded={compact ? undefined : !folded} title={title} onClick={press}>
      <ConsoleGlyph remote={entry.kind === "remote"} />
      <span className="side-console-name"><b>{entry.label}</b>{entry.home || entry.address === entry.label ? null : <small>{entry.address}</small>}</span>
      {entry.home ? <span className="side-console-home" title={t("chrome.consoles.thisComputer")} aria-label={t("chrome.consoles.thisComputer")} role="img"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="m2 7 6-5 6 5M4 6v8h8V6" /></svg></span> : null}
      {entry.active ? <span className="side-console-here">{t("chrome.consoles.here")}</span> : null}
      {status ? <span className="side-console-status">{status}</span> : null}
      {folded && count !== null && count > 0 ? <span className="side-console-count">{count}</span> : null}
      <ChevronGlyph direction="down" className="side-console-chevron" />
    </button>
    {startable ? <button type="button" className="side-console-start" onClick={() => sections.command({ lifecycle: { id: entry.id, action: "start" } })}>{t("chrome.consoles.start")}</button> : null}
    {manageable ? <button type="button" className="side-console-edit" aria-label={`${entry.label}: ${t("chrome.consoles.manage")}`} title={t("chrome.consoles.manage")}
      onClick={() => sections.command({ manage: entry.id })}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" /></svg>
    </button> : null}
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
