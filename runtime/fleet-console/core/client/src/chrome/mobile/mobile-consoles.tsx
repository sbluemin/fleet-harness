import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import type { ConsoleRosterCommander, ConsoleRosterCommodore, ConsoleRosterRun } from "@fleet-console/protocol/desktop/console-section";

import { commodoreListLoaded, selectMobileCommodore, useCommodoreList } from "../../../../../features/commodore/client/commodore-list.js";
import type { ConsoleCommodoreSummary } from "../../../../../features/commodore/shared/contracts/theaters.js";
import { MongleAvatar } from "../../../../../features/workspace/client/components/mongle-avatar.js";
import { commodoreAvatarKey, fallbackMongleBase, type MongleState } from "../../../../../features/workspace/shared/avatars.js";
import { isIdentityTone } from "../../../../../features/workspace/shared/identity-tones.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { useT } from "../../i18n/index.js";
import { openConsoleSwitcher } from "../../integration/mobile-appearance-store.js";
import {
  forgetMobileHomeScrollTop,
  peekMobileConsoleArrival,
  mobileConsolesSeamless,
  mobileSwitchKey,
  peekMobileHomeScrollTop,
  requestMobileConsoleRoster,
  switchMobileConsole,
  takeMobileConsoleArrival,
  useMobileConsoles,
  type MobileConsoleEntry,
} from "../../integration/mobile-consoles-store.js";
import { focusObjective } from "../../integration/store.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { setMobileDestination, setMobileListTheater, setMobileReturnDestination } from "./mobile-store.js";

/*
 * 심리스 콘솔 홈(브리지 v1.6, 계약 6절) — 홈 사령관 목록을 콘솔별 머리글 섹션으로 그린다. 순서는 셸이 준
 * `consoles` 순서이고, 활성 콘솔 자리에는 지금의 홈 목록(사용자 섹션·태스크포스 포함)이 그대로 들어간다.
 * 다른 콘솔은 셸이 읽어 준 최소 명부만 그리며, 누르면 셸에 전환을 부탁한다. 능력이 없거나 콘솔이 하나뿐이면
 * 지금 홈 그대로다(머리글 없음).
 */

export const MOBILE_ROSTER_POLL_MS = 30_000;
const FOLDED_KEY = "fleet-console.mobile-console-folded";
const CHIP_LIMIT = 3;

/** 홈 사령관 열기 — 홈 행·도착이 같은 길을 쓴다. */
export function openMobileHomeCommodore(commodore: ConsoleCommodoreSummary): void {
  setMobileReturnDestination(null);
  selectMobileCommodore(commodore.commodoreId);
  // 바로가기의 범위는 마지막으로 연 사령관의 Theater 목록 첫 줄이다 — 옛 사령관 고르기 시트와 같은 규칙.
  const home = commodore.theaters.find((theater) => theater.status === "available")?.theaterId ?? null;
  if (home) setMobileListTheater({ commodoreId: commodore.commodoreId, theaterId: home });
  setMobileDestination({ kind: "plugin", entryId: "commodore", params: { commodoreId: commodore.commodoreId } });
}

/**
 * 도착 처리(계약 6절·r1) — 문서 적재 때 실려 온 도착을 그 문서에서 한 번 적용한다. 사령관 목록과 목표 기록이
 * 선 뒤에(숨김 단계 로드 중이어도) 사령관을 열고, commander가 있고 그 목표가 있으면 그 목표를 연다.
 * 없는 사령관이면 홈에 머문다. 어느 쪽이든 `arrived`를 보낸다(선택적 메시지).
 */
export function useMobileConsoleArrival(): void {
  const commodores = useCommodoreList();
  const state = useConsoleState();
  const ready = state.bootstrapped && commodoreListLoaded();
  useEffect(() => {
    const pending = peekMobileConsoleArrival();
    if (!ready || !pending) return;
    // 목표 기록은 사령관 목록과 따로 적재된다(bootstrapped가 그것을 보장하지 않는다) — commander가 있으면 기록이 선 뒤에 꺼낸다.
    if (pending.commander && !state.objectiveRecordsHydrated) return;
    const arrival = takeMobileConsoleArrival();
    if (!arrival) return;
    const commodore = commodores.find((row) => row.commodoreId === arrival.commodore);
    if (!commodore) return;
    const objective = arrival.commander ? state.objectiveRecords.find((record) => record.id === arrival.commander && record.commodoreId === commodore.commodoreId) : undefined;
    if (objective) {
      setMobileReturnDestination(null);
      selectMobileCommodore(commodore.commodoreId);
      setMobileDestination({ kind: "home" });
      focusObjective(objective.id);
      return;
    }
    openMobileHomeCommodore(commodore);
  }, [ready, commodores, state.objectiveRecords, state.objectiveRecordsHydrated]);
}

