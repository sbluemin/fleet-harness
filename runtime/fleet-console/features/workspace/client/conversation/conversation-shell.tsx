import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { flushSync } from "react-dom";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { ConversationSurfaceContext, ConversationSurfaceDescriptor, OperationKindDescriptor } from "@fleet-console/sdk/plugin";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";

import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import type { ArenaInsets } from "./arena-insets.js";
import type { ConsoleState, OperationGeometry, OperationNode } from "../../../../core/client/src/integration/types.js";
import { requestSideBarAddTheater, selectNestedBody, setActiveOperation, themePolarity, toggleOperationSearch } from "../../../../core/client/src/integration/store.js";
import { useQuickLaunchShortcutLabel } from "../../../../core/client/src/integration/shortcuts.js";
import { conversationSurfaceInboxSectionId, usePluginRegistry, type ResolvedConversationSurface } from "../../../../core/client/src/integration/plugin-registry.js";
import { useHostCapabilities } from "../../../../core/client/src/integration/use-host-capabilities.js";
import { OperationBodySlot, type OperationBodyConfig } from "../../../../core/client/src/chrome/mobile/operation-body-pool.js";
export { ConversationSideBarBottom } from "./conversation-dock.js";
import { openConversationTab, RailToolIcons, useConversationTabsState, type RailToolContext } from "../../../../core/client/src/chrome/rail/right-rail.js";
import { ToolbarTipLayer } from "../../../../core/client/src/chrome/toolbar/toolbar-tip.js";
import { closeRailPanel, getRailStoreSnapshot, openRailPanel, useRailActivePanelId } from "../../../../core/client/src/chrome/rail/rail-store.js";
import { mountConversationOperationTabsHost, registerConversationOperationTab, useConversationOperationTabPanels, type ConversationTabSection } from "../../../../core/client/src/chrome/rail/operation-tabs.js";
import { useTheaterLabel } from "../../../../core/client/src/hooks/use-store.js";
import { useTheaterInboxState } from "../theater-inbox/store.js";
import { useDesktopRailEntries, type RailEntryBinding } from "../../../../core/client/src/chrome/pane/pane-registry.js";
import { SETTINGS_RAIL_ENTRY_ID } from "../../../settings/client/settings-entry.js";
import { operationAvatarKey, theaterAvatarKey, type MongleActivity, type MongleState } from "@fleet-console/sdk/avatars";
import { AvatarEditor, KeyedAvatar, OperationAvatar, operationAvatarRole, operationMongleState } from "../avatars.js";
import { pluginRuntimeState } from "../../../execution/client/operation-activity.js";
import { CONVERSATION_MEMBERS_TAB_ID } from "../../../execution/client/agent/chat/group/index.js";
import { BROWSER_COMPANION_ID } from "../../../execution/client/agent/browser-companion.js";
import { closeGlobalBrowser, globalBrowserUnseenLabel, publishOperationBrowserTarget, requestBrowserChooser, useGlobalBrowserOpen, useGlobalBrowserUnseenTabs } from "../../../browser/client/global-browser-store.js";
import { resolveSessionBrowserTarget, SessionBrowserCaption, SessionBrowserPanel } from "../../../browser/client/browser-panel.js";
import { announceNativeViewResize, getNativeViewResize, useBrowserEngine } from "../../../browser/client/browser-panel-store.js";
import { getT as getBrowserT } from "../../../browser/client/i18n.js";
import { CaptionActionButton, CaptionBrowserUseGlyph } from "@fleet-console/sdk/components/caption-actions";
import { subscribeConsoleChannel } from "../../../../core/client/src/integration/operations-sse.js";
import { isDesktopShell } from "../../../../core/client/src/integration/desktop-shell.js";
import { closeOperationBrowserSplit, closeSessionBrowserSplit, openOperationBrowserSplit, openSessionBrowserSplit, setConversationSplitWidth, useConversationSplitWidth, useOperationBrowserSplit, useSessionBrowserSplit } from "./conversation-split-store.js";
import { setChatReadingWidthDefault } from "../../../execution/client/terminal/shared/terminal-preferences.js";
import { OperationCaptionContributions } from "../operation-contributions.js";
import { useClusterIndex, useOperationClusters } from "../operation-clusters.js";
import { PluginOperationRenderer } from "../operation-renderer.js";
import { publishConversationClusters, publishConversationStandIn, publishConversationSubject, useConversationBodyRenderer, useConversationCaptionRenderer, useConversationOperationRename, useConversationStandIn, useConversationStandInComposer, useConversationSubject } from "./conversation-slots.js";
import { useInlineRename } from "../../../../core/client/src/integration/use-inline-rename.js";
import { closeConversationSurface, useConversationSurface, type ConversationSurfaceSelection } from "./conversation-surface-store.js";
import "./conversation.css";

/**
 * 데스크톱 Operations 셸 — 왼쪽 사이드바, 가운데 대화, 오른쪽 세부 정보 패널의 세 칸이다.
 * 본문 geometry는 칸의 실측이고, 이전 패널 좌표 저장은 변경하지 않는다.
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
  // 이 화면의 채팅은 가운데 칸 폭에 맞춘다(Fit) — 사람이 「채팅 폭」을 직접 골랐으면 그 값이 그대로 선다. 셸이 걷히면 기본 읽기 폭으로 돌아간다.
  useEffect(() => setChatReadingWidthDefault("full"), []);
  // 마지막으로 연 오른쪽 패널을 기억한다 — 헤더 pill 이 다시 열 때 쓴다(설정은 문으로만 연다).
  const activePanelId = useRailActivePanelId();
  useEffect(() => {
    if (activePanelId !== null && activePanelId !== SETTINGS_RAIL_ENTRY_ID) writeLastPanel(activePanelId);
  }, [activePanelId]);
  return null;
}

/** 패널 머리 탭 줄 맨 앞에 서는 대화 도구(목표) — Operation 대화에서 패널이 처음 보이는 탭이다. 없으면 null. */
function firstConversationTab(bindings: readonly RailEntryBinding[]): RailEntryBinding | null {
  return bindings.find((binding) => !binding.core && binding.panes.length > 0 && isConversationTab(binding.entry) && binding.entry.visible?.() !== false) ?? null;
}

/**
 * 오른쪽 패널을 여닫는다 — 열린 것이 있으면 닫고, 없으면 연다. Operation 대화는 탭 줄 맨 앞의 대화 도구(목표)를 먼저 연다.
 * 그 밖(플러그인 대화·Theater, 목표 도구가 없는 Console)은 마지막 패널(없으면 앞 묶음 첫 탭, 그것도 없으면 첫 도구)을 연다.
 */
function useToggleDetails(operationConversation: boolean): () => void {
  const bindings = useDesktopRailEntries();
  return useCallback(() => {
    const active = getRailStoreSnapshot().activePanelId;
    if (active !== null) {
      closeRailPanel(active);
      return;
    }
    const lead = operationConversation ? firstConversationTab(bindings) : null;
    if (lead) {
      openRailPanel(lead.entry.id);
      return;
    }
    const panes = bindings.filter((binding) => binding.panes.length > 0 && binding.entry.id !== SETTINGS_RAIL_ENTRY_ID && binding.entry.visible?.() !== false);
    const last = readLastPanel();
    const target = panes.find((binding) => binding.entry.id === last) ?? panes.find((binding) => binding.core) ?? panes[0];
    if (target) openRailPanel(target.entry.id);
  }, [bindings, operationConversation]);
}

/**
 * 가운데 칸의 대상이 Operation(아직 서지 않은 Operation 을 대신하는 시작 전 목표 포함)으로 바뀌면(Operation 을 고르거나 사령관 같은
 * 플러그인 대화가 걷히면) 오른쪽 패널의 열림/닫힘을 잇는다.
 * 닫혀 있었으면 열지 않는다. 열려 있었고 앞 대상의 탭(구성원·사령관 탭·Theater 설정)을 보이던 중이면 탭 줄 맨 앞의 목표로 돌린다 —
 * 그 탭이 대상과 함께 걷히며 패널을 이미 닫았어도(대화 칸의 cleanup 은 이 effect 보다 먼저 돈다) 다시 연다. Theater 를 연 채 대상이
 * 바뀌면 Theater 는 곧 걷히므로 그 경우도 Operation 대화로 다룬다. 대상의 탭이 아닌 패널(설정, 목표 등 도구)과 목표 도구가 없는
 * 경우는 그대로 둔다.
 */
function usePanelFollowsSubject(subjectId: string | null): void {
  const bindings = useDesktopRailEntries();
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  // 대상이 바뀌는 렌더는 앞 대상의 탭이 걷히기(cleanup) 전에 돈다 — 이 렌더가 읽은 것이 바뀌기 직전 패널의 열림이다. 등록 목록에
  // 없는 id(내려간 플러그인)는 레일이 그리지 않으므로 닫힌 것이다.
  const openBeforeRef = useRef(false);
  const activeAtRender = getRailStoreSnapshot().activePanelId;
  openBeforeRef.current = activeAtRender !== null && bindings.some((binding) => binding.entry.id === activeAtRender && binding.panes.length > 0);
  useEffect(() => {
    if (subjectId === null || !openBeforeRef.current) return;
    const current = bindingsRef.current;
    const active = getRailStoreSnapshot().activePanelId;
    if (active === SETTINGS_RAIL_ENTRY_ID) return;
    const activeBinding = active === null ? null : current.find((binding) => binding.entry.id === active) ?? null;
    if (activeBinding !== null && !activeBinding.core) return;
    const lead = firstConversationTab(current);
    if (lead) openRailPanel(lead.entry.id);
  }, [subjectId]);
}

// ── 사이드바 위·아래 줄 ────────────────────────────────────────────────────

const SearchGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10.4 10.4 13.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
);
const PlusGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);

/**
 * 사이드바 맨 위 줄 오른쪽 — 찾기(⌘K)와 새 Theater(폴더 고르기). 보기·정렬·접기 단추와 한 줄, 같은 원형 문법이다. 목록 안의 「+」가
 * 모두 무엇을 더하는 입구라 맨 위 「+」도 가장 바깥 단위(Theater)를 더한다. 새 Operation 은 Theater 머리 「+」·팔레트·Quick Launch 단축키다.
 */
