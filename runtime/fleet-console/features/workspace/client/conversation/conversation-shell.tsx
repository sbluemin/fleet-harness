import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConversationSurfaceContext, ConversationSurfaceDescriptor, OperationKindDescriptor } from "@fleet-console/sdk/plugin";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";

import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import type { CanvasArenaInsets } from "../canvas/canvas-store.js";
import type { ConsoleState, OperationGeometry, OperationNode } from "../../../../core/client/src/integration/types.js";
import { openQuickLaunch, selectNestedBody, setActiveOperation, toggleOperationSearch } from "../../../../core/client/src/integration/store.js";
import { conversationSurfaceInboxSectionId, DEPUTY_COMMAND_BAND_ENTRY_ID, usePluginRegistry, type ResolvedConversationSurface } from "../../../../core/client/src/integration/plugin-registry.js";
import { useHostCapabilities } from "../../../../core/client/src/integration/use-host-capabilities.js";
import { OperationBodySlot, type OperationBodyConfig } from "../../../../core/client/src/chrome/mobile/operation-body-pool.js";
export { ConversationSideBarBottom } from "./conversation-dock.js";
import { RailToolIcons, type RailToolContext } from "../../../../core/client/src/chrome/rail/right-rail.js";
import { closeRailPanel, getRailStoreSnapshot, openRailPanel, useRailActivePanelId } from "../../../../core/client/src/chrome/rail/rail-store.js";
import { mountConversationOperationTabsHost, registerConversationOperationTab, useConversationOperationTabPanels, type ConversationTabSection } from "../../../../core/client/src/chrome/rail/operation-tabs.js";
import { useTheaterLabel } from "../../../../core/client/src/hooks/use-store.js";
import { useTheaterInboxState } from "../theater-inbox/store.js";
import { useDesktopRailEntries } from "../../../../core/client/src/chrome/pane/pane-registry.js";
import { SETTINGS_RAIL_ENTRY_ID } from "../../../settings/client/settings-entry.js";
import { operationAvatarKey, theaterAvatarKey, type MongleState } from "@fleet-console/sdk/avatars";
import { AvatarEditor, KeyedAvatar, OperationAvatar, operationAvatarRole, operationMongleState } from "../avatars.js";
import { pluginRuntimeState } from "../../../execution/client/operation-activity.js";
import { BROWSER_COMPANION_ID } from "../../../execution/client/agent/browser-companion.js";
import { setChatReadingWidthDefault } from "../../../execution/client/terminal/shared/terminal-preferences.js";
import { OperationCaptionContributions } from "../operation-contributions.js";
import { useClusterIndex, useOperationClusters } from "../operation-clusters.js";
import { PluginOperationRenderer } from "../canvas/canvas.js";
import {
  deferTriageOperation,
  getTriageSnapshot,
  publishTriageStage,
  recordTriageStageTheater,
  resolveTriageQueue,
  subscribeTriage,
  useTriageActive,
} from "../canvas/triage-store.js";
import { publishConversationClusters, publishConversationSubject, useConversationBodyRenderer, useConversationSubject } from "./conversation-slots.js";
import { closeConversationSurface, useConversationSurface, type ConversationSurfaceSelection } from "./conversation-surface-store.js";
import "./conversation.css";

/**
 * 대화 중심 화면 — 실험 기능 「대화 중심 화면」이 켜진 데스크톱의 Operations 셸.
 *
 * 세 칸이다: 왼쪽 사이드바(기존 그룹 트리 + 이 모듈이 더한 위·아래 줄), 가운데 대화 칸(Operation 하나 — War Room 이면
 * 대기 무대), 오른쪽 패널(기존 레일 카드 + 머리의 글자 탭). 캔버스는 마운트하지 않으므로 패널 좌표·최소화·Map 기록을
 * 이 셸이 바꾸지 않는다 — 토글을 끄면 캔버스가 켜기 전 그대로 돌아온다.
 */

const LAST_PANEL_KEY = "fleet-console.conversation.lastPanel";
/**
 * 가운데 대화 칸의 최소 폭. 넓은 오른쪽 패널(설정 등)을 열어도 대화가 이보다 좁아지지 않게, 레일은 이 폭만큼을 남기고
 * 넓어진다(RightRail reservedArenaWidth). 채팅 입력과 말풍선이 한 줄에 읽히는 폭이다. 세 열은 서로 붙어 있어 여백을 더하지 않는다.
 */
export const CONVERSATION_MIN_WIDTH = 480;
export const CONVERSATION_RESERVED_ARENA_WIDTH = CONVERSATION_MIN_WIDTH;

function readLastPanel(): string | null {
  try {
    return window.localStorage.getItem(LAST_PANEL_KEY);
  } catch {
    return null;
  }
}

function writeLastPanel(id: string): void {
  try {
    window.localStorage.setItem(LAST_PANEL_KEY, id);
  } catch {
    // 기억하지 못해도 이번 화면의 패널은 선다.
  }
}

/** 셸이 서 있는 동안 오른쪽 패널 앞 묶음(Operation 탭)을 레일 목록에 싣는다. 그리는 것은 없다. */
export function ConversationShellHost(): null {
  useEffect(() => mountConversationOperationTabsHost(), []);
  // 이 화면의 채팅은 가운데 칸 폭에 맞춘다(Fit) — 사람이 「채팅 폭」을 직접 골랐으면 그 값이 그대로 선다. 셸이 걷히면(토글 끔)
  // 캔버스의 기본(읽기 폭)으로 돌아간다.
  useEffect(() => setChatReadingWidthDefault("full"), []);
  // 마지막으로 연 오른쪽 패널을 기억한다 — 헤더 pill 이 다시 열 때 쓴다(설정은 문으로만 연다).
  const activePanelId = useRailActivePanelId();
  useEffect(() => {
    if (activePanelId !== null && activePanelId !== SETTINGS_RAIL_ENTRY_ID) writeLastPanel(activePanelId);
  }, [activePanelId]);
  return null;
}