/**
 * 홈 목록 위치 복원 — 도착이 남긴 scrollTop을 페인트 전에 맞춘다. 목록이 아직 짧으면(사령관 목록 전) 다음
 * 그림에서 다시 맞추고, 목록이 선 뒤 한 번 맞추면 잊는다.
 */
export function useMobileHomeScrollRestore(scrollRef: RefObject<HTMLElement | null>): void {
  const consoles = useMobileConsoles();
  useLayoutEffect(() => {
    const target = peekMobileHomeScrollTop();
    const element = scrollRef.current;
    if (target === null || !element) return;
    element.scrollTop = target;
    const reachable = element.scrollHeight - element.clientHeight >= target;
    if (reachable || (commodoreListLoaded() && consoles.state !== null)) forgetMobileHomeScrollTop();
  });
}

/** 홈이 보이는 동안 — 처음 한 번, 그 뒤 30s마다(문서가 보일 때만) 다른 콘솔 명부를 새로 읽어 달라고 한다. */
export function useMobileRosterPoll(): void {
  const { capable } = useMobileConsoles();
  useEffect(() => {
    if (!capable) return;
    const ask = () => { if (typeof document === "undefined" || document.visibilityState !== "hidden") requestMobileConsoleRoster(); };
    ask();
    const timer = setInterval(ask, MOBILE_ROSTER_POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") ask(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [capable]);
}

function readFolded(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(FOLDED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 64) : []);
  } catch {
    return new Set();
  }
}

function writeFolded(folded: ReadonlySet<string>): void {
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded])); } catch { /* 저장이 막힌 환경에서는 이 화면에서만 접힌다. */ }
}

/** 머리글 접기 — 이 기기 로컬 저장(계약 6절). */
function useFoldedConsoles(): readonly [ReadonlySet<string>, (id: string) => void] {
  const [folded, setFolded] = useState(readFolded);
  const toggle = (id: string) => setFolded((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    writeFolded(next);
    return next;
  });
  return [folded, toggle];
}

/**
 * 홈 사령관 목록 자리. 심리스가 아니면 `local`을 그대로 돌려준다(현행 화면). 심리스면 셸 순서대로 콘솔 머리글
 * 섹션을 세우고, 활성 콘솔 섹션 안에 `local`을 넣는다.
 */
export function MobileConsoleHomeList({ local, scrollRef }: { readonly local: ReactNode; readonly scrollRef: RefObject<HTMLElement | null> }) {
  const consoles = useMobileConsoles();
  const [folded, toggle] = useFoldedConsoles();
  if (!mobileConsolesSeamless(consoles)) return <>{local}</>;
  return <>{consoles.state.consoles.map((entry) => entry.active
    ? <section key={entry.id} className="mobile-console-group is-active" data-console-id={entry.id} aria-label={entry.label}>
        <MobileConsoleHead entry={entry} folded={folded.has(entry.id)} onToggle={() => toggle(entry.id)} />
        {folded.has(entry.id) ? null : local}
      </section>
    : <MobileRemoteConsole key={entry.id} entry={entry} folded={folded.has(entry.id)} onToggle={() => toggle(entry.id)}
        switching={consoles.switching} scrollRef={scrollRef} />)}</>;
}

/** 이 콘솔(능력이 있고 둘 이상)일 때 다른 콘솔 섹션이 있는가 — 이 콘솔에 사령관이 없어도 홈을 세운다. */
export function useMobileConsolesSeamless(): boolean {
  return mobileConsolesSeamless(useMobileConsoles());
}

function statusText(entry: MobileConsoleEntry, t: ReturnType<typeof useT>): string | null {
  if (entry.active) return t("mobile.consoles.current");
  if (entry.status === "unavailable") return t("mobile.consoles.unavailable");
  if (entry.status === "unpaired") return t("mobile.consoles.unpaired");
  if (entry.status === "unsupported") return t("mobile.consoles.unsupported");
  return null;
}