export function ConversationSideBarActions() {
  const t = useT();
  // 폴더 대화상자가 Theater 를 더하는 동안은 다시 열지 않는다.
  const { addingTheater } = useConsoleState();
  return (
    <span className="conversation-side-actions">
      <button type="button" className="conversation-round" onClick={toggleOperationSearch} aria-label={t("conversation.side.search")} title={t("conversation.side.search")}>
        <SearchGlyph />
      </button>
      <button type="button" className="conversation-round" onClick={requestSideBarAddTheater} disabled={addingTheater} aria-label={t("conversation.side.newTheater")} title={t("conversation.side.newTheater")}>
        <PlusGlyph />
      </button>
    </span>
  );
}


/**
 * 오른쪽 패널 머리 — 대상의 글자 탭(구성원, 사령관의 행위 기록·지시·정보·설정)만 선다. 작전구역 도구 글리프는 이 머리가 아니라
 * 가운데 대화 머리 줄의 공통 도구모음(ConversationToolbar)에 선다.
 */
export function ConversationPanelHeader({ context }: { readonly context: RailToolContext }) {
  const t = useT();
  const sections = usePanelSections();
  // Operation 대화의 패널은 대화에서 곧장 이어 가는 도구(conversationTab, 목표)를 대상의 글자 탭 앞에 같은 글자 단추로 세운다.
  // Theater 를 연 패널(사령관·Theater 설정)에는 서지 않는다. 아직 서지 않은 Operation 을 대신하는 플러그인 대화(시작 전 목표)도
  // Operation 대화와 같은 머리다.
  const subject = useConversationSubject();
  const standIn = useConversationStandIn();
  const inbox = useTheaterInboxState();
  const operationConversation = (subject !== null || standIn !== null) && inbox === null;
  // 하위 탭을 내는 도구(목표)가 「구성원」을 대신하면 대상의 구성원 탭은 서지 않는다 — 그 자리에 도구의 구성원 탭이 선다.
  const bindings = useDesktopRailEntries();
  const activePanelId = useRailActivePanelId();
  const tabsEntry = operationConversation
    ? bindings.find((binding) => !binding.core && binding.entry.conversationTab === true && binding.entry.conversationTabs !== undefined && binding.entry.visible?.() !== false)?.entry ?? null
    : null;
  const tabsTheaterId = tabsEntry?.scope === "fleet" ? null : context.theaterId;
  const tabsState = useConversationTabsState(tabsEntry?.conversationTabs, tabsTheaterId);
  const membersStandIn = tabsState?.tabs.find((tab) => tab.replacesMembers === true) ?? null;
  const coreFilter = membersStandIn === null
    ? sections.filter
    : (entryId: string) => entryId !== CONVERSATION_MEMBERS_TAB_ID && (sections.filter?.(entryId) ?? true);
  // 걷힌 구성원 탭이 켜져 있었으면(대화를 옮기기 전에 열어 둔 것) 대신하는 탭으로 옮긴다.
  useEffect(() => {
    if (tabsEntry === null || membersStandIn === null || activePanelId !== CONVERSATION_MEMBERS_TAB_ID) return;
    openConversationTab(tabsEntry, context, membersStandIn.id, false);
  }, [tabsEntry, membersStandIn, activePanelId, context]);
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
      // 「⋯」는 줄 바깥(오른쪽 형제)에 서므로 줄이 그만큼 좁아지면 다시 잰다 — 따로 자리를 남기지 않는다.
      const rowLeft = row.getBoundingClientRect().left;
      const hidden: OverflowTab[] = [];
      for (const group of row.children) {
        if (!(group instanceof HTMLElement)) continue;
        const items = [...group.querySelectorAll<HTMLElement>(".right-rail-ico, .right-rail-divider")];
        if (items.every((item) => item.getBoundingClientRect().right - rowLeft <= row.clientWidth)) continue;
        const limit = row.clientWidth;
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
      {/* 하위 탭을 내는 도구(목표)의 도구 줄 — 오늘·기한이 섹션 줄 자리(탭 줄 위)에 선다. 섹션 줄은 Theater 를 연 동안에만, 이 줄은
          Operation 대화에서만 서므로 둘이 겹치지 않는다. 도구가 아무것도 그리지 않으면 줄도 남지 않는다(:empty). */}
      {tabsEntry?.conversationTabs?.renderTools && tabsState !== null ? (
        <div className="conversation-panel-sections is-tools">{tabsEntry.conversationTabs.renderTools({ theaterId: tabsTheaterId, language: context.language })}</div>
      ) : null}
      {/* 이름 아래 한 줄 — 대상의 글자 탭(구성원, 사령관의 행위 기록·지시·정보·설정)이 Grok 세그먼트처럼 한 줄에 선다.
          켜진 것은 둥근 면 하나로 말한다. 넘치는 탭은 줄 끝 「⋯」 메뉴에 모인다. */}
      <div className="conversation-panel-segments">
        <div className="conversation-panel-segment-row" ref={rowRef}>
          <span className="conversation-panel-tabs">
            {/* Operation 대화에서는 대화에서 곧장 이어 가는 도구(목표)가 대상의 탭(구성원)보다 앞에 선다 — 「목표 | 구성원」. */}
            {operationConversation ? <RailToolIcons context={context} variant="text" scope="tools" toolFilter={isConversationTab} /> : null}
            <RailToolIcons context={context} variant="text" scope="core" {...(coreFilter ? { coreFilter } : {})} />
          </span>
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

/**
 * 패널 머리의 이름 — 고칠 수 있으면 쉴 때 hover 에 은은한 둥근 배경이 서고, 누르면 같은 자리·같은 글꼴로 캐럿 편집이 열린다.
 * Enter 확정·Esc 취소·blur 확정은 사이드바 칩과 같은 `useInlineRename` 관례다. 비었거나 그대로인 이름은 보내지 않는다.
 */
function PanelIdentityName({ title, onRename }: { readonly title: string; readonly onRename?: ((title: string) => void) | undefined }) {
  const t = useT();
  const rename = useInlineRename({
    currentTitle: title,
    onCommit: (next) => {
      const trimmed = next.trim();
      if (onRename && trimmed && trimmed !== title) onRename(trimmed);
    },
  });
  if (!onRename) return <strong className="conversation-panel-identity-name">{title}</strong>;
  if (rename.renaming) {
    return (
      <input
        className="conversation-panel-identity-name conversation-panel-identity-input"
        ref={rename.inputRef}
        value={rename.draftTitle}
        aria-label={t("sidebar.chip.renameAria", { title })}
        onChange={(e) => rename.setDraftTitle(e.target.value)}
        onKeyDown={rename.handleKeyDown}
        onBlur={rename.handleBlur}
      />
    );
  }
  return (
    <strong className="conversation-panel-identity-name">
      <button type="button" className="conversation-panel-identity-edit" title={t("sidebar.chip.renameAria", { title })} onClick={rename.begin}>{title}</button>
    </strong>
  );
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
  const renameOperation = useConversationOperationRename();
  useConversationSurfaceHead(centerSurface);
  // Theater 를 연 동안 패널은 그 Theater 의 것이다 — Theater 의 몽글 아바타는 그 사령관이다(사이드바 Theater 머리 표식과 같은 얼굴).
  // 가운데 칸에 그 Theater 를 대신하는 대화(사령관)가 서 있으면 이름은 그 대화의 이름이다 — 패널을 어느 길로 열든 머리가 같다.
  if (inbox !== null && theaterLabel !== null) {
    const context = centerSurface !== null && surface !== null
      ? { params: surface.params, language, theme: state.activeTheme, close: () => closeConversationSurface(centerSurface.id) } as const
      : null;
    let owner: { readonly title: string; readonly label: string; readonly state: MongleState; readonly activity: MongleActivity | null } | null = null;
    try {
      if (centerSurface !== null && context !== null && centerSurface.theater?.(context)?.theaterId === inbox.theaterId) {
        const avatar = centerSurface.avatar?.(context) ?? null;
        owner = { title: centerSurface.title(context), label: avatar?.label ?? centerSurface.title(context), state: avatar?.state ?? "idle", activity: avatar?.activity ?? null };
      }
    } catch { owner = null; }
    return (
      <div className="conversation-panel-identity">
        <AvatarEditor avatarKey={theaterAvatarKey(inbox.theaterId)} role="commodore" state={owner?.state ?? "idle"} activity={owner?.activity ?? null} size={64} label={owner?.label ?? theaterLabel} />
        <strong className="conversation-panel-identity-name">{owner?.title ?? theaterLabel}</strong>
      </div>
    );
  }
  if (subject !== null) {
    // 대상의 몽글 아바타(64px) — 이 화면에서만 눌러 고친다. 일반 화면에는 이 자리도 편집 진입도 없다.
    return (
      <div className="conversation-panel-identity">
        <AvatarEditor avatarKey={operationAvatarKey(subject.id)} role={operationAvatarRole(subject)} state={operationMongleState(subject.id, state, clusterIndex.clusters)} activityOperationId={subject.id} size={64} label={subject.title} />
        <PanelIdentityName title={subject.title} onRename={renameOperation ? (next) => renameOperation(subject.id, next) : undefined} />
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

/** 머리 pill 이름의 하한 — 도구가 모두 「⋯」로 걷힌 다음에야 이름이 이 폭까지 줄어든다(이름이 더 짧으면 그 폭). */
const TITLE_FLOOR = 120;
/** 머리 pill 부제(「· 구성원 n」 등)의 하한 — 줄이 모자라면 부제가 가장 먼저 이 폭까지 말줄임으로 줄어든다. */
const SUB_FLOOR = 28;
/** 머리 pill 의 폭 상한(conversation.css `.conversation-pill` max-width) — 이 상한 때문에 잘린 이름은 자리 부족이 아니다. */
const PILL_TITLE_CAP = 620;

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
  readonly insets: ArenaInsets;
  readonly language: "en" | "ko";
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly onClose: (operationId: string) => void;
  /** 머리 줄 공통 도구모음의 문맥 — 보이는 대화의 Theater(useViewedTheaterId)로 만든다. 오른쪽 패널 본문과 같은 Theater 다. */
  readonly toolContext: RailToolContext;
}

/**
 * 가운데 칸의 대상 — 활성 Operation. 활성이 풀려도(크롬을 눌러도) 방금 보던 대화는 남긴다. 처음 열었을 때처럼 본 것이 없으면
 * 그 작전구역에서 가장 최근에 움직인 대화를 보인다 — 빈 칸보다 이어서 볼 대화가 먼저다.
 */
function useStageSubject(state: ConsoleState): OperationNode | null {
  const lastRef = useRef<string | null>(null);
  const operationOf = (id: string | null) => id === null ? null : state.operations.find((operation) => operation.id === id) ?? null;
  const active = operationOf(state.activeOperationId);
  const latest = () => state.operations
    .reduce<OperationNode | null>((best, operation) => (best === null || operation.ts.updatedAt > best.ts.updatedAt ? operation : best), null);
  const subject = active ?? operationOf(lastRef.current) ?? latest();
  lastRef.current = subject?.id ?? null;
  return subject;
}

export function ConversationStage({ state, insets, language, operationKinds, onClose, toolContext }: ConversationStageProps) {
  const t = useT();
  const quickLaunchShortcut = useQuickLaunchShortcutLabel();
  const subject = useStageSubject(state);
  // 플러그인 대화(사령관 등)가 가운데 칸을 가지면 Operation 대신 선다.
  const surface = useConversationSurface();
  const { conversationSurfaces } = usePluginRegistry();
  const surfaceDescriptor = surface === null ? null : conversationSurfaces.find((descriptor) => descriptor.id === surface.surfaceId) ?? null;
  useEffect(() => { publishConversationSubject(surfaceDescriptor ? null : subject); }, [subject, surfaceDescriptor]);
  // 플러그인 대화가 아직 서지 않은 Operation 을 대신하면(시작 전 목표) 오른쪽 패널이 그 Operation 대화처럼 선다 — 머리와 「구성원」 탭이 읽는다.
  let standInId: string | null = null;
  if (surfaceDescriptor?.standInOperationId && surface) {
    try {
      standInId = surfaceDescriptor.standInOperationId({ params: surface.params, language, theme: state.activeTheme, close: () => closeConversationSurface(surfaceDescriptor.id) });
    } catch {
      standInId = null;
    }
  }
  useEffect(() => { publishConversationStandIn(standInId); }, [standInId]);
  // 플러그인 대화의 에이전트 세션이 Session 브라우저를 쓰면(사령관) 머리 지구본과 분할 칸이 그 세션의 scope 로 브라우저를 찾는다.
  // 플러그인 id 는 호스트가 붙인 등록 id 다 — 대화가 다른 플러그인의 scope 를 가리킬 수 없다.
  let sessionScopeId: string | null = null;
  if (surfaceDescriptor?.sessionBrowser && surfaceDescriptor.pluginId && surface) {
    try {
      const scope = surfaceDescriptor.sessionBrowser({ params: surface.params, language, theme: state.activeTheme, close: () => closeConversationSurface(surfaceDescriptor.id) });
      sessionScopeId = scope !== null && typeof scope.scopeId === "string" && scope.scopeId !== "" ? scope.scopeId : null;
    } catch {
      sessionScopeId = null;
    }
  }
  const sessionPluginId = sessionScopeId === null ? null : surfaceDescriptor?.pluginId ?? null;
  const sessionSubjectKey = sessionPluginId === null || sessionScopeId === null ? null : `${sessionPluginId}:${sessionScopeId}`;
  // 가운데 칸에 선 대화가 곧 활성 Operation 이다 — 사이드바 줄이 칩과 같은 선택 표시(테두리 + 면)를 받고, 도착 표식도
  // 보고 있는 대화만큼 정리된다. 크롬을 눌러 활성이 풀려도 칸의 대화는 그대로이므로 다시 활성으로 세운다.
  const activeOperationId = state.activeOperationId;
  useEffect(() => {
    // 플러그인 대화가 선 동안에는 어느 Operation 도 칸에 없다 — 사이드바의 Operation 줄 선택을 걷는다(대화를 걷으면 되돌아온다).
    if (surfaceDescriptor !== null) {
      if (activeOperationId !== null) setActiveOperation(null);
      return;
    }
    if (subject === null || activeOperationId === subject.id) return;
    setActiveOperation(subject.id);
  }, [activeOperationId, subject, surfaceDescriptor]);
  useEffect(() => () => { publishConversationSubject(null); publishConversationStandIn(null); }, []);
  // 구성원 탭의 아바타가 같은 묶음 사실(검토 대기·결정 요청·임무 완료)로 얼굴을 고르게 묶음을 내건다.
  const operationClusters = useOperationClusters();
  useEffect(() => { publishConversationClusters(operationClusters); }, [operationClusters]);
  const stageInbox = useTheaterInboxState();
  // 아직 서지 않은 Operation 을 대신하는 플러그인 대화(시작 전 목표)도 Operation 대화처럼 「목표」가 먼저다.
  const operationConversation = (surfaceDescriptor === null ? subject !== null : standInId !== null) && stageInbox === null;
  const toggleDetails = useToggleDetails(operationConversation);
  usePanelFollowsSubject(surfaceDescriptor ? standInId : subject?.id ?? null);

  // ── 오른쪽 분할 — 브라우저는 대화 열 오른쪽 칸에 선다 ──
  // Fleet 브라우저(전역 시트)가 열렸거나, 이 대화의 Session 브라우저를 골랐으면 대화 열이 폭을 내주고 그 자리에 칸이 펼쳐진다.
  // 대화 열(right)과 칸(width)은 같은 전이(--duration-base · --ease-spring)로 함께 움직인다. Fleet 브라우저 시트는 그 칸의
  // 사각형에 앉고(global-browser-sheet.tsx), Session 브라우저(Operation 의 companion 이든 플러그인 세션의 것이든)는 칸 안에 그린다.
  const fleetBrowserOpen = useGlobalBrowserOpen();
  const operationSplit = useOperationBrowserSplit();
  const sessionSplit = useSessionBrowserSplit();
  const desktop = isDesktopShell();
  const splitSubjectId = surfaceDescriptor ? null : subject?.id ?? null;
  const splitKind: SplitKind | null = desktop && fleetBrowserOpen
    ? "fleet"
    : operationSplit !== null && operationSplit.subjectId === splitSubjectId ? "operation"
      : sessionSplit !== null && sessionSplit.subjectKey === sessionSubjectKey ? "session" : null;
  // Fleet 브라우저가 열리면 Session 브라우저 칸은 걷힌다 — 칸은 브라우저 하나만 싣는다. 대상이 바뀌어도 걷는다.
  useEffect(() => { if (fleetBrowserOpen) { closeOperationBrowserSplit(); closeSessionBrowserSplit(); } }, [fleetBrowserOpen]);
  useEffect(() => {
    if (operationSplit !== null && operationSplit.subjectId !== splitSubjectId) closeOperationBrowserSplit();
  }, [operationSplit, splitSubjectId]);
  useEffect(() => {
    if (sessionSplit !== null && sessionSplit.subjectKey !== sessionSubjectKey) closeSessionBrowserSplit();
  }, [sessionSplit, sessionSubjectKey]);
  const viewportWidth = useViewportWidth();
  const preferredSplitWidth = useConversationSplitWidth();
  // 경계를 끄는 동안 대화 칸과 브라우저 칸은 전이 없이 포인터를 바로 따라간다.
  const [splitResizing, setSplitResizing] = useState(false);
  const seat = splitKind === null ? null : resolveSplitSeat(viewportWidth, insets, preferredSplitWidth);
  const splitOperation = splitKind === "operation" && operationSplit !== null
    ? state.operations.find((candidate) => candidate.id === operationSplit.operationId)
      ?? state.nestedOperations.find((candidate) => candidate.id === operationSplit.operationId)
      ?? null
    : null;

  // 가운데 칸 어느 대화(사령관·지휘관·일반 Operation·빈 칸)든 머리 줄 대화 동작 오른쪽에 같은 공통 도구모음이 선다.
  const tools = <ConversationToolbar context={toolContext} />;

  return (
    <>
    <section
      className={`conversation-stage${splitResizing ? " is-split-resizing" : ""}`}
      // 세 열은 창 높이 전체를 쓰고 서로 붙는다 — 사이드바·레일의 실제 폭이 곧 이 칸의 좌우다. 브라우저 칸이 서면 그 폭만큼 더 비킨다.
      style={{ left: insets.left, right: seat?.stageRight ?? insets.right }}
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
          tools={tools}
          sessionBrowser={sessionPluginId !== null && sessionScopeId !== null && sessionSubjectKey !== null ? { pluginId: sessionPluginId, scopeId: sessionScopeId, subjectKey: sessionSubjectKey } : null}
          browserSplitOpen={splitKind !== null}
        />
      ) : subject ? (
        <ConversationColumn
          key={subject.id}
          state={state}
          operation={subject}
          language={language}
          operationKinds={operationKinds}
          onToggleDetails={toggleDetails}
          onClose={onClose}
          browserSplitOpen={splitKind !== null}
          tools={tools}
        />
      ) : (
        // 빈 칸에도 같은 머리 줄 도구모음이 선다 — Theater 가 없으면 Theater 도구는 비활성이고 Console 도구(Shell·스킬)만 눌린다.
        <div className="conversation-column">
          <div className="conversation-pill-row">{tools}</div>
          <div className="conversation-empty">
            <strong>{t("conversation.empty.title")}</strong>
            <span>{t("conversation.empty.body", { shortcut: quickLaunchShortcut })}</span>
          </div>
        </div>
      )}
    </section>
    <ConversationSplit
      kind={seat === null ? null : splitKind}
      seat={seat}
      fallbackRight={insets.right}
      operation={splitOperation}
      sessionOwnerId={splitKind === "session" ? sessionSplit?.ownerId ?? null : null}
      state={state}
      language={language}
      operationKinds={operationKinds}
      resizing={splitResizing}
      onResizingChange={setSplitResizing}
    />
    </>
  );
}

/**
 * 사용량(Quota 등 밴드 요약) — 가운데 칸 맨 위 줄의 오른쪽 끝에 떠 있는 캡슐 하나다. 대상 Operation 이 아니라 계정 전역의 신호라
 * pill(대상의 이름)·단추 묶음(대상의 동작)과 붙이지 않고, Operation·플러그인 대화·빈 칸 어디서나 같은 자리에 선다.
 * 칸 폭이 줄면 단계를 낮춘다(전체 → 표식만 → 첫 칸 하나, conversation.css·quota.css 의 컨테이너 질의). 누르면 지금처럼 요약 팝업이 열린다.
 */
function ConversationQuota() {
  const t = useT();
  const { commandBandEntries: usage } = usePluginRegistry();
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
      // 예약은 올림한 정수 폭이다 — 판정도 그 폭으로 해야 줄이 1~2px 모자라 이름이 말줄임되는 경계가 생기지 않는다.
      const space = (candidate: QuotaTier) => Math.ceil(widths[candidate] + right + QUOTA_PILL_GAP);
      // 가운데 묶음의 원래 폭은 정수 폭의 합이라 실제보다 1px 남짓 작을 수 있다 — 그만큼 여유를 둔다.
      const half = (stage.getBoundingClientRect().width - center) / 2 - QUOTA_ROUNDING_SLACK;
      const tier: QuotaTier = space("full") <= half ? "full" : space("marks") <= half ? "marks" : "single";
      box.dataset.tier = tier;
      stage.style.setProperty("--conversation-quota-space", `${space(tier)}px`);
    };
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(measure); };
    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(stage);
    for (const child of box.children) resize?.observe(child);
    // 대상·이름·사용량·도구모음 원래 폭 변경만 다시 잰다. 본문 글자 조각은 캡슐 자리와 무관하고 tier 측정의 강제 배치를 부르지 않는다.
    // 머리 줄 자체가 교체되는 전환도 감지하되 이 캡슐이 다는 data-tier 는 관찰하지 않는다.
    const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver((records) => {
      if (records.some(({ target, addedNodes, removedNodes }) => {
        const element = target instanceof Element ? target : target.parentElement;
        if (element?.closest(".conversation-quota, .conversation-pill-row")) return true;
        return [...addedNodes, ...removedNodes].some((node) => node instanceof Element
          && (node.matches(".conversation-pill-row") || node.querySelector(".conversation-pill-row") !== null));
      })) schedule();
    });
    mutation?.observe(stage, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-natural-width"] });
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

function PluginEntry({ render }: { readonly render: () => ReactNode }) {
  return <>{render()}</>;
}

type QuotaTier = "full" | "marks" | "single";
/** 사용량 캡슐과 pill 묶음 사이의 최소 틈. */
const QUOTA_PILL_GAP = 12;
/** 정수 폭으로 센 가운데 묶음의 원래 폭이 실제보다 작을 수 있는 몫 — 사용량 단계 판정에 남기는 여유. */
const QUOTA_ROUNDING_SLACK = 2;

/**
 * pill 줄 가운데 묶음(이름 pill·다음·단추 묶음)의 원래 폭 — 이름이 말줄임으로 줄어든 만큼을 되돌려 센다(최대 620).
 * 대화 열의 줄만 잰다 — 확대 표면 머리(접힌 칩 포함)도 칸에 portal 된 같은 이름의 줄이고, 대화 열이 다시 서면(대상 전환) DOM 순서가
 * 그 뒤로 밀려 첫 줄이 표면 머리가 된다.
 */
function pillGroupNaturalWidth(stage: HTMLElement): number {
  const row = stage.querySelector<HTMLElement>(":scope > .conversation-column > .conversation-pill-row");
  return row === null ? 0 : pillRowNaturalWidth(row);
}

/**
 * pill 줄 한 줄의 원래 폭. 공통 도구모음은 「⋯」로 걷힌 도구까지 센 폭(data-natural-width, ConversationToolbar 가 잰다)으로
 * 센다 — 사용량 캡슐이 먼저 단계를 낮추고, 그래도 모자랄 때 도구가 걷힌다.
 */
function pillRowNaturalWidth(row: HTMLElement): number {
  const items = [...row.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
  const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
  let total = Math.max(0, items.length - 1) * gap;
  for (const item of items) {
    if (item.classList.contains("conversation-pill")) {
      // 말줄임으로 줄어든 이름·부제의 몫을 되돌려 센다.
      let natural = item.offsetWidth;
      for (const text of item.querySelectorAll<HTMLElement>(".conversation-pill-title, .conversation-pill-sub")) natural += text.scrollWidth - text.clientWidth;
      total += Math.min(natural, PILL_TITLE_CAP);
    } else if (item.classList.contains("conversation-pill-tools")) {
      total += Number.parseFloat(item.dataset.naturalWidth ?? "") || item.offsetWidth;
    } else {
      total += item.offsetWidth;
    }
  }
  return total;
}

/**
 * 공통 도구모음에 서는 도구 — 대화에서 곧장 이어 가는 도구(conversationTab, 목표)는 Operation 대화의 오른쪽 패널 글자 탭이
 * 맡으므로 뺀다. 그래서 사령관·지휘관·일반 Operation 대화·빈 칸의 도구 집합이 같다.
 */
function isCommonTool(entry: RailEntryDescriptor): boolean {
  return entry.conversationTab !== true;
}

interface HiddenTool {
  readonly entryId: string;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly element: HTMLButtonElement;
}

function sameHiddenTools(a: readonly HiddenTool[], b: readonly HiddenTool[]): boolean {
  return a.length === b.length && a.every((tool, index) => tool.element === b[index]!.element && tool.active === b[index]!.active && tool.disabled === b[index]!.disabled);
}

/**
 * 가운데 대화 머리 줄의 공통 도구모음 — 대화 동작 오른쪽에 선다. 순서·켜짐·배지·말풍선·단축키 표기는 레일 도구(RailToolIcons ·
 * RailIcon) 그대로이고, Theater 도구 → 구분선 → Console 도구다. 문맥은 보이는 대화의 Theater 라 도구를 누르면 그 Theater 로 열린다.
 * 줄은 한 줄이다: 자리가 모자라면(사용량 캡슐이 먼저 단계를 낮춘 뒤) 오른쪽 끝 도구부터 걷어 「⋯」 메뉴에 모은다. 이름 pill 은
 * 도구가 모두 걷힌 다음에야 말줄임이 시작되고, 대화 동작은 걷히지 않는다.
 */
function ConversationToolbar({ context }: { readonly context: RailToolContext }) {
  const t = useT();
  const toolsRef = useRef<HTMLSpanElement | null>(null);
  const itemsRef = useRef<HTMLSpanElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [hidden, setHidden] = useState<readonly HiddenTool[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const bindings = useDesktopRailEntries();
  useLayoutEffect(() => {
    const tools = toolsRef.current;
    const itemsBox = itemsRef.current;
    const row = tools?.closest<HTMLElement>(".conversation-pill-row") ?? null;
    if (!tools || !itemsBox || !row) return;
    let frame = 0;
    // 줄이 넘치지 않고, 이름이 자리 때문에(620px 상한 때문이 아니라) 잘리지 않으면 들어간 것이다. 실제 배치를 읽는다 — 원래 폭을
    // 셈으로만 맞추면 글꼴이 늦게 와 이름이 길어지는 것처럼 셈 밖의 변화에 이름이 먼저 잘린다.
    // 정수로 반올림한 clientWidth·scrollWidth 는 1px 밑의 말줄임을 놓친다 — 이름은 글자 범위의 실제 폭과, 줄은 상자의 실제 폭과 견준다.
    const range = typeof document === "undefined" ? null : document.createRange();
    const fits = (pill: HTMLElement | null, title: HTMLElement | null) => {
      if (title !== null && pill !== null && range !== null && pill.getBoundingClientRect().width < PILL_TITLE_CAP - 0.5) {
        range.selectNodeContents(title);
        if (range.getBoundingClientRect().width > title.getBoundingClientRect().width + 0.01) return false;
      }
      // pill 안 내용이 pill 상자 밖으로 흐르면 들어가지 않은 것이다(마지막 내용의 오른쪽 끝 ≤ 상자 안쪽 오른쪽 끝).
      if (pill !== null) {
        const inner = [...pill.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.getClientRects().length > 0);
        const last = inner[inner.length - 1];
        const pillRect = pill.getBoundingClientRect();
        const padRight = Number.parseFloat(getComputedStyle(pill).paddingRight) || 0;
        if (last !== undefined && last.getBoundingClientRect().right > pillRect.right - padRight + 0.01) return false;
      }
      const children = [...row.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.offsetWidth > 0);
      if (children.length === 0) return true;
      const style = getComputedStyle(row);
      const content = row.getBoundingClientRect().width - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
      const extent = children[children.length - 1]!.getBoundingClientRect().right - children[0]!.getBoundingClientRect().left;
      return extent <= content + 0.01;
    };
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(measure); };
    // 줄 폭(칸 폭·사용량 캡슐 예약)뿐 아니라 줄 안 요소의 폭도 본다 — 글꼴·컨테이너 질의·인라인 스타일처럼 줄 크기나 관찰하는 속성을
    // 바꾸지 않고 이름·대화 동작의 폭만 바꾸는 변화에도 이름이 먼저 잘리지 않게. 같은 대상을 다시 observe 해도 하나로 친다.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const measure = () => {
      frame = 0;
      const items = [...itemsBox.querySelectorAll<HTMLElement>(".right-rail-ico, .right-rail-divider")];
      for (const item of items) item.removeAttribute("data-overflow");
      tools.dataset.more = "hidden";
      if (resize !== null) {
        resize.observe(row);
        // 테두리 상자로 본다 — 내용 상자만 보면 안쪽 여백·테두리만 바뀐 요소의 폭 변화를 놓친다.
        for (const child of row.children) if (child !== tools) resize.observe(child, { box: "border-box" });
        const titleElement = row.querySelector(":scope > .conversation-pill .conversation-pill-title");
        if (titleElement !== null) resize.observe(titleElement);
      }
      // 줄이 모자랄 때 줄어드는 순서 — 부제(「· 구성원 n」 등)가 먼저 말줄임으로 SUB_FLOOR 까지, 그다음 도구가 「⋯」로, 마지막에
      // 이름이 TITLE_FLOOR(이름이 그보다 짧으면 그 폭)까지. 도구가 남아 있는 동안 이름은 원래 폭에 묶어 둔다. pill 내용이 상자 밖으로
      // 흐르면(부제·이름이 하한에 닿은 뒤) 들어가지 않은 것으로 보고 도구를 더 걷는다(fits).
      const pill = row.querySelector<HTMLElement>(":scope > .conversation-pill");
      const title = pill?.querySelector<HTMLElement>(".conversation-pill-title") ?? null;
      const textWidth = (element: HTMLElement) => {
        element.style.minWidth = "";
        if (range === null) return element.scrollWidth;
        range.selectNodeContents(element);
        return range.getBoundingClientRect().width;
      };
      for (const sub of pill?.querySelectorAll<HTMLElement>(".conversation-pill-sub") ?? []) {
        sub.style.minWidth = `${Math.min(SUB_FLOOR, Math.ceil(textWidth(sub)))}px`;
      }
      // 묶는 폭은 pill 상한(620px) 안이다 — 상한보다 긴 이름은 상한 때문에 말줄임되는 것이 맞다.
      const titleNatural = title === null || pill === null ? 0
        : Math.min(Math.ceil(textWidth(title)), Math.max(TITLE_FLOOR, Math.floor(PILL_TITLE_CAP - (pill.getBoundingClientRect().width - title.getBoundingClientRect().width))));
      if (title !== null) title.style.minWidth = `${titleNatural}px`;
      // 모두 세운 폭(「⋯」 없이) — 사용량 캡슐이 이 값으로 자기 단계를 먼저 고른다(pillRowNaturalWidth).
      const natural = tools.offsetWidth;
      if (tools.dataset.naturalWidth !== String(natural)) tools.dataset.naturalWidth = String(natural);
      const next: HiddenTool[] = [];
      if (!fits(pill, title)) {
        // 오른쪽 끝(Console 도구)부터 하나씩 걷는다 — 「⋯」가 선 채로 들어갈 때까지. 남은 줄이 구분선으로 끝나면 그것도 걷는다
        // (구분선은 두 범위 사이에서만 뜻이 있다). 다 걷어도 모자라면 그때부터 이름이 하한까지 줄어든다.
        tools.dataset.more = "shown";
        for (let index = items.length - 1; index >= 0; index -= 1) {
          const item = items[index]!;
          item.setAttribute("data-overflow", "true");
          if (item instanceof HTMLButtonElement && item.id.startsWith("rail-tab-")) {
            next.unshift({ entryId: item.id.slice("rail-tab-".length), active: item.classList.contains("is-active"), disabled: item.disabled, element: item });
          }
          const previous = items[index - 1];
          if (previous?.classList.contains("right-rail-divider")) { previous.setAttribute("data-overflow", "true"); index -= 1; }
          if (fits(pill, title)) break;
        }
        // 도구를 다 걷어도 모자라면 이름을 하한까지 풀어 준다.
        if (title !== null && !fits(pill, title)) title.style.minWidth = `${Math.min(TITLE_FLOOR, titleNatural)}px`;
      }
      setHidden((current) => sameHiddenTools(current, next) ? current : next);
    };
    measure();
    // 이름·대화 동작·도구가 서고 걷히면 다시 잰다. 이 묶음이 다는 data-overflow·data-more·data-natural-width 와 이름의 하한(style)은
    // 관찰하지 않는다.
    const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mutation?.observe(row, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "disabled"] });
    // 웹 글꼴이 늦게 오면 이름·단추의 폭이 줄 크기 변화 없이 바뀐다 — 그때도 다시 잰다.
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.addEventListener?.("loadingdone", schedule);
    return () => { resize?.disconnect(); mutation?.disconnect(); fonts?.removeEventListener?.("loadingdone", schedule); if (frame !== 0) cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key !== "Escape" : moreRef.current?.parentElement?.contains(event.target as Node)) return;
      setMenuOpen(false);
      if (event instanceof KeyboardEvent) moreRef.current?.focus();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", close, true); };
  }, [menuOpen]);
  useEffect(() => { if (hidden.length === 0) setMenuOpen(false); }, [hidden.length]);
  const hiddenActive = hidden.some((tool) => tool.active);
  const moreLabel = t("conversation.tools.more");
  return (
    <span className="conversation-pill-tools" ref={toolsRef} role="toolbar" aria-label={t("conversation.tools.aria")}>
      <span className="conversation-pill-tools-items" ref={itemsRef}>
        <RailToolIcons context={context} variant="icons" scope="tools" toolFilter={isCommonTool} />
      </span>
      <span className="conversation-pill-tools-more-wrap">
        <button
          type="button"
          ref={moreRef}
          className={`right-rail-ico conversation-pill-tools-more${hiddenActive ? " is-active" : ""}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={moreLabel}
          data-tip={moreLabel}
          tabIndex={hidden.length > 0 ? 0 : -1}
          aria-hidden={hidden.length > 0 ? undefined : true}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="12.5" cy="8" r="1.2" fill="currentColor" /></svg>
        </button>
        {menuOpen && hidden.length > 0 ? (
          <div className="conversation-pill-tools-menu" role="menu" aria-label={moreLabel}>
            {hidden.map((tool) => {
              const entry = bindings.find((binding) => binding.entry.id === tool.entryId)?.entry ?? null;
              const icon = entry === null ? null : typeof entry.icon === "function" ? entry.icon() : entry.icon;
              const label = entry === null ? tool.element.getAttribute("aria-label") ?? "" : resolveLocalizedText(entry.title, context.language);
              return (
                <button
                  key={tool.entryId}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={tool.active}
                  disabled={tool.disabled}
                  className={`conversation-pill-tools-menu-item${tool.active ? " is-active" : ""}`}
                  onClick={() => { setMenuOpen(false); tool.element.click(); }}
                >
                  <span className="conversation-pill-tools-menu-icon" aria-hidden="true">{icon}</span>
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </span>
      <ToolbarTipLayer rootRef={toolsRef} />
    </span>
  );
}

/**
 * 가운데 칸의 플러그인 대화 — 머리 pill 은 호스트가, 본문은 플러그인이 그린다. 대화가 선 동안 플러그인 탭이 오른쪽
 * 패널 앞 묶음에 서고, 패널이 닫혀 있으면 기본 탭을 연다.
 */
function ConversationSurfaceColumn({ descriptor, selection, language, theme, onToggleDetails, tools, sessionBrowser, browserSplitOpen }: {
  readonly descriptor: ResolvedConversationSurface;
  readonly selection: ConversationSurfaceSelection;
  readonly language: "en" | "ko";
  readonly theme: ConversationSurfaceContext["theme"];
  readonly onToggleDetails: () => void;
  /** 머리 줄 공통 도구모음 — 대화 동작 오른쪽에 선다. */
  readonly tools: ReactNode;
  /** 이 대화의 에이전트 세션이 쓰는 Session 브라우저(descriptor.sessionBrowser) — 있으면 pill 바로 옆에 지구본이 선다. */
  readonly sessionBrowser: SurfaceSessionBrowser | null;
  /** 오른쪽 분할 칸에 브라우저(Fleet·Session 어느 쪽이든)가 서 있는가 — 지구본이 켜짐으로 말한다. */
  readonly browserSplitOpen: boolean;
}) {
  const t = useT();
  useConversationSurfaceHead(descriptor);
  // 대신하는 Operation 이 있으면 그 입력창을 문맥에 싣는다 — 플러그인은 자리만 고르고, 입력창은 호스트의 그룹 입력창이다.
  const standInId = useConversationStandIn();
  const standInComposer = useConversationStandInComposer();
  const context = useMemo<ConversationSurfaceContext>(() => ({
    params: selection.params,
    language,
    theme,
    close: () => closeConversationSurface(descriptor.id),
    ...(standInId !== null && standInComposer !== null ? { composer: () => standInComposer(standInId, language) } : {}),
  }), [descriptor.id, language, selection.params, theme, standInId, standInComposer]);
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
  // 탭은 레일 패널로 선다 — 독점 슬롯·폭 기억·밀어내기를 그대로 받는다. 맥락(같은 대화의 새 요청·언어·테마)이 바뀌어 탭을 다시 세울
  // 때는 패널을 그대로 둔다.
  const tabIdsRef = useRef<readonly string[]>([]);
  tabIdsRef.current = (descriptor.tabs ?? []).map((tab) => tab.id);
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
    };
  }, [context, descriptor, section]);
  // 대화가 걷히면 그 탭이 연 패널도 걷힌다 — 다음 대상이 Operation 이면 가운데 칸이 이 열림을 이어 그 대화의 탭을 연다
  // (usePanelFollowsSubject).
  useEffect(() => () => {
    const active = getRailStoreSnapshot().activePanelId;
    if (active !== null && tabIdsRef.current.includes(active)) closeRailPanel(active);
  }, []);
  // 연 순간(같은 대화를 다시 연 때도) 패널이 닫혀 있거나 앞 Operation 대화의 탭(목표, 대화와 함께 걷힌 구성원)을 보이던 중이면 기본
  // 탭을 연다. 이 대화의 탭과 그 밖의 패널(Theater 설정·도구·설정)은 그대로 둔다.
  const bindings = useDesktopRailEntries();
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  useEffect(() => {
    if (descriptor.defaultTab === undefined) return;
    const active = getRailStoreSnapshot().activePanelId;
    if (active !== null && !tabIdsRef.current.includes(active)) {
      // 등록 목록에 없는 id 는 레일이 그리지 않는다(보이지 않게 닫힌 패널).
      const binding = bindingsRef.current.find((candidate) => candidate.entry.id === active && candidate.panes.length > 0);
      if (binding !== undefined && !isConversationTab(binding.entry)) return;
    } else if (active !== null) return;
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
            ? <KeyedAvatar avatarKey={avatar.key} role={avatar.role} state={avatar.state ?? "idle"} activity={avatar.activity ?? null} size={20} label={avatar.label} decorative className="conversation-pill-mark" />
            : descriptor.mark ? <span className="conversation-pill-surface-mark" aria-hidden="true">{descriptor.mark()}</span> : null}
          <span className="conversation-pill-title">{title}</span>
          {subtitle ? <span className="conversation-pill-sub">· {subtitle}</span> : null}
        </button>
        {(actions === null || actions === false) && sessionBrowser === null ? null : (
          <span className="conversation-pill-actions">
            {/* 지구본은 대화 동작 맨 앞이다 — Operation 대화의 지구본과 같은 글리프·크기·카드다. 보기 전환(CLI/채팅)은 세우지 않는다. */}
            {sessionBrowser === null ? null : <SurfaceBrowserButton session={sessionBrowser} language={language} splitOpen={browserSplitOpen} />}
            {actions === null || actions === false ? null : <PluginErrorBoundary fallback={null}>{actions}</PluginErrorBoundary>}
          </span>
        )}
        {tools}
      </div>
      <div className="conversation-body is-surface">
        <PluginErrorBoundary fallback={null}>{descriptor.render(context)}</PluginErrorBoundary>
      </div>
    </div>
  );
}

function ConversationColumn({ state, operation, language, operationKinds, onToggleDetails, onClose, browserSplitOpen, tools }: {
  readonly state: ConsoleState;
  readonly operation: OperationNode;
  readonly language: "en" | "ko";
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly onToggleDetails: () => void;
  readonly onClose: (operationId: string) => void;
  /** 오른쪽 분할 칸에 브라우저(Fleet·Operation 어느 쪽이든)가 서 있는가 — pill 의 지구본이 켜짐으로 말한다. */
  readonly browserSplitOpen: boolean;
  /** 머리 줄 공통 도구모음 — 대화 동작 오른쪽에 선다. */
  readonly tools: ReactNode;
}) {
  const t = useT();
  const capabilities = useHostCapabilities();
  const clusterIndex = useClusterIndex();
  const bodyRenderer = useConversationBodyRenderer();
  const captionRenderer = useConversationCaptionRenderer();
  const clusterRoot = clusterIndex.rootOf.get(operation.id) ?? null;
  const nested = state.nestedOperations.filter((candidate) => candidate.parentOperationId === operation.id);
  const chosen = state.nestedBodySelection[operation.id];
  const bodyOwner = (chosen ? nested.find((candidate) => candidate.id === chosen) : undefined) ?? operation;
  const runtimeState = pluginRuntimeState(state.operationRuntime, state.operationRuntimeHydration, bodyOwner.id);
  const descriptor = operationKinds.find((kind) => kind.pluginId === bodyOwner.pluginId && kind.type === bodyOwner.type)
    ?? operationKinds.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);

  // 본문 크기 — 플러그인이 읽는 geometry 는 이 칸의 실측이다. 이 값은 어디에도 저장하지 않는다.
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

  // ── 브라우저 — 이 대화의 Operation 브라우저는 오른쪽 분할 칸에 선다 ──
  const offersBrowser = descriptor?.companions?.some((panel) => panel.id === BROWSER_COMPANION_ID) === true;
  const openOperationBrowser = useCallback(() => {
    openOperationBrowserSplit({ subjectId: operation.id, operationId: bodyOwner.id });
  }, [operation.id, bodyOwner.id]);
  // Theater 패널의 Fleet 브라우저 칸이 세우는 선택 카드도 이 대화의 Operation 브라우저 행을 쓴다.
  useEffect(() => {
    if (!offersBrowser) return;
    publishOperationBrowserTarget({ open: openOperationBrowser });
    return () => publishOperationBrowserTarget(null);
  }, [offersBrowser, openOperationBrowser]);
  const closeBrowserSplit = useCallback(() => {
    closeGlobalBrowser();
    closeOperationBrowserSplit();
  }, []);
  // pill 의 지구본: 칸이 비어 있으면 「Fleet 브라우저 / Operation 브라우저」 카드를 단추 아래에 세우고, 칸이 서 있으면 걷는다.
  // 단추는 companion 문법(toggleCompanionPanel)으로 부르므로 여기서 그 호출을 카드로 바꾼다 — 누른 단추가 포커스를 쥐고 있다.
  const onCaptionCompanion = useCallback((companionPanelId: string, visible: boolean) => {
    if (companionPanelId !== BROWSER_COMPANION_ID) return;
    if (!visible) { closeBrowserSplit(); return; }
    const focused = document.activeElement;
    const pillActions = bodyRef.current?.parentElement?.querySelector<HTMLElement>(".conversation-pill-actions") ?? null;
    const anchor = focused instanceof HTMLElement && pillActions?.contains(focused) ? focused : pillActions;
    if (anchor === null) { openOperationBrowser(); return; }
    requestBrowserChooser(anchor, { open: openOperationBrowser });
  }, [closeBrowserSplit, openOperationBrowser]);
  // 본문(채팅·CLI 링크 카드)의 「Operation 브라우저」 행은 묻지 않고 바로 칸에 연다 — 이미 고른 답이다.
  const onBodyCompanion = useCallback((companionPanelId: string, visible: boolean) => {
    if (companionPanelId !== BROWSER_COMPANION_ID) return;
    if (visible) openOperationBrowser();
    else closeBrowserSplit();
  }, [closeBrowserSplit, openOperationBrowser]);
  const hiddenCompanions = browserSplitOpen ? NO_HIDDEN_COMPANIONS : CONVERSATION_COMPANION_PANEL_IDS;

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
    // companion 은 브라우저만 — 오른쪽 분할 칸에 선다. 다른 companion 은 이 화면에서 열지 않는다(onBodyCompanion 이 거른다).
    ...(offersBrowser ? {
      onRequestCompanions: noop,
      companionsOpen: browserSplitOpen,
      hiddenCompanionPanelIds: hiddenCompanions,
      onSetCompanionPanelVisible: onBodyCompanion,
    } : {}),
  };
  const defaultBody = <OperationBodySlot key={bodyOwner.id} operationId={bodyOwner.id} config={config} className="conversation-body-slot" />;
  const custom = bodyRenderer?.({
    operation, bodyOperation: bodyOwner, nestedOperations: nested, language, defaultBody,
    navigate: capabilities.navigate,
    ...(offersBrowser ? { openOperationBrowser } : {}),
  }) ?? null;
  const captionView = captionRenderer?.({ operation, bodyOperation: bodyOwner, nestedOperations: nested, language }) ?? null;
  // 구성원 수는 오른쪽 「구성원」 탭의 명부와 같은 기준이다 — 명부(세션 없는 구성원 포함)와 이 대화의 하위 Operation 의 합집합, 지휘관 제외.
  // 묶음의 노드(임무 칸·살아 있는 구성원)는 명부가 아니다. 명부는 구조 없는 묶음(임무·떠 있는 구성원 없이 세션 없는 구성원만 있는
  // 목표)에도 서므로 rootOf 가 아니라 묶음 전체에서 찾는다 — 「구성원」 탭과 같은 길이다.
  const roster = clusterIndex.clusters.find((cluster) => cluster.conversation?.operationId === operation.id)?.conversation?.members ?? [];
  const memberIds = new Set([...roster.flatMap((member) => (member.operationId ? [member.operationId] : [])), ...nested.map((candidate) => candidate.id)]);
  memberIds.delete(operation.id);
  const memberCount = memberIds.size;

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
        {captionView}
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
                onRequestCompanions={noop}
                companionsOpen={browserSplitOpen}
                hiddenCompanionPanelIds={hiddenCompanions}
                onSetCompanionPanelVisible={onCaptionCompanion}
                companionPanelIds={CONVERSATION_COMPANION_PANEL_IDS}
                bodyLive
                render={descriptor.captionActions}
              />
            </PluginErrorBoundary>
          )}
          {/* Operation 메뉴(「...」)는 이 줄에 세우지 않는다 — 같은 메뉴가 사이드바 줄의 우클릭으로 열린다. */}
        </span>
        {tools}
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
/** 대화 중심 화면이 캡션 단추로 내주는 companion — 브라우저뿐이다. */
const CONVERSATION_COMPANION_PANEL_IDS: readonly string[] = [BROWSER_COMPANION_ID];

function noop(): void {}

// ── 오른쪽 분할 칸 ─────────────────────────────────────────────────────────

type SplitKind = "fleet" | "operation" | "session";

/** 브라우저 칸의 최소 폭 — 탭 줄과 주소창이 한 줄에 읽히는 폭이다. 대화 열은 CONVERSATION_MIN_WIDTH 를 지킨다. */
const SPLIT_MIN_WIDTH = 360;

interface SplitSeat {
  /** 칸의 폭. */
  readonly width: number;
  /** 경계를 끌어 넓힐 수 있는 끝 — 대화 열이 CONVERSATION_MIN_WIDTH 를 지키는 폭이다. 좁힐 수 있는 끝은 SPLIT_MIN_WIDTH. */
  readonly maxWidth: number;
  /** 칸의 오른쪽 끝 — 레일 옆이면 레일 폭, 레일 위로 덮으면 0. */
  readonly right: number;
  /** 대화 칸(.conversation-stage)의 right — 레일과 칸을 합친 만큼 비킨다. */
  readonly stageRight: number;
  readonly overRail: boolean;
}

/**
 * 칸의 자리 — 사람이 경계를 끌어 고른 폭(preferred)이 있으면 그 폭, 없으면 대화 열과 브라우저가 남은 폭을 반씩 나눈다. 어느 쪽이든
 * 대화 열은 CONVERSATION_MIN_WIDTH, 칸은 SPLIT_MIN_WIDTH 밑으로 줄지 않게 지금 창 폭으로 clamp 한다(고른 값 자체는 바꾸지 않는다).
 * 레일(오른쪽 패널) 옆에 둘 자리가 모자라면 칸이 레일 위로 덮는다(레일은 그 아래 그대로 산다). 그것도 모자라면 칸을
 * 세우지 않는다 — Fleet 브라우저는 기존 시트 기하로 뜨고, Operation 브라우저는 열지 않는다.
 */
function resolveSplitSeat(viewportWidth: number, insets: ArenaInsets, preferred: number | null): SplitSeat | null {
  const fit = (available: number) => {
    const maxWidth = available - CONVERSATION_MIN_WIDTH;
    if (maxWidth < SPLIT_MIN_WIDTH) return null;
    return { width: Math.max(SPLIT_MIN_WIDTH, Math.min(preferred ?? Math.round(available / 2), maxWidth)), maxWidth };
  };
  const beside = fit(viewportWidth - insets.left - insets.right);
  if (beside !== null) return { ...beside, right: insets.right, stageRight: insets.right + beside.width, overRail: false };
  if (insets.right <= 0) return null;
  const over = fit(viewportWidth - insets.left);
  return over === null ? null : { ...over, right: 0, stageRight: over.width, overRail: true };
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/**
 * 대화 열 오른쪽 칸. 늘 마운트되어 있고(닫히면 폭 0), 폭 전이로 펼쳐지고 접힌다 — 대화 칸의 right 전이와 같은 시간·곡선이다.
 * 펼쳐지는 동안은 고요한 면만 보이고, 정착한 뒤에 내용이 선다: Fleet 브라우저는 이 칸 위에 시트가 앉아 네이티브 뷰를 한 번
 * 놓고, Session 브라우저(Operation 의 companion · 플러그인 세션의 것)는 이 칸 안에 그린다.
 */
function ConversationSplit({ kind, seat, fallbackRight, operation, sessionOwnerId, state, language, operationKinds, resizing, onResizingChange }: {
  readonly kind: SplitKind | null;
  readonly seat: SplitSeat | null;
  readonly fallbackRight: number;
  readonly operation: OperationNode | null;
  /** 플러그인 대화의 Session 브라우저 owner — kind 가 "session" 일 때만. */
  readonly sessionOwnerId: string | null;
  readonly state: ConsoleState;
  readonly language: "en" | "ko";
  readonly operationKinds: readonly OperationKindDescriptor[];
  /** 경계를 끄는 중인가 — 칸이 전이 없이 따라가고, data-resizing 으로 브라우저가 네이티브 뷰를 물린다. */
  readonly resizing: boolean;
  readonly onResizingChange: (resizing: boolean) => void;
}) {
  const [settled, setSettled] = useState(false);
  const open = kind !== null && seat !== null;
  const width = open ? seat.width : 0;
  const ref = useRef<HTMLDivElement | null>(null);
  // 접히는 동안에도 칸은 무엇이 서 있던 자리인지 말한다 — Fleet 브라우저 시트가 이 표식을 보고 칸을 따라 줄어든다.
  const [closingKind, setClosingKind] = useState<SplitKind | null>(null);
  const lastKindRef = useRef<SplitKind | null>(null);
  useEffect(() => {
    if (open) { lastKindRef.current = kind; setClosingKind(null); return; }
    const was = lastKindRef.current;
    lastKindRef.current = null;
    if (was === null) return;
    const element = ref.current;
    const moving = (element?.getAnimations?.() ?? []).some((animation) => (animation as CSSTransition).transitionProperty === "width");
    if (!moving) { setClosingKind(null); return; }
    setClosingKind(was);
    const onEnd = (event: TransitionEvent) => { if (event.target === element && event.propertyName === "width") setClosingKind(null); };
    element?.addEventListener("transitionend", onEnd);
    const fallback = window.setTimeout(() => setClosingKind(null), 600);
    return () => { element?.removeEventListener("transitionend", onEnd); window.clearTimeout(fallback); };
  }, [open, kind]);
  // 정착 — 펼치는 폭 전이가 끝나면(또는 전이가 없는 환경이면 곧바로) 내용을 세운다. 닫히면 내용부터 걷는다.
  // 열린 채 폭만 바뀌면(경계 끌기·창 크기·레일 개폐) 내용은 선 채로 따라간다 — 다시 세우지 않는다.
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    const element = ref.current;
    const moving = (element?.getAnimations?.() ?? []).some((animation) => (animation as CSSTransition).transitionProperty === "width");
    if (!moving) { setSettled(true); return; }
    setSettled(false);
    const onEnd = (event: TransitionEvent) => { if (event.target === element && event.propertyName === "width") setSettled(true); };
    element?.addEventListener("transitionend", onEnd);
    const fallback = window.setTimeout(() => setSettled(true), 600);
    return () => { element?.removeEventListener("transitionend", onEnd); window.clearTimeout(fallback); };
  }, [open]);
  return (
    <>
    {open && settled ? <SplitResizeHandle seat={seat} splitRef={ref} resizing={resizing} onResizingChange={onResizingChange} /> : null}
    <div
      ref={ref}
      className={`conversation-split${open ? " is-open" : ""}${seat?.overRail ? " is-over-rail" : ""}${open && resizing ? " is-resizing" : ""}`}
      {...(open ? { "data-kind": kind } : closingKind !== null ? { "data-kind": closingKind, "data-closing": "true" } : {})}
      data-settled={open && settled ? "true" : undefined}
      // 끄는 동안의 표식 — Fleet 브라우저 시트와 칸 안의 Session 브라우저가 이 값을 보고 네이티브 뷰를 정지 화면 뒤로 물린다.
      data-resizing={open && resizing ? "true" : undefined}
      style={{ right: seat?.right ?? fallbackRight, width }}
      aria-hidden={open ? undefined : true}
    >
      {open && settled && kind === "session" && sessionOwnerId !== null ? (
        <SessionBrowserSplitPane key={sessionOwnerId} ownerId={sessionOwnerId} theme={state.activeTheme} language={language} />
      ) : null}
      {open && settled && kind === "operation" && operation !== null ? (
        <OperationBrowserSplitPane operation={operation} state={state} language={language} operationKinds={operationKinds} />
      ) : null}
    </div>
    </>
  );
}

/** 키보드 한 걸음 — Shift 를 누르면 크게 간다. */
const SPLIT_RESIZE_STEP = 16;
const SPLIT_RESIZE_STEP_LARGE = 64;

/**
 * 대화 열과 브라우저 칸 사이 경계 — 끌면 칸 폭이 바뀐다(왼쪽으로 끌면 브라우저가 넓어진다). 손잡이는 경계의 대화 열 쪽에 선다:
 * 칸 쪽은 Desktop 에서 네이티브 뷰가 페이지 위를 덮어 포인터를 가져간다. 끄는 동안은 포인터를 손잡이에 붙들고(setPointerCapture)
 * 칸에 data-resizing 을 달아 브라우저가 네이티브 뷰를 정지 화면 뒤로 물리게 한다 — 커서가 뷰 자리 위를 지나도 끌기가 끊기지 않고,
 * 놓으면 정착한 자리에 뷰가 한 번 다시 놓인다. 손잡이를 가리키면 끌기를 예고(announceNativeViewResize)해 브라우저가 보이는 뷰를
 * 미리 찍어 두게 하고, 누르는 순간(렌더 전에) 끌기 시작을 알려 그 장을 깔고 곧바로 물러나게 한다. 키보드(←/→, Shift 로 크게,
 * Home/End)로도 조절하고, 두 번 누르면 고른 폭을 지워 반씩 나누는 폭으로 돌아간다. 폭은 언제나 SPLIT_MIN_WIDTH ~ seat.maxWidth(대화 열의 최소폭을 남기는 끝) 안이다.
 */
function SplitResizeHandle({ seat, splitRef, resizing, onResizingChange }: {
  readonly seat: SplitSeat;
  /** 브라우저를 실은 칸 — 끌기 예고·시작을 이 칸 안의 브라우저에 알린다. */
  readonly splitRef: { readonly current: HTMLDivElement | null };
  readonly resizing: boolean;
  readonly onResizingChange: (resizing: boolean) => void;
}) {
  const t = useT();
  const seatRef = useRef(seat);
  seatRef.current = seat;
  const draggingRef = useRef(false);
  const announce = (phase: "armed" | "held" | null) => {
    const container = splitRef.current;
    if (phase === null || container === null) {
      if (getNativeViewResize()?.container === container) announceNativeViewResize(null);
      return;
    }
    announceNativeViewResize({ container, held: phase === "held" });
  };
  // 예고는 포인터가 손잡이 위에 있는 동안뿐이다 — 키보드 조절은 전이로 따라가며 뷰를 끌기처럼 물리지 않는다.
  const arm = () => { if (!draggingRef.current) announce("armed"); };
  const disarm = () => { if (!draggingRef.current) announce(null); };
  // 손잡이가 걷히면(칸이 닫힘) 예고도 걷는다.
  useEffect(() => () => {
    const container = splitRef.current;
    if (container !== null && getNativeViewResize()?.container === container) announceNativeViewResize(null);
  }, [splitRef]);
  const clamp = (value: number) => Math.max(SPLIT_MIN_WIDTH, Math.min(seatRef.current.maxWidth, Math.round(value)));
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const { pointerId, clientX: startX } = event;
    const startWidth = seatRef.current.width;
    let width = startWidth;
    let done = false;
    try { handle.setPointerCapture(pointerId); } catch { /* 붙들지 못해도 창 전체의 움직임으로 따라간다. */ }
    draggingRef.current = true;
    // 렌더(data-resizing)보다 먼저 칸 안의 브라우저에 알린다 — 미리 찍어 둔 장으로 곧바로 물러나게.
    announce("held");
    onResizingChange(true);
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      // 놓는 순간을 듣지 못했으면(네이티브 뷰 위에서 놓는 등) 버튼이 떨어진 첫 움직임에서 끝낸다.
      if ((move.buttons & 1) === 0) { finish(move); return; }
      width = clamp(startWidth + startX - move.clientX);
      setConversationSplitWidth(width);
    };
    // 끌기의 끝은 버튼을 놓을 때(pointerup)와 취소(pointercancel)뿐이다. 버튼을 누른 채 포인터 붙들기만 풀리면(뷰 층 순서가 바뀌는
    // 순간 등) 다시 붙들고 끌기를 잇는다 — 붙들기가 풀린 것을 끝으로 보면 끄는 도중 data-resizing 이 걷혀 물러났던 뷰가 다시 선다.
    const onLostCapture = (lost: PointerEvent) => {
      if (done || lost.pointerId !== pointerId) return;
      try { handle.setPointerCapture(pointerId); } catch { /* 포인터가 이미 끝났다 — 창 전체의 움직임·놓음으로 끝난다. */ }
    };
    const finish = (end: PointerEvent) => {
      if (done || end.pointerId !== pointerId) return;
      done = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", onLostCapture);
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* 이미 풀렸다. */ }
      // 움직이지 않은 누름(두 번 누르기의 반쪽 포함)은 고른 폭을 만들지 않는다 — 반씩 나누는 기본을 지키게.
      if (width !== startWidth) setConversationSplitWidth(width, { persist: true });
      draggingRef.current = false;
      // data-resizing 을 먼저 걷어 커밋한 뒤 알린다 — 칸 안의 브라우저가 알림을 받는 그 자리에서 뷰를 다시 놓게.
      flushSync(() => onResizingChange(false));
      announce(handle.matches(":hover") ? "armed" : null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", onLostCapture);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? SPLIT_RESIZE_STEP_LARGE : SPLIT_RESIZE_STEP;
    const current = seatRef.current.width;
    let next: number;
    switch (event.key) {
      case "ArrowLeft": next = current + step; break;
      case "ArrowRight": next = current - step; break;
      case "Home": next = SPLIT_MIN_WIDTH; break;
      case "End": next = seatRef.current.maxWidth; break;
      default: return;
    }
    event.preventDefault();
    setConversationSplitWidth(clamp(next), { persist: true });
  };
  return (
    <div
      className={`conversation-split-resize${seat.overRail ? " is-over-rail" : ""}${resizing ? " is-resizing" : ""}`}
      style={{ right: seat.right + seat.width }}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      aria-label={t("conversation.split.resize")}
      title={t("conversation.split.resetWidth")}
      aria-valuenow={seat.width}
      aria-valuemin={SPLIT_MIN_WIDTH}
      aria-valuemax={seat.maxWidth}
      onPointerDown={onPointerDown}
      onPointerEnter={arm}
      onPointerMove={arm}
      onPointerLeave={disarm}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setConversationSplitWidth(null, { persist: true })}
    />
  );
}

/** 플러그인 대화(사령관)가 쓰는 Session 브라우저 — 플러그인 id 는 호스트 등록 id, scopeId 는 그 대화가 돌려준 세션 scope 다. */
interface SurfaceSessionBrowser {
  readonly pluginId: string;
  readonly scopeId: string;
  /** 분할 칸이 이 대화의 것인지 가리는 열쇠 — `<pluginId>:<scopeId>`. */
  readonly subjectKey: string;
}

/** 칸 안의 Session 브라우저가 쓰는 호스트 손잡이 — Operation companion 과 같은 값이다. 붙여넣기 경로(onAttach)는 없다. */
const SESSION_BROWSER_SERVICES = { isDesktopShell, themePolarity, subscribeConsoleChannel } as const;

/**
 * 플러그인 대화(사령관)의 브라우저 지구본 — Operation 대화의 지구본(AgentCaptionActions `browser`)과 같은 글리프·크기·말풍선이다.
 * 칸이 비어 있으면 「Fleet 브라우저 / Session 브라우저」 카드를 단추 아래에 세우고, 칸이 서 있으면 걷는다. Session 행은 누르는 순간
 * 그 세션의 브라우저 owner 를 묻는다 — 세션이 아직 한 번도 서지 않았으면 행이 닫힌 채 까닭을 말한다. 엔진이 없거나 공유 중이면
 * 지구본 자체가 닫힌 채 까닭을 말한다(Operation 지구본과 같은 판정). 시트를 띄우지 않고 연 Fleet 브라우저 뒤 탭 수가 모서리에 선다.
 */
function SurfaceBrowserButton({ session, language, splitOpen }: {
  readonly session: SurfaceSessionBrowser;
  readonly language: "en" | "ko";
  readonly splitOpen: boolean;
}) {
  const t = getBrowserT(language);
  const engine = useBrowserEngine();
  const engineMissing = engine !== null && !engine.available;
  const unseenTabs = useGlobalBrowserUnseenTabs();
  const badge = engineMissing ? 0 : unseenTabs;
  const slotRef = useRef<HTMLSpanElement | null>(null);
  const pendingRef = useRef(0);
  const base = engineMissing
    ? t(engine.reason === "shared" ? "terminal.browser.shared" : isDesktopShell() ? "terminal.browser.desktopMissing" : "terminal.browser.desktopOnly")
    : t(splitOpen ? "terminal.browser.exit" : "terminal.browser.open");
  const label = badge > 0 ? `${base} · ${globalBrowserUnseenLabel(badge, language)}` : base;
  const onClick = () => {
    if (splitOpen) {
      closeGlobalBrowser();
      closeSessionBrowserSplit();
      return;
    }
    const anchor = slotRef.current?.querySelector<HTMLElement>("button") ?? null;
    if (anchor === null) return;
    // 늦게 온 답이 그 사이 다시 누른 카드를 덮지 않게 마지막 요청만 카드를 세운다.
    const request = ++pendingRef.current;
    const { pluginId, scopeId, subjectKey } = session;
    void resolveSessionBrowserTarget({ pluginId, scopeId })
      .then((ownerId) => ({ ownerId, failed: false }), () => ({ ownerId: null, failed: true }))
      .then(({ ownerId, failed }) => {
        if (request !== pendingRef.current || !anchor.isConnected) return;
        requestBrowserChooser(
          anchor,
          ownerId === null ? null : { open: () => openSessionBrowserSplit({ subjectKey, ownerId }) },
          { sessionNotStarted: ownerId === null && !failed },
        );
      });
  };
  return (
    <span ref={slotRef} className="conversation-pill-browser">
      <CaptionActionButton actionId="browser" label={label} pressed={splitOpen} disabled={engineMissing} badge={badge} onClick={onClick}>
        <CaptionBrowserUseGlyph />
      </CaptionActionButton>
    </span>
  );
}

/** 칸 안의 플러그인 세션 Session 브라우저 — 캡션(탭 줄)과 본문을 그 owner 로 그린다. */
function SessionBrowserSplitPane({ ownerId, theme, language }: {
  readonly ownerId: string;
  readonly theme: ConsoleState["activeTheme"];
  readonly language: "en" | "ko";
}) {
  const t = useT();
  return (
    <div className="conversation-split-pane" data-keep-operation-active>
      <header className="conversation-split-head">
        <SessionBrowserCaption ownerId={ownerId} language={language} />
        <button type="button" className="conversation-round conversation-split-close" onClick={closeSessionBrowserSplit} aria-label={t("conversation.split.close")} title={t("conversation.split.close")}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </header>
      <div className="conversation-split-body">
        <SessionBrowserPanel ownerId={ownerId} language={language} theme={theme} bodyLive services={SESSION_BROWSER_SERVICES} />
      </div>
    </div>
  );
}

/** 칸 안의 Operation 브라우저 — 캡션과 본문의 두 슬롯을 같은 context로 그린다. */
function OperationBrowserSplitPane({ operation, state, language, operationKinds }: {
  readonly operation: OperationNode;
  readonly state: ConsoleState;
  readonly language: "en" | "ko";
  readonly operationKinds: readonly OperationKindDescriptor[];
}) {
  const t = useT();
  const capabilities = useHostCapabilities();
  const descriptor = operationKinds.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);
  const companion = descriptor?.companions?.find((panel) => panel.id === BROWSER_COMPANION_ID) ?? null;
  const runtimeState = pluginRuntimeState(state.operationRuntime, state.operationRuntimeHydration, operation.id);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<OperationGeometry>({ x: 0, y: 0, width: 480, height: 640, zIndex: 0 });
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
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const activate = useCallback(() => setActiveOperation(operation.id), [operation.id]);
  const onCompanion = useCallback((companionPanelId: string, visible: boolean) => {
    if (companionPanelId === BROWSER_COMPANION_ID && !visible) closeOperationBrowserSplit();
  }, []);
  if (companion === null) return null;
  const shared = {
    active: state.activeOperationId === operation.id,
    capabilities,
    geometry,
    operation,
    theme: state.activeTheme,
    language,
    viewportZoom: 1,
    runtimeState,
    onActivate: activate,
    onClose: closeOperationBrowserSplit,
    onGeometryChange: setGeometry,
    onRequestCompanions: noop,
    companionsOpen: true,
    hiddenCompanionPanelIds: NO_HIDDEN_COMPANIONS,
    onSetCompanionPanelVisible: onCompanion,
    companionPanelIds: CONVERSATION_COMPANION_PANEL_IDS,
    bodyLive: true,
  } as const;
  return (
    <div className="conversation-split-pane" data-keep-operation-active>
      <header className="conversation-split-head">
        {companion.caption === undefined ? <span className="conversation-split-title">{resolveLocalizedText(companion.title, language)}</span> : (
          <PluginErrorBoundary fallback={<></>}>
            <PluginOperationRenderer {...shared} render={companion.caption} />
          </PluginErrorBoundary>
        )}
        <button type="button" className="conversation-round conversation-split-close" onClick={closeOperationBrowserSplit} aria-label={t("conversation.split.close")} title={t("conversation.split.close")}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </header>
      <div className="conversation-split-body" ref={bodyRef}>
        <PluginErrorBoundary fallback={null}>
          <PluginOperationRenderer {...shared} render={companion.render} />
        </PluginErrorBoundary>
      </div>
    </div>
  );
}