/** 오른쪽 패널을 여닫는다 — 열린 것이 있으면 닫고, 없으면 마지막 패널(없으면 앞 묶음 첫 탭, 그것도 없으면 첫 도구)을 연다. */
function useToggleDetails(): () => void {
  const bindings = useDesktopRailEntries();
  return useCallback(() => {
    const active = getRailStoreSnapshot().activePanelId;
    if (active !== null) {
      closeRailPanel(active);
      return;
    }
    const panes = bindings.filter((binding) => binding.panes.length > 0 && binding.entry.id !== SETTINGS_RAIL_ENTRY_ID && binding.entry.visible?.() !== false);
    const last = readLastPanel();
    const target = panes.find((binding) => binding.entry.id === last) ?? panes.find((binding) => binding.core) ?? panes[0];
    if (target) openRailPanel(target.entry.id);
  }, [bindings]);
}

// ── 사이드바 위·아래 줄 ────────────────────────────────────────────────────

const SearchGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10.4 10.4 13.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
);
const PlusGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);

/** 사이드바 맨 위 줄 오른쪽 — 찾기(⌘K)와 새 Operation(Quick Launch). 보기·정렬·접기 단추와 한 줄, 같은 원형 문법이다. */
export function ConversationSideBarActions() {
  const t = useT();
  return (
    <span className="conversation-side-actions">
      <button type="button" className="conversation-round" onClick={toggleOperationSearch} aria-label={t("conversation.side.search")} title={t("conversation.side.search")}>
        <SearchGlyph />
      </button>
      <button type="button" className="conversation-round" onClick={openQuickLaunch} aria-label={t("conversation.side.newOperation")} title={t("conversation.side.newOperation")}>
        <PlusGlyph />
      </button>
    </span>
  );
}

/** 맨 위 줄 아래 — 출근한 부관(고정 표식)이 있을 때만 선다. */
export function ConversationSideBarTop() {
  const t = useT();
  const { commandBandEntries } = usePluginRegistry();
  const pinned = commandBandEntries.filter((entry) => entry.id === DEPUTY_COMMAND_BAND_ENTRY_ID);
  if (pinned.length === 0) return null;
  return (
    <div className="conversation-side-top">
      <div className="conversation-side-pinned" role="group" aria-label={t("conversation.side.pinnedAria")}>
        {pinned.map((entry) => (
          <PluginErrorBoundary key={entry.id} fallback={null}>
            <PluginEntry render={entry.render} />
          </PluginErrorBoundary>
        ))}
      </div>
    </div>
  );
}

function PluginEntry({ render }: { readonly render: () => ReactNode }) {
  return <>{render()}</>;
}