function MobileConsoleHead({ entry, folded, onToggle, count }: {
  readonly entry: MobileConsoleEntry; readonly folded: boolean; readonly onToggle: () => void; readonly count?: number;
}) {
  const t = useT();
  const status = statusText(entry, t);
  // r5 — 명부를 볼 수 없는 콘솔(구 콘솔·명부 401/403)은 접을 것이 없다. 머리글을 누르면 네이티브 콘솔 시트를 연다(전환 메시지 아님).
  if (entry.status === "unsupported") {
    return (
      <h2 className="mobile-console-head">
        <button type="button" data-press="r1" className="mobile-console-toggle" data-opens="consoles" onClick={() => { openConsoleSwitcher(); }}>
          <MobileMonogram label={entry.label} toneKey={entry.label} tone={entry.tone} letters={entry.monogram ?? entry.label.charAt(0).toUpperCase()} round size={22} />
          <span className="mobile-console-name">{entry.label}</span>
          {status ? <span className="mobile-console-status" data-status="unsupported">{status}</span> : null}
          <span className="mobile-conv-gap" />
          <MobileIcon name="right" size={14} />
        </button>
      </h2>
    );
  }
  return (
    <h2 className="mobile-console-head">
      <button type="button" data-press="r1" className="mobile-console-toggle" aria-expanded={!folded} onClick={onToggle}>
        <MobileMonogram label={entry.label} toneKey={entry.label} tone={entry.tone} letters={entry.monogram ?? entry.label.charAt(0).toUpperCase()} round size={22} />
        <span className="mobile-console-name">{entry.label}</span>
        {status ? <span className="mobile-console-status" data-status={entry.active ? "active" : entry.status ?? undefined}>{status}</span> : null}
        {folded && count !== undefined && count > 0 ? <span className="mobile-console-count">{count}</span> : null}
        <span className="mobile-conv-gap" />
        <MobileIcon name={folded ? "right" : "down"} size={14} />
      </button>
    </h2>
  );
}

function rosterMongleState(run: ConsoleRosterRun): MongleState {
  return run === "working" ? "running" : run === "waiting" ? "awaiting" : "idle";
}

function chipTone(run: ConsoleRosterRun): "awaiting" | "running" | "idle" {
  return run === "working" ? "running" : run === "waiting" ? "awaiting" : "idle";
}

/** 다른 콘솔 하나 — 머리글, 상태 안내, 그 명부의 섹션·사령관 행. */
function MobileRemoteConsole({ entry, folded, onToggle, switching, scrollRef }: {
  readonly entry: MobileConsoleEntry;
  readonly folded: boolean;
  readonly onToggle: () => void;
  readonly switching: string | null;
  readonly scrollRef: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  const roster = entry.roster;
  const rows = roster?.commodores ?? [];
  const dim = entry.status === "unavailable";
  const open = (commodore: ConsoleRosterCommodore, commander: ConsoleRosterCommander | null) => {
    if (switching !== null) return;
    if (entry.status === "unpaired") { openConsoleSwitcher(); return; }
    switchMobileConsole({
      console: entry.id, commodore: commodore.id, commander: commander?.id ?? null,
      scrollTop: Math.max(0, Math.round(scrollRef.current?.scrollTop ?? 0)),
    });
  };
  const note = entry.status === "unpaired" ? null
    : entry.status === "unsupported" ? null
    : roster === null ? (entry.status === "unavailable" ? null : t("mobile.consoles.loading"))
    : rows.length === 0 ? t("mobile.consoles.empty") : null;
  const render = (commodore: ConsoleRosterCommodore) => (
    <MobileRosterRow key={commodore.id} consoleId={entry.id} commodore={commodore} switching={switching} onOpen={open} />
  );
  const known = new Set((roster?.sections ?? []).map((section) => section.id));
  const grouped = rows.length > 0 && known.size > 0;
  return (
    <section className={`mobile-console-group${dim ? " is-dim" : ""}`} data-console-id={entry.id} data-status={entry.status ?? undefined} aria-label={entry.label} aria-busy={switching?.startsWith(`${entry.id}/`) || undefined}>
      <MobileConsoleHead entry={entry} folded={folded} onToggle={onToggle} count={rows.length + (roster?.more ?? 0)} />
      {folded && entry.status !== "unsupported" ? null : <>
        {note ? <p className="mobile-console-note">{note}</p> : null}
        {entry.status === "unpaired" || (entry.status === "unavailable" && rows.length === 0)
          ? <div className="mobile-console-actions">
              <button type="button" data-press="r1" className="mobile-console-action" onClick={() => { openConsoleSwitcher(); }}>
                {entry.status === "unpaired" ? t("mobile.consoles.reconnect") : t("mobile.consoles.openSwitcher")}
              </button>
            </div>
          : null}
        {grouped && roster?.sections
          ? <MobileRosterSections sections={roster.sections} unsectionedCollapsed={roster.unsectionedCollapsed === true} rows={rows} render={render} />
          : rows.map(render)}
        {roster && roster.more > 0 && rows.length > 0 ? <p className="mobile-console-note">{t("mobile.consoles.more", { count: String(roster.more) })}</p> : null}
      </>}
    </section>
  );
}

/** 다른 콘솔 명부의 사용자 섹션 — 그 콘솔의 접힘에서 시작하고, 누르면 이 화면에서만 펼치고 접는다. */
function MobileRosterSections({ sections, unsectionedCollapsed, rows, render }: {
  readonly sections: readonly { readonly id: string; readonly name: string; readonly collapsed?: true }[];
  readonly unsectionedCollapsed: boolean;
  readonly rows: readonly ConsoleRosterCommodore[];
  readonly render: (commodore: ConsoleRosterCommodore) => ReactNode;
}) {
  const t = useT();
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set());
  const known = new Set(sections.map((section) => section.id));
  const unsectioned = rows.filter((row) => row.section === undefined || !known.has(row.section));
  const group = (id: string | null, name: string, stored: boolean, members: readonly ConsoleRosterCommodore[]) => {
    const key = id ?? "";
    const collapsed = stored !== flipped.has(key);
    const toggle = () => setFlipped((current) => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; });
    return <section key={id ?? "none"} className="mobile-home-section" aria-label={name}>
      <h3 className="mobile-home-section-heading">
        <button type="button" data-press="r1" className="mobile-home-section-toggle" aria-expanded={!collapsed} onClick={toggle}>
          <span className="mobile-home-section-name">{name}</span><MobileIcon name={collapsed ? "right" : "down"} size={14} />
        </button>
      </h3>
      {collapsed ? null : members.length ? members.map(render) : <p className="mobile-home-section-empty">{t("mobile.home.sectionEmpty")}</p>}
    </section>;
  };
  return <>
    {unsectioned.length > 0 ? group(null, t("sidebar.commodoreSection.none"), unsectionedCollapsed, unsectioned) : null}
    {sections.map((section) => group(section.id, section.name, section.collapsed === true, rows.filter((row) => row.section === section.id)))}
  </>;
}

/** 다른 콘솔의 사령관 한 줄 — 홈 사령관 행과 같은 모양(아바타 외형·run·미리보기·진행 목표 칩). */
function MobileRosterRow({ consoleId, commodore, switching, onOpen }: {
  readonly consoleId: string;
  readonly commodore: ConsoleRosterCommodore;
  readonly switching: string | null;
  readonly onOpen: (commodore: ConsoleRosterCommodore, commander: ConsoleRosterCommander | null) => void;
}) {
  const t = useT();
  const look = commodore.look ?? { base: fallbackMongleBase(commodoreAvatarKey(commodore.id)), tone: null };
  const tone = look.tone !== null && isIdentityTone(look.tone) ? look.tone : null;
  const commanders = commodore.commanders ?? [];
  const extra = Math.max(0, commanders.length - CHIP_LIMIT) + (commodore.moreCommanders ?? 0);
  const rowKey = mobileSwitchKey({ console: consoleId, commodore: commodore.id });
  const busy = switching === rowKey;
  return (
    <div className="mobile-home-commodore-item">
      <button type="button" data-press="r1" className={`mobile-conv-row is-commodore${busy ? " is-switching" : ""}`}
        data-roster-console={consoleId} data-roster-commodore={commodore.id} aria-busy={busy || undefined}
        onClick={() => onOpen(commodore, null)}>
        <span className="mobile-conv-row-av"><MongleAvatar base={look.base} tone={tone} role="commodore" state={rosterMongleState(commodore.run)} size={52} label="" decorative /></span>
        <span className="mobile-conv-row-copy">
          <span className="mobile-conv-row-top"><span className="mobile-conv-row-title">{commodore.name}</span></span>
          <span className="mobile-conv-row-sub">{busy ? t("mobile.consoles.switching") : commodore.preview?.trim() || t("mobile.home.noMessage")}</span>
        </span>
        {busy ? <span className="mobile-console-spinner" aria-hidden="true" /> : null}
      </button>
      {commanders.length > 0 ? (
        <div className="mobile-home-obj-chips">
          {commanders.slice(0, CHIP_LIMIT).map((commander) => {
            const chipBusy = switching === mobileSwitchKey({ console: consoleId, commodore: commodore.id, commander: commander.id });
            const chip = chipTone(commander.run);
            return (
              <button key={commander.id} type="button" data-press="r1" className={`mobile-home-obj-chip${chipBusy ? " is-switching" : ""}`} data-tone={chip}
                data-roster-commander={commander.id} aria-busy={chipBusy || undefined} onClick={() => onOpen(commodore, commander)}>
                <span className={`mobile-home-obj-dot is-${chip}`} aria-hidden="true" />
                <span className="mobile-home-obj-title">{commander.title}</span>
                {commander.total > 0 ? <span className="mobile-home-obj-prog">{`${commander.done}/${commander.total}`}</span> : null}
                {chipBusy ? <span className="mobile-console-spinner is-small" aria-hidden="true" /> : null}
              </button>
            );
          })}
          {extra > 0 ? <span className="mobile-home-obj-chip is-more">{t("mobile.consoles.moreCommanders", { count: String(extra) })}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