/** 오른쪽 패널 머리 — 앞 묶음(Operation 탭)과 뒤 묶음(작전구역 도구)을 글자 탭으로. */
export function ConversationPanelHeader({ context }: { readonly context: RailToolContext }) {
  const t = useT();
  const sections = usePanelSections();
  // Theater 가 아닌 대화(가운데 칸의 Operation 대화)의 패널은 도구 줄을 세우지 않는다 — 대화에서 곧장 이어 가는 도구
  // (conversationTab, 목표)만 대상의 글자 탭 오른쪽에 같은 글자 단추로 남는다. Theater 를 연 패널(사령관·Theater 설정)은 그대로다.
  const subject = useConversationSubject();
  const inbox = useTheaterInboxState();
  const operationConversation = subject !== null && inbox === null;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [overflow, setOverflow] = useState<readonly OverflowTab[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  // 탭은 한 줄이다 — 넘치는 탭은 줄에서 걷고 「더보기」 메뉴에 모은다. 탭 단추는 RailToolIcons 의 것 그대로이고(켜짐·순서·배지),
  // 이 머리는 어느 단추가 줄에 들어가는지만 잰다. 메뉴의 항목은 걷힌 단추를 대신 누른다.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      for (const item of row.querySelectorAll<HTMLElement>("[data-overflow]")) item.removeAttribute("data-overflow");
      // 줄마다 따로 잰다 — 대상 탭 줄과 도구 줄은 서로의 넘침에 끌려가지 않는다. 「⋯」는 도구 줄 끝에 서므로, 아직 서지 않았으면
      // 도구 줄만 그 자리(MORE_RESERVE)를 남긴다. 넘친 것은 탭이든 도구든 같은 메뉴에 모인다.
      const more = moreRef.current;
      const moreShown = more !== null && more.offsetWidth > 0;
      const rowLeft = row.getBoundingClientRect().left;
      const hidden: OverflowTab[] = [];
      for (const group of row.children) {
        if (!(group instanceof HTMLElement)) continue;
        const items = [...group.querySelectorAll<HTMLElement>(".right-rail-ico, .right-rail-divider")];
        if (items.every((item) => item.getBoundingClientRect().right - rowLeft <= row.clientWidth)) continue;
        const reserve = group.classList.contains("conversation-panel-tools") && !moreShown ? MORE_RESERVE : 0;
        const limit = row.clientWidth - reserve;
        let cut = false;
        for (const item of items) {
          if (!cut && item.getBoundingClientRect().right - rowLeft > limit) cut = true;
          if (!cut) continue;
          item.setAttribute("data-overflow", "true");
          if (item.classList.contains("right-rail-ico")) {
            hidden.push({ label: item.innerText.trim() || item.getAttribute("aria-label") || "", active: item.classList.contains("is-active"), element: item });
          }
        }
      }
      setOverflow((current) => sameOverflow(current, hidden) ? current : hidden);
    };
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(measure); };
    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(row);
    // 탭이 서고 걷히거나(Operation 탭) 켜짐이 바뀌면 다시 잰다. 이 머리가 다는 data-overflow 는 관찰하지 않는다.
    const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mutation?.observe(row, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
    return () => { resize?.disconnect(); mutation?.disconnect(); if (frame !== 0) cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key !== "Escape" : moreRef.current?.parentElement?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", close, true); };
  }, [menuOpen]);
  useEffect(() => { if (overflow.length === 0) setMenuOpen(false); }, [overflow.length]);
  const hiddenActive = overflow.find((tab) => tab.active) ?? null;
  return (
    <div className="conversation-panel-head">
      {/* 맨 위 줄 — Grok 세부 정보처럼 원형 단추(닫기)만 선다. Desktop 에서는 이 줄의 빈 자리가 창을 끄는 자리다. */}
      <div className="conversation-panel-toolbar">
        <span className="conversation-panel-toolbar-spacer" aria-hidden="true" />
        <button type="button" className="conversation-round conversation-panel-close" onClick={() => { const active = getRailStoreSnapshot().activePanelId; if (active !== null) closeRailPanel(active); }} aria-label={t("conversation.panel.close")} title={t("conversation.panel.close")}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>
      <ConversationPanelIdentity />
      {/* Theater 를 연 동안(Theater Inbox 를 패널로 옮긴 자리) 섹션이 둘 이상이면 — 사령관 | Theater 설정 — 섹션 줄이 탭 줄 위에 선다.
          고른 섹션의 칸만 탭 줄에 선다. */}
      {sections.list.length >= 2 ? (
        <div className="conversation-panel-sections" role="group" aria-label={t("theaterInbox.panelSections")}>
          {sections.list.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`conversation-panel-section${section.id === sections.activeId ? " is-active" : ""}`}
              aria-pressed={section.id === sections.activeId}
              onClick={() => sections.open(section.id)}
            >
              {section.title}
            </button>
          ))}
        </div>
      ) : null}
      {/* 이름 아래 한 줄 — 대상의 글자 탭(구성원, 사령관의 행위 기록·지시·정보·설정)과 작전구역 도구 글리프가 Grok 세그먼트처럼
          한 줄에 선다. 켜진 것은 둥근 면 하나로 말한다. 넘치는 것은 줄 끝 「⋯」 메뉴에 모인다(뒤쪽 도구부터). */}
      <div className="conversation-panel-segments">
        <div className="conversation-panel-segment-row" ref={rowRef}>
          <span className="conversation-panel-tabs">
            <RailToolIcons context={context} variant="text" scope="core" {...(sections.filter ? { coreFilter: sections.filter } : {})} />
            {operationConversation ? <RailToolIcons context={context} variant="text" scope="tools" toolFilter={isConversationTab} /> : null}
          </span>
          {operationConversation ? null : (
            <span className="conversation-panel-tools">
              <RailToolIcons context={context} variant="icons" scope="tools" />
            </span>
          )}
        </div>
        <span className={`conversation-panel-more-wrap${overflow.length > 0 ? "" : " is-idle"}`}>
          <button
            type="button"
            ref={moreRef}
            className={`conversation-panel-more${hiddenActive ? " is-active" : ""}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={hiddenActive ? hiddenActive.label : t("conversation.panel.more")}
            title={hiddenActive ? hiddenActive.label : t("conversation.panel.more")}
            tabIndex={overflow.length > 0 ? 0 : -1}
            aria-hidden={overflow.length > 0 ? undefined : true}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="12.5" cy="8" r="1.2" fill="currentColor" /></svg>
          </button>
          {menuOpen && overflow.length > 0 ? (
            <div className="conversation-panel-more-menu" role="menu">
              {overflow.map((tab) => (
                <button
                  key={tab.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={tab.active}
                  className={`conversation-panel-more-item${tab.active ? " is-active" : ""}`}
                  onClick={() => { setMenuOpen(false); tab.element.click(); }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function isConversationTab(entry: RailEntryDescriptor): boolean {
  return entry.conversationTab === true;
}

/** 플러그인 대화의 머리 값(아바타 얼굴 등)은 플러그인 저장소에 산다 — 그 대화가 알리면 머리를 다시 그린다. */
function useConversationSurfaceHead(descriptor: Pick<ConversationSurfaceDescriptor, "subscribe"> | null): void {
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const subscribe = descriptor?.subscribe;
  useEffect(() => (subscribe ? subscribe(refresh) : undefined), [subscribe]);
}

/** 오른쪽 패널 머리 가운데 — 지금 가운데 칸 대상의 표식과 이름(Grok 세부 정보의 아바타·이름 자리). 대상이 없으면 서지 않는다. */
function ConversationPanelIdentity() {
  const inbox = useTheaterInboxState();
  const theaterLabel = useTheaterLabel(inbox?.theaterId);
  const subject = useConversationSubject();
  const surface = useConversationSurface();
  const { conversationSurfaces } = usePluginRegistry();
  const state = useConsoleState();
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const centerSurface = surface === null ? null : conversationSurfaces.find((candidate) => candidate.id === surface.surfaceId) ?? null;
  const descriptor = subject === null ? centerSurface : null;
  const clusterIndex = useClusterIndex();
  useConversationSurfaceHead(centerSurface);
  // Theater 를 연 동안 패널은 그 Theater 의 것이다 — Theater 의 몽글 아바타는 그 사령관이다(사이드바 Theater 머리 표식과 같은 얼굴).
  // 가운데 칸에 그 Theater 를 대신하는 대화(사령관)가 서 있으면 이름은 그 대화의 이름이다 — 패널을 어느 길로 열든 머리가 같다.
  if (inbox !== null && theaterLabel !== null) {
    const context = centerSurface !== null && surface !== null
      ? { params: surface.params, language, theme: state.activeTheme, close: () => closeConversationSurface(centerSurface.id) } as const
      : null;
    let owner: { readonly title: string; readonly label: string; readonly state: MongleState } | null = null;
    try {
      if (centerSurface !== null && context !== null && centerSurface.theater?.(context)?.theaterId === inbox.theaterId) {
        const avatar = centerSurface.avatar?.(context) ?? null;
        owner = { title: centerSurface.title(context), label: avatar?.label ?? centerSurface.title(context), state: avatar?.state ?? "idle" };
      }
    } catch { owner = null; }
    return (
      <div className="conversation-panel-identity">
        <AvatarEditor avatarKey={theaterAvatarKey(inbox.theaterId)} role="commodore" state={owner?.state ?? "idle"} size={64} label={owner?.label ?? theaterLabel} />
        <strong className="conversation-panel-identity-name">{owner?.title ?? theaterLabel}</strong>
      </div>
    );
  }
  if (subject !== null) {
    // 대상의 몽글 아바타(64px) — 이 화면에서만 눌러 고친다. 일반 화면에는 이 자리도 편집 진입도 없다.
    return (
      <div className="conversation-panel-identity">
        <AvatarEditor avatarKey={operationAvatarKey(subject.id)} role={operationAvatarRole(subject)} state={operationMongleState(subject.id, state, clusterIndex.clusters)} size={64} label={subject.title} />
        <strong className="conversation-panel-identity-name">{subject.title}</strong>
      </div>
    );
  }
  if (descriptor !== null && surface !== null) {
    const context = { params: surface.params, language, theme: state.activeTheme, close: () => closeConversationSurface(descriptor.id) } as const;
    const avatar = descriptor.avatar?.(context) ?? null;
    return (
      <div className="conversation-panel-identity">
        {avatar
          ? <AvatarEditor avatarKey={avatar.key} role={avatar.role} state={avatar.state ?? "idle"} size={64} label={avatar.label} />
          : descriptor.mark ? <span className="conversation-panel-identity-mark is-surface" aria-hidden="true">{descriptor.mark()}</span> : null}
        <strong className="conversation-panel-identity-name">{descriptor.title(context)}</strong>
      </div>
    );
  }
  return null;
}

/**
 * 패널 머리의 Theater 섹션 — 앞 묶음 탭에 붙은 섹션 꼬리표(ConversationTabSection)로 줄을 세운다. Theater 를 연 동안에는 그
 * Theater 의 섹션 탭만 서고(대상 Operation 의 탭은 걷힌다), 섹션이 둘 이상이면 고른 섹션의 칸만 탭 줄에 선다. 고른 섹션은 켜진
 * 탭의 섹션이고, 도구를 켠 동안은 마지막으로 고른 섹션을 그대로 보인다.
 */
function usePanelSections(): {
  readonly list: readonly ConversationTabSection[];
  readonly activeId: string | null;
  readonly filter: ((entryId: string) => boolean) | null;
  readonly open: (sectionId: string) => void;
} {
  const tabs = useConversationOperationTabPanels();
  const inbox = useTheaterInboxState();
  const activePanelId = useRailActivePanelId();
  const theaterId = inbox?.theaterId ?? null;
  const last = useRef<string | null>(null);
  const visible = theaterId === null ? tabs : tabs.filter((tab) => tab.section?.theaterId === theaterId);
  const list: ConversationTabSection[] = [];
  for (const tab of visible) if (tab.section && !list.some((section) => section.id === tab.section?.id)) list.push(tab.section);
  const activeTab = visible.find((tab) => tab.id === activePanelId);
  if (activeTab?.section) last.current = activeTab.section.id;
  const activeId = list.some((section) => section.id === last.current) ? last.current : list[0]?.id ?? null;
  const sectioned = list.length >= 2;
  const filter = theaterId === null && !sectioned ? null : (entryId: string) => {
    const tab = tabs.find((candidate) => candidate.id === entryId);
    if (!tab) return true;
    if (theaterId !== null && tab.section?.theaterId !== theaterId) return false;
    return !sectioned || tab.section?.id === activeId;
  };
  const open = (sectionId: string) => {
    const first = visible.find((tab) => tab.section?.id === sectionId);
    last.current = sectionId;
    if (first) openRailPanel(first.id);
  };
  return { list, activeId, filter, open };
}

/** 「⋯」 단추(30px)와 그 틈 — 도구 줄이 넘칠 때 그 끝에 남겨 둘 자리. */
const MORE_RESERVE = 38;

interface OverflowTab {
  readonly label: string;
  readonly active: boolean;
  readonly element: HTMLElement;
}

function sameOverflow(a: readonly OverflowTab[], b: readonly OverflowTab[]): boolean {
  return a.length === b.length && a.every((tab, index) => tab.element === b[index]!.element && tab.active === b[index]!.active && tab.label === b[index]!.label);
}

// ── 가운데 대화 칸 ─────────────────────────────────────────────────────────

interface ConversationStageProps {
  readonly state: ConsoleState;
  readonly insets: CanvasArenaInsets;
  readonly language: "en" | "ko";
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly onClose: (operationId: string) => void;
}

/** War Room 무대 — 지목이 먼저, 그다음 지금 선 무대(다음을 누르기 전까지 유지), 없으면 대기열 맨 앞. */
function useWarRoomStage(state: ConsoleState, active: boolean): { readonly stage: OperationNode | null; readonly waiting: number; readonly next: () => void } {
  useSyncExternalStore(subscribeTriage, getTriageSnapshot, getTriageSnapshot);
  const stageRef = useRef<string | null>(null);
  const queue = active ? resolveTriageQueue(state.operations, state.operationRuntime) : [];
  const picked = queue.find((entry) => entry.picked) ?? null;
  const retained = stageRef.current === null ? null : queue.find((entry) => entry.operation.id === stageRef.current) ?? null;
  const stage = (picked ?? retained ?? queue[0] ?? null)?.operation ?? null;
  stageRef.current = stage?.id ?? null;
  useEffect(() => {
    if (!active) return;
    publishTriageStage(stage?.id ?? null);
    if (stage) recordTriageStageTheater(stage.theaterId);
  }, [active, stage]);
  const next = useCallback(() => {
    const current = stageRef.current;
    if (current === null) return;
    stageRef.current = null;
    deferTriageOperation(current);
  }, []);
  return { stage, waiting: queue.length, next };
}

/**
 * Cruise — 활성 Operation. 활성이 풀려도(크롬을 눌러도) 방금 보던 대화는 남긴다. 처음 열었을 때처럼 본 것이 없으면
 * 그 작전구역에서 가장 최근에 움직인 대화를 보인다 — 빈 칸보다 이어서 볼 대화가 먼저다.
 */
function useCruiseSubject(state: ConsoleState): OperationNode | null {
  const lastRef = useRef<string | null>(null);
  const inTheater = (id: string | null) => id === null ? null : state.operations.find((operation) => operation.id === id && operation.theaterId === state.activeTheaterId) ?? null;
  const active = inTheater(state.activeOperationId);
  const latest = () => state.operations
    .filter((operation) => operation.theaterId === state.activeTheaterId)
    .reduce<OperationNode | null>((best, operation) => (best === null || operation.ts.updatedAt > best.ts.updatedAt ? operation : best), null);
  const subject = active ?? inTheater(lastRef.current) ?? latest();
  lastRef.current = subject?.id ?? null;
  return subject;
}

export function ConversationStage({ state, insets, language, operationKinds, onClose }: ConversationStageProps) {
  const t = useT();
  const warRoom = useTriageActive();
  const cruiseSubject = useCruiseSubject(state);
  const { stage, waiting, next } = useWarRoomStage(state, warRoom);
  const subject = warRoom ? stage : cruiseSubject;
  // 플러그인 대화(사령관 등)는 Cruise 의 가운데 칸에만 선다. War Room 은 대기 무대가 칸을 가진다.
  const surface = useConversationSurface();
  const { conversationSurfaces } = usePluginRegistry();
  const surfaceDescriptor = surface === null || warRoom ? null : conversationSurfaces.find((descriptor) => descriptor.id === surface.surfaceId) ?? null;
  useEffect(() => { if (warRoom) closeConversationSurface(); }, [warRoom]);
  useEffect(() => { publishConversationSubject(surfaceDescriptor ? null : subject); }, [subject, surfaceDescriptor]);
  // 가운데 칸에 선 대화가 곧 활성 Operation 이다 — 사이드바 줄이 칩과 같은 선택 표시(테두리 + 면)를 받고, 도착 표식도
  // 보고 있는 대화만큼 정리된다. 크롬을 눌러 활성이 풀려도 칸의 대화는 그대로이므로 다시 활성으로 세운다.
  const activeOperationId = state.activeOperationId;
  useEffect(() => {
    // 플러그인 대화가 선 동안에는 어느 Operation 도 칸에 없다 — 사이드바의 Operation 줄 선택을 걷는다(대화를 걷으면 되돌아온다).
    if (surfaceDescriptor !== null) {
      if (activeOperationId !== null) setActiveOperation(null);
      return;
    }
    if (warRoom || cruiseSubject === null || activeOperationId === cruiseSubject.id) return;
    setActiveOperation(cruiseSubject.id);
  }, [activeOperationId, cruiseSubject, surfaceDescriptor, warRoom]);
  useEffect(() => () => publishConversationSubject(null), []);
  // 구성원 탭의 아바타가 같은 묶음 사실(검토 대기·결정 요청·임무 완료)로 얼굴을 고르게 묶음을 내건다.
  const operationClusters = useOperationClusters();
  useEffect(() => { publishConversationClusters(operationClusters); }, [operationClusters]);
  const toggleDetails = useToggleDetails();

  return (
    <section
      className={`conversation-stage${warRoom ? " is-war-room" : ""}`}
      // 세 열은 창 높이 전체를 쓰고 서로 붙는다 — 사이드바·레일의 실제 폭이 곧 이 칸의 좌우다.
      style={{ left: insets.left, right: insets.right }}
      aria-label={t("conversation.stage.aria")}
    >
      <ConversationQuota />
      {surfaceDescriptor && surface ? (
        <ConversationSurfaceColumn
          key={surface.surfaceId}
          descriptor={surfaceDescriptor}
          selection={surface}
          language={language}
          theme={state.activeTheme}
          onToggleDetails={toggleDetails}
        />
      ) : subject ? (
        <ConversationColumn
          key={subject.id}
          state={state}
          operation={subject}
          language={language}
          operationKinds={operationKinds}
          warRoom={warRoom ? { waiting, next } : null}
          onToggleDetails={toggleDetails}
          onClose={onClose}
        />
      ) : warRoom ? (
        <div className="conversation-empty">
          <span className="conversation-empty-mark">{t("canvas.triage.clearMark")}</span>
          <strong>{t("canvas.triage.clearTitle")}</strong>
        </div>
      ) : (
        <div className="conversation-empty">
          <strong>{t("conversation.empty.title")}</strong>
          <span>{t("conversation.empty.body")}</span>
        </div>
      )}
    </section>
  );
}

/**
 * 사용량(Quota 등 밴드 요약) — 가운데 칸 맨 위 줄의 오른쪽 끝에 떠 있는 캡슐 하나다. 대상 Operation 이 아니라 계정 전역의 신호라
 * pill(대상의 이름)·단추 묶음(대상의 동작)과 붙이지 않고, Cruise·War Room·플러그인 대화·빈 칸 어디서나 같은 자리에 선다.
 * 칸 폭이 줄면 단계를 낮춘다(전체 → 표식만 → 첫 칸 하나, conversation.css·quota.css 의 컨테이너 질의). 누르면 지금처럼 요약 팝업이 열린다.
 */
function ConversationQuota() {
  const t = useT();
  const { commandBandEntries } = usePluginRegistry();
  const usage = commandBandEntries.filter((entry) => entry.id !== DEPUTY_COMMAND_BAND_ENTRY_ID);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // 단계는 칸 폭이 아니라 실제로 남는 자리로 정한다 — pill 묶음(이름·다음·단추)의 원래 폭을 뺀 반쪽에 세 단계(두 줄 값 → 표식만
  // → 첫 칸)의 실제 폭을 차례로 대어 들어가는 가장 큰 단계를 고른다. pill 줄은 고른 폭만큼 양쪽을 비워 pill 을 가운데에 둔다.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const stage = box?.closest<HTMLElement>(".conversation-stage") ?? null;
    if (!box || !stage) return;
    let frame = 0;
    const widthAt = (tier: QuotaTier) => {
      box.dataset.tier = tier;
      return box.offsetWidth;
    };
    const measure = () => {
      frame = 0;
      const widths: Record<QuotaTier, number> = { full: widthAt("full"), marks: widthAt("marks"), single: widthAt("single") };
      const center = pillGroupNaturalWidth(stage);
      // 오른쪽 끝 여백(--space-3)과 Windows 캡션 버튼 몫은 캡슐의 right 가 이미 진다 — 그 값을 그대로 읽는다.
      const right = Number.parseFloat(getComputedStyle(box).right) || 0;
      const available = (stage.clientWidth - center) / 2 - right - QUOTA_PILL_GAP;
      const tier: QuotaTier = widths.full <= available ? "full" : widths.marks <= available ? "marks" : "single";
      box.dataset.tier = tier;
      stage.style.setProperty("--conversation-quota-space", `${Math.ceil(widths[tier] + right + QUOTA_PILL_GAP)}px`);
    };
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(measure); };
    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(stage);
    for (const child of box.children) resize?.observe(child);
    // pill 이 바뀌거나(대상·이름) 사용량 값이 들어오면 다시 잰다. 이 캡슐이 다는 data-tier 는 관찰하지 않는다.
    const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mutation?.observe(stage, { childList: true, subtree: true, characterData: true });
    return () => { resize?.disconnect(); mutation?.disconnect(); if (frame !== 0) cancelAnimationFrame(frame); };
  }, [usage.length]);
  if (usage.length === 0) return null;
  return (
    <div className="conversation-quota" ref={boxRef} data-tier="full" role="group" aria-label={t("conversation.quota.aria")}>
      {usage.map((entry) => (
        <PluginErrorBoundary key={entry.id} fallback={null}>
          <PluginEntry render={entry.render} />
        </PluginErrorBoundary>
      ))}
    </div>
  );
}

type QuotaTier = "full" | "marks" | "single";
/** 사용량 캡슐과 pill 묶음 사이의 최소 틈. */
const QUOTA_PILL_GAP = 12;

/** pill 줄 가운데 묶음(이름 pill·다음·단추 묶음)의 원래 폭 — 이름이 말줄임으로 줄어든 만큼을 되돌려 센다(최대 620). */
function pillGroupNaturalWidth(stage: HTMLElement): number {
  const row = stage.querySelector<HTMLElement>(".conversation-pill-row");
  if (!row) return 0;
  const items = [...row.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
  const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
  let total = Math.max(0, items.length - 1) * gap;
  for (const item of items) {
    if (item.classList.contains("conversation-pill")) {
      const title = item.querySelector<HTMLElement>(".conversation-pill-title");
      const natural = item.offsetWidth + (title ? title.scrollWidth - title.clientWidth : 0);
      total += Math.min(natural, 620);
    } else {
      total += item.offsetWidth;
    }
  }
  return total;
}

/**
 * 가운데 칸의 플러그인 대화 — 머리 pill 은 호스트가, 본문은 플러그인이 그린다. 대화가 선 동안 플러그인 탭이 오른쪽
 * 패널 앞 묶음에 서고, 패널이 닫혀 있으면 기본 탭을 연다.
 */
function ConversationSurfaceColumn({ descriptor, selection, language, theme, onToggleDetails }: {
  readonly descriptor: ResolvedConversationSurface;
  readonly selection: ConversationSurfaceSelection;
  readonly language: "en" | "ko";
  readonly theme: ConversationSurfaceContext["theme"];
  readonly onToggleDetails: () => void;
}) {
  const t = useT();
  useConversationSurfaceHead(descriptor);
  const context = useMemo<ConversationSurfaceContext>(() => ({
    params: selection.params,
    language,
    theme,
    close: () => closeConversationSurface(descriptor.id),
  }), [descriptor.id, language, selection.params, theme]);
  // 대화가 Theater 의 Inbox 섹션을 대신하면(사령관) 그 탭에 섹션 꼬리표를 단다 — Theater 를 연 동안 패널 머리가 「사령관 | Theater 설정」
  // 섹션 줄로 묶는다.
  const { theaterInboxSections } = usePluginRegistry();
  const section = useMemo<ConversationTabSection | null>(() => {
    let info: { readonly theaterId: string; readonly inboxSection: string } | null = null;
    try { info = descriptor.theater?.(context) ?? null; } catch { info = null; }
    if (!info) return null;
    const id = conversationSurfaceInboxSectionId(descriptor, info.inboxSection);
    const inboxSection = theaterInboxSections.find((candidate) => candidate.id === id);
    return { id, title: inboxSection?.title(language) ?? descriptor.title(context), theaterId: info.theaterId };
  }, [context, descriptor, language, theaterInboxSections]);
  // 탭은 레일 패널로 선다 — 독점 슬롯·폭 기억·밀어내기를 그대로 받는다. 대화가 걷히면 탭도, 그 탭이 연 패널도 걷힌다.
  useEffect(() => {
    const tabs = descriptor.tabs ?? [];
    const disposers = tabs.map((tab, order) => registerConversationOperationTab({
      id: tab.id,
      title: tab.title,
      icon: tab.icon ?? null,
      order,
      ...(tab.defaultWidth === undefined ? {} : { defaultWidth: tab.defaultWidth }),
      ...(section ? { section } : {}),
      render: () => <PluginErrorBoundary fallback={null}>{tab.render(context)}</PluginErrorBoundary>,
    }));
    return () => {
      for (const dispose of disposers) dispose();
      const active = getRailStoreSnapshot().activePanelId;
      if (active !== null && tabs.some((tab) => tab.id === active)) closeRailPanel(active);
    };
  }, [context, descriptor, section]);
  // 연 순간(같은 대화를 다시 연 때도) 패널이 닫혀 있으면 기본 탭을 연다.
  useEffect(() => {
    if (descriptor.defaultTab === undefined || getRailStoreSnapshot().activePanelId !== null) return;
    openRailPanel(descriptor.defaultTab);
  }, [descriptor.defaultTab, selection.nonce]);
  const title = descriptor.title(context);
  const subtitle = descriptor.subtitle?.(context) ?? null;
  // 대화의 동작은 Operation 대화처럼 pill 바로 옆 단추 묶음에 선다 — 이 줄 안에 있어야 Desktop 의 창 끌기 자리에서 빠져 눌린다.
  const actions = descriptor.actions?.(context) ?? null;
  // 대화의 주인에게 몽글 아바타가 있으면 pill 도 그 아바타다(Operation 대화의 pill 과 같은 20px) — 오른쪽 패널 머리의 64px 아바타와 같은 얼굴.
  const avatar = descriptor.avatar?.(context) ?? null;
  return (
    <div className="conversation-column">
      <div className="conversation-pill-row">
        <button type="button" className="conversation-pill" onClick={onToggleDetails} aria-label={t("conversation.pill.detailsAria", { title })}>
          {avatar
            ? <KeyedAvatar avatarKey={avatar.key} role={avatar.role} state={avatar.state ?? "idle"} size={20} label={avatar.label} decorative className="conversation-pill-mark" />
            : descriptor.mark ? <span className="conversation-pill-surface-mark" aria-hidden="true">{descriptor.mark()}</span> : null}
          <span className="conversation-pill-title">{title}</span>
          {subtitle ? <span className="conversation-pill-sub">· {subtitle}</span> : null}
        </button>
        {actions === null || actions === false ? null : (
          <span className="conversation-pill-actions">
            <PluginErrorBoundary fallback={null}>{actions}</PluginErrorBoundary>
          </span>
        )}
      </div>
      <div className="conversation-body is-surface">
        <PluginErrorBoundary fallback={null}>{descriptor.render(context)}</PluginErrorBoundary>
      </div>
    </div>
  );
}

function ConversationColumn({ state, operation, language, operationKinds, warRoom, onToggleDetails, onClose }: {
  readonly state: ConsoleState;
  readonly operation: OperationNode;
  readonly language: "en" | "ko";
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly warRoom: { readonly waiting: number; readonly next: () => void } | null;
  readonly onToggleDetails: () => void;
  readonly onClose: (operationId: string) => void;
}) {
  const t = useT();
  const capabilities = useHostCapabilities();
  const clusterIndex = useClusterIndex();
  const bodyRenderer = useConversationBodyRenderer();
  const clusterRoot = clusterIndex.rootOf.get(operation.id) ?? null;
  const nested = state.nestedOperations.filter((candidate) => candidate.parentOperationId === operation.id);
  const chosen = state.nestedBodySelection[operation.id];
  const bodyOwner = (chosen ? nested.find((candidate) => candidate.id === chosen) : undefined) ?? operation;
  const runtimeState = pluginRuntimeState(state.operationRuntime, state.operationRuntimeHydration, bodyOwner.id);
  const descriptor = operationKinds.find((kind) => kind.pluginId === bodyOwner.pluginId && kind.type === bodyOwner.type)
    ?? operationKinds.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);

  // 본문 크기 — 플러그인이 읽는 geometry 는 이 칸의 실측이다. 캔버스 좌표가 아니므로 어디에도 저장하지 않는다.
  const [geometry, setGeometry] = useState<OperationGeometry>({ x: 0, y: 0, width: 720, height: 640, zIndex: 0 });
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const update = () => setGeometry((current) => {
      const width = Math.max(1, element.clientWidth);
      const height = Math.max(1, element.clientHeight);
      return current.width === width && current.height === height ? current : { ...current, width, height };
    });
    update();
    if (typeof ResizeObserver === "undefined") return;
    // 관찰 콜백 안에서 곧장 크기를 바꾸면 같은 프레임에 다시 관찰이 쌓인다 — 다음 프레임에 한 번만 반영한다.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => { frame = 0; update(); });
    });
    observer.observe(element);
    return () => { observer.disconnect(); if (frame !== 0) cancelAnimationFrame(frame); };
  }, []);

  const activate = useCallback(() => setActiveOperation(operation.id), [operation.id]);
  const config: OperationBodyConfig = {
    active: state.activeOperationId === operation.id,
    keyboardFocusRequestId: state.keyboardFocusRequest?.operationId === operation.id ? state.keyboardFocusRequest.requestId : 0,
    geometry,
    operation: bodyOwner,
    runtimeState,
    bodyLive: true,
    theme: state.activeTheme,
    language,
    zoom: 1,
    onActivate: activate,
    onClose: bodyOwner === operation ? () => onClose(operation.id) : () => selectNestedBody(operation.id, null),
    onGeometryChange: setGeometry,
    // 이 칸은 Operation 하나에 화면을 다 준다 — companion 패널을 열지 않는다. 콜백을 빼 두는 것이 「없음」의 신호다.
  };
  const defaultBody = <OperationBodySlot key={bodyOwner.id} operationId={bodyOwner.id} config={config} className="conversation-body-slot" />;
  const custom = bodyRenderer?.({ operation, bodyOperation: bodyOwner, nestedOperations: nested, language, defaultBody }) ?? null;
  const memberCount = clusterRoot ? Math.max(0, clusterRoot.cluster.members.length - 1) : nested.length;

  return (
    <div className="conversation-column">
      <div className="conversation-pill-row">
        <button
          type="button"
          className="conversation-pill"
          onClick={onToggleDetails}
          aria-label={t("conversation.pill.detailsAria", { title: operation.title })}
        >
          <OperationAvatar operation={operation} state={operationMongleState(operation.id, state, clusterIndex.clusters)} size={20} label={operation.title} decorative className="conversation-pill-mark" />
          <span className="conversation-pill-title">{operation.title}</span>
          {bodyOwner !== operation ? <span className="conversation-pill-sub">› {clusterRoot?.cluster.conversation?.members.find((member) => member.operationId === bodyOwner.id)?.name ?? clusterRoot?.formation.byOperationId.get(bodyOwner.id)?.member.name ?? bodyOwner.title}</span> : null}
          {memberCount > 0 ? (
            <span className="conversation-pill-sub">· {t(memberCount === 1 ? "conversation.pill.members_one" : "conversation.pill.members_other", { count: memberCount })}</span>
          ) : null}
        </button>
        {warRoom ? (
          <button type="button" className="conversation-pill-next" onClick={warRoom.next} aria-label={t("conversation.pill.nextAria")} disabled={warRoom.waiting < 2}>
            <span>{t("conversation.pill.next")}</span>
            <span className="conversation-pill-queue">{t("conversation.pill.queue", { count: warRoom.waiting })}</span>
          </button>
        ) : null}
        <span className="conversation-pill-actions">
          <OperationCaptionContributions operation={bodyOwner} language={language} surface="caption" />
          {descriptor?.captionActions === undefined ? null : (
            <PluginErrorBoundary fallback={<></>}>
              <PluginOperationRenderer
                active={config.active}
                capabilities={capabilities}
                geometry={geometry}
                operation={bodyOwner}
                theme={state.activeTheme}
                language={language}
                viewportZoom={1}
                runtimeState={runtimeState}
                onActivate={activate}
                onClose={config.onClose}
                onGeometryChange={setGeometry}
                onRequestCompanions={() => {}}
                companionsOpen={false}
                hiddenCompanionPanelIds={NO_HIDDEN_COMPANIONS}
                onSetCompanionPanelVisible={() => {}}
                companionPanelIds={CONVERSATION_COMPANION_PANEL_IDS}
                bodyLive
                render={descriptor.captionActions}
              />
            </PluginErrorBoundary>
          )}
          {/* Operation 메뉴(「...」)는 이 줄에 세우지 않는다 — 같은 메뉴가 사이드바 줄의 우클릭으로 열린다. */}
        </span>
      </div>
      {/* 구성원은 pill 의 「구성원 n」과 오른쪽 「구성원」 탭이 말한다 — 구성원 원장도 그 탭에서 고른다. 본문(그룹 대화든 터미널이든) 위에
          노드 줄을 따로 세우지 않는다. */}
      <div className="conversation-body" ref={bodyRef} onPointerDownCapture={activate}>
        {custom ?? defaultBody}
      </div>
    </div>
  );
}

const NO_HIDDEN_COMPANIONS: readonly string[] = [];
/** 대화 중심 화면이 캡션 단추로 내주는 companion — 브라우저뿐이다. 세션 분석가는 이 화면에서 지원하지 않는다. */
const CONVERSATION_COMPANION_PANEL_IDS: readonly string[] = [BROWSER_COMPANION_ID];
