import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { ConversationSurfaceContext, ConversationSurfaceDescriptor, OperationKindDescriptor } from "@fleet-console/sdk/plugin";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";

import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import type { ArenaInsets } from "./arena-insets.js";
import type { ConsoleState, OperationGeometry, OperationNode } from "../../../../core/client/src/integration/types.js";
import { closeNewSession, selectNestedBody, setActiveOperation, toggleOperationSearch } from "../../../../core/client/src/integration/store.js";
import { useNewSessionShortcutLabel } from "../../../../core/client/src/integration/shortcuts.js";
import { conversationSurfaceInboxSectionId, DEPUTY_COMMAND_BAND_ENTRY_ID, usePluginRegistry, type ResolvedConversationSurface } from "../../../../core/client/src/integration/plugin-registry.js";
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
import { operationAvatarKey, theaterAvatarKey, type MongleState } from "@fleet-console/sdk/avatars";
import { AvatarEditor, KeyedAvatar, OperationAvatar, operationAvatarRole, operationMongleState } from "../avatars.js";
import { pluginRuntimeState } from "../../../execution/client/operation-activity.js";
import { CONVERSATION_MEMBERS_TAB_ID } from "../../../execution/client/agent/chat/group/index.js";
import { BROWSER_COMPANION_ID } from "../../../execution/client/agent/browser-companion.js";
import { useBrowserEngine } from "../../../browser/client/browser-panel-store.js";
import { getT as getBrowserT } from "../../../browser/client/i18n.js";
import { CaptionActionButton, CaptionBrowserUseGlyph } from "@fleet-console/sdk/components/caption-actions";
import { isDesktopShell } from "../../../../core/client/src/integration/desktop-shell.js";
import { setChatReadingWidthDefault } from "../../../execution/client/terminal/shared/terminal-preferences.js";
import { OperationCaptionContributions } from "../operation-contributions.js";
import { useClusterIndex, useOperationClusters } from "../operation-clusters.js";
import { PluginOperationRenderer } from "../operation-renderer.js";
import { publishConversationClusters, publishConversationStandIn, publishConversationSubject, useConversationBodyRenderer, useConversationCaptionRenderer, useConversationOperationRename, useConversationStandIn, useConversationStandInComposer, useConversationSubject } from "./conversation-slots.js";
import { useConversationPillTakeover } from "./conversation-slots.js";
import { PillTakeoverLayer, usePillMorphWidth, usePillTakeoverPhase } from "./pill-takeover.js";
import { useInlineRename } from "../../../../core/client/src/integration/use-inline-rename.js";
import { closeConversationSurface, useConversationSurface, type ConversationSurfaceSelection } from "./conversation-surface-store.js";
import { ConversationPanelFrame } from "./conversation-panel-frame.js";
import { NewSessionColumn } from "./new-session.js";
import { openDefaultNewSession } from "./new-session-entry.js";
import { ConversationWorkbench, type WorkbenchConversation } from "./workbench/conversation-workbench.js";
import { computeWorkbenchGeometry } from "./workbench/workbench-geometry.js";
import { useConversationWorkbenchHost } from "./workbench/workbench-host.js";
import { useConversationWorkLocation } from "./workbench/work-location.js";
import { useAgentState } from "../../../execution/client/agent/store.js";
import { closeWorkbenchBrowser, getWorkbenchKey, isWorkbenchEntryOpen, subscribeWorkbench, isWorkbenchSurfaceOpen, openWorkbenchBrowser, toggleWorkbenchBrowser, useWorkbenchBrowserShown, useWorkbenchFocusedTileId, useWorkbenchLayout } from "./workbench/workbench-store.js";
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

/**
 * 대화 옆 도구 칸으로 여는 엔트리 — 코어 탭(대상의 탭·Theater 칸)·대화 탭(목표)·설정이 아닌 페인 엔트리. 오른쪽 사이드바는 그대로 대상의 탭을
 * 싣고, 이 엔트리들은 대화별 작업대가 연다(시안 v2 「정해진 것」).
 */
export function isWorkbenchToolBinding(binding: RailEntryBinding): boolean {
  return !binding.core && binding.panes.length > 0 && binding.entry.conversationTab !== true && binding.entry.id !== SETTINGS_RAIL_ENTRY_ID;
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
    // 도구(파일·Codex·스킬 등)는 오른쪽 사이드바가 아니라 대화 옆 도구 칸에 열린다 — 사이드바가 여는 것은 대상의 탭과 대화 탭(목표)뿐이다.
    const panes = bindings.filter((binding) => binding.panes.length > 0 && binding.entry.id !== SETTINGS_RAIL_ENTRY_ID && binding.entry.visible?.() !== false && !isWorkbenchToolBinding(binding));
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
 * 사이드바 맨 위 줄 오른쪽 — 찾기(⌘K)와 새 세션. 보기·정렬·접기 단추와 한 줄, 같은 원형 문법이다. 「+」는 본문에 새 세션 화면을 연다
 * (승인안 v4 — Theater 머리·그룹 머리의 「+」는 없고 진입은 이 하나다). 새 Theater 는 새 세션 화면의 「Theater 추가…」와 팔레트(⌘K)에 있다.
 */
export function ConversationSideBarActions() {
  const t = useT();
  const newSessionShortcut = useNewSessionShortcutLabel();
  const newSessionTitle = newSessionShortcut ? `${t("conversation.side.newSession")} (${newSessionShortcut})` : t("conversation.side.newSession");
  return (
    <span className="conversation-side-actions">
      <span className="remote-console-anchor" data-remote-console-anchor />
      <button type="button" className="conversation-round" onClick={toggleOperationSearch} aria-label={t("conversation.side.search")} title={t("conversation.side.search")}>
        <SearchGlyph />
      </button>
      <button type="button" className="conversation-round" onClick={openDefaultNewSession} aria-label={t("conversation.side.newSession")} title={newSessionTitle} data-new-session-entry="sidebar">
        <PlusGlyph />
      </button>
    </span>
  );
}

/** 부관 머리 크기 단계 — 맨 위 줄 가용 폭이 모자라면 한 단씩 줄인다(28px 가 바닥: 커맨드 밴드 머리 24px 보다 크다). */
const DEPUTY_HEAD_SIZES = [40, 32, 28] as const;
/** 머리 묶음과 이웃(신호등 예약·찾기·새 Theater 단추) 사이에 남기는 여유. */
const DEPUTY_CLEARANCE = 8;

/**
 * 맨 위 줄 가운데 — 출근한 부관(고정 표식)이 있을 때만 선다. 따로 한 줄을 차지하지 않고 찾기·새 Theater 와 같은 52px 줄에 뜬다.
 *
 * 자리는 이 줄의 실제 기하로 정한다. 가용 칸은 줄의 왼쪽 안쪽 여백(macOS Desktop 은 신호등 예약 76px/zoom + 4px, 그 밖은 12px)부터
 * 오른쪽 단추 묶음 앞까지다(Windows 캡션 단추는 맨 오른쪽 열이 비우므로 사이드바에는 예약이 없다). 머리는 40 → 32 → 28px 중
 * 묶음이 가용 칸(양쪽 여유 8px)에 드는 가장 큰 단을 고르고, 사이드바 축 가운데에 선다 — 그 자리가 이웃과 부딪히면 가용 칸 가운데로
 * 옮긴다. 크기는 플러그인 항목에 --command-band-entry-size 로 알린다(SDK 계약). 머리 단추는 창 끌기 줄 위에서도 no-drag 다
 * (conversation.css 의 Desktop 규칙이 줄 안 button 을 모두 빼낸다).
 */
export function ConversationSideBarDeputies() {
  const t = useT();
  const { commandBandEntries } = usePluginRegistry();
  const pinned = commandBandEntries.filter((entry) => entry.id === DEPUTY_COMMAND_BAND_ENTRY_ID);
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const cluster = ref.current;
    const strip = cluster?.parentElement;
    if (!cluster || !strip) return;
    let frame = 0;
    const place = () => {
      const stripStyle = getComputedStyle(strip);
      const width = strip.clientWidth;
      const zoneLeft = Number.parseFloat(stripStyle.paddingLeft) || 0;
      const trailing = strip.querySelector<HTMLElement>(".conversation-side-actions");
      const zoneRight = trailing
        ? trailing.offsetLeft - (Number.parseFloat(getComputedStyle(trailing).marginLeft) || 0)
        : width - (Number.parseFloat(stripStyle.paddingRight) || 0);
      const available = Math.max(0, zoneRight - zoneLeft);
      let size: number = DEPUTY_HEAD_SIZES[0];
      let clusterWidth = 0;
      let gap = 4;
      cluster.style.setProperty("--command-band-entry-gap", `${gap}px`);
      for (const candidate of DEPUTY_HEAD_SIZES) {
        size = candidate;
        cluster.style.setProperty("--command-band-entry-size", `${candidate}px`);
        clusterWidth = cluster.offsetWidth;
        if (clusterWidth <= available - DEPUTY_CLEARANCE * 2) break;
      }
      // 28px 아래로 줄이지 않는다. 플러그인 내부 머리 간격도 SDK 변수로 좁혀 실제 폭을 다시 잰다.
      while (clusterWidth > available - DEPUTY_CLEARANCE * 2 && gap > -14) {
        gap--;
        cluster.style.setProperty("--command-band-entry-gap", `${gap}px`);
        clusterWidth = cluster.offsetWidth;
      }
      cluster.dataset.headGap = String(gap);
      let left = width / 2 - clusterWidth / 2;
      if (left < zoneLeft + DEPUTY_CLEARANCE || left + clusterWidth > zoneRight - DEPUTY_CLEARANCE) {
        left = zoneLeft + (available - clusterWidth) / 2;
      }
      // 최소 머리·간격으로도 예약 구간에 들지 못하면 숨긴다. 폭 전이 중에도 신호등이나 오른쪽 단추 위로 밀어 넣지 않는다.
      const fits = clusterWidth <= available - DEPUTY_CLEARANCE * 2;
      cluster.style.left = `${Math.max(zoneLeft + DEPUTY_CLEARANCE, Math.min(Math.round(left), zoneRight - DEPUTY_CLEARANCE - clusterWidth))}px`;
      cluster.style.visibility = fits ? "visible" : "hidden";
      cluster.dataset.headSize = String(size);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    // 줄 폭(사이드바 끌기·줌)과 오른쪽 단추 묶음, 부관 출퇴근(머리 수)에 따라 다시 잰다. 자기 크기 변화는 보지 않는다 — 재는 일이 곧 그 변화다.
    // ResizeObserver 안에서 바로 배치해 다음 페인트에 이전 폭의 좌표·표시 상태가 남지 않게 한다.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    resize?.observe(strip);
    const trailing = strip.querySelector<HTMLElement>(".conversation-side-actions");
    if (trailing) resize?.observe(trailing);
    const mutation = new MutationObserver(schedule);
    mutation.observe(cluster, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation.disconnect();
    };
  }, [pinned.length]);
  if (pinned.length === 0) return null;
  return (
    <div ref={ref} className="conversation-side-deputies" role="group" aria-label={t("conversation.side.pinnedAria")}>
      {pinned.map((entry) => (
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
  const newSessionShortcut = useNewSessionShortcutLabel();
  const subject = useStageSubject(state);
  // 플러그인 대화(사령관 등)가 가운데 칸을 가지면 Operation 대신 선다.
  const surface = useConversationSurface();
  const { conversationSurfaces } = usePluginRegistry();
  const surfaceDescriptor = surface === null ? null : conversationSurfaces.find((descriptor) => descriptor.id === surface.surfaceId) ?? null;
  // 새 세션 화면(Theater·그룹 머리 「+」)이 서면 칸에는 아직 아무 Operation 도 없다. 플러그인 대화와는 나중에 연 쪽이 칸을 갖는다.
  const newSession = state.newSession;
  // 오른쪽 패널·분할 칸이 읽는 대상 — 새 세션 화면 동안은 보던 대화를 대상으로 삼지 않는다.
  const stageSubject = newSession ? null : subject;
  useEffect(() => { publishConversationSubject(surfaceDescriptor ? null : stageSubject); }, [stageSubject, surfaceDescriptor]);
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
  let sessionAttach: ((files: readonly File[]) => void) | null = null;
  if (surfaceDescriptor?.sessionBrowser && surfaceDescriptor.pluginId && surface) {
    try {
      const scope = surfaceDescriptor.sessionBrowser({ params: surface.params, language, theme: state.activeTheme, close: () => closeConversationSurface(surfaceDescriptor.id) });
      sessionScopeId = scope !== null && typeof scope.scopeId === "string" && scope.scopeId !== "" ? scope.scopeId : null;
      // 칸 브라우저의 주석·스크린샷이 붙을 이 대화의 입력창 — 플러그인이 준 손잡이 그대로다(옛 원장 채팅이 아니다).
      sessionAttach = sessionScopeId !== null && typeof scope?.attach === "function" ? scope.attach : null;
    } catch {
      sessionScopeId = null;
    }
  }
  const sessionPluginId = sessionScopeId === null ? null : surfaceDescriptor?.pluginId ?? null;
  const sessionSubjectKey = sessionPluginId === null || sessionScopeId === null ? null : `${sessionPluginId}:${sessionScopeId}`;
  // 가운데 칸에 선 대화가 곧 활성 Operation 이다 — 사이드바 줄이 칩과 같은 선택 표시(테두리 + 면)를 받고, 도착 표식도
  // 보고 있는 대화만큼 정리된다. 크롬을 눌러 활성이 풀려도 칸의 대화는 그대로이므로 다시 활성으로 세운다.
  const activeOperationId = state.activeOperationId;
  const seenNewSessionRef = useRef(newSession);
  const seenSurfaceRef = useRef(surface);
  useEffect(() => {
    const openedNewSession = newSession !== null && seenNewSessionRef.current !== newSession;
    const openedSurface = surface !== null && seenSurfaceRef.current !== surface;
    seenNewSessionRef.current = newSession;
    seenSurfaceRef.current = surface;
    if (openedNewSession && surface !== null) closeConversationSurface(surface.surfaceId);
    else if (openedSurface && newSession !== null) closeNewSession();
  }, [newSession, surface]);
  useEffect(() => {
    // 플러그인 대화가 선 동안에는 어느 Operation 도 칸에 없다 — 사이드바의 Operation 줄 선택을 걷는다(대화를 걷으면 되돌아온다).
    if (newSession !== null) {
      if (activeOperationId !== null) setActiveOperation(null);
      return;
    }
    if (surfaceDescriptor !== null) {
      if (activeOperationId !== null) setActiveOperation(null);
      return;
    }
    if (subject === null || activeOperationId === subject.id) return;
    setActiveOperation(subject.id);
  }, [activeOperationId, newSession, subject, surfaceDescriptor]);
  useEffect(() => () => { publishConversationSubject(null); publishConversationStandIn(null); }, []);
  // 구성원 탭의 아바타가 같은 묶음 사실(검토 대기·결정 요청·임무 완료)로 얼굴을 고르게 묶음을 내건다.
  const operationClusters = useOperationClusters();
  useEffect(() => { publishConversationClusters(operationClusters); }, [operationClusters]);
  const stageInbox = useTheaterInboxState();
  // 아직 서지 않은 Operation 을 대신하는 플러그인 대화(시작 전 목표)도 Operation 대화처럼 「목표」가 먼저다.
  const operationConversation = (surfaceDescriptor === null ? stageSubject !== null : standInId !== null) && stageInbox === null;
  const toggleDetails = useToggleDetails(operationConversation);
  usePanelFollowsSubject(surfaceDescriptor ? standInId : stageSubject?.id ?? null);

  // ── 도구 분할 — 이 대화의 도구 칸(작업대)이 대화 오른쪽과 아래에 선다 ──
  // 배치는 대화마다 하나다(서버 저장). 대화 키는 그 대화를 가리키는 가장 오래가는 이름이다: Operation, 아직 서지 않은 Operation 을 대신하는
  // 플러그인 대화는 그 Operation, 세션 브라우저를 가진 플러그인 대화(사령관)는 그 세션, 그 밖은 Theater 또는 표면 주소.
  let surfaceTheaterId: string | null = null;
  if (surfaceDescriptor?.theater && surface) {
    try {
      surfaceTheaterId = surfaceDescriptor.theater({ params: surface.params, language, theme: state.activeTheme, close: () => closeConversationSurface(surfaceDescriptor.id) })?.theaterId ?? null;
    } catch {
      surfaceTheaterId = null;
    }
  }
  const conversationKey = newSession ? null
    : surfaceDescriptor && surface
      ? standInId !== null ? `operation:${standInId}`
        : sessionSubjectKey !== null ? `session:${sessionSubjectKey}`
          : surfaceTheaterId !== null ? `surface:${surface.surfaceId}:theater:${surfaceTheaterId}`
            : `surface:${surface.surfaceId}:${stableParamsKey(surface.params)}`
      : subject ? `operation:${subject.id}` : null;
  const railBindings = useDesktopRailEntries();
  const toolEntryIds = useMemo(
    () => railBindings.filter((binding) => isWorkbenchToolBinding(binding) && binding.entry.visible?.() !== false).map((binding) => binding.entry.id),
    [railBindings],
  );
  useConversationWorkbenchHost(conversationKey, toolEntryIds);
  const layout = useWorkbenchLayout();
  const focusedTileId = useWorkbenchFocusedTileId();
  const browserOpen = useWorkbenchBrowserShown();
  const viewport = useViewportSize();
  const [regionSize, setRegionSize] = useState<{ readonly width: number; readonly height: number } | null>(null);
  const regionObserverRef = useRef<ResizeObserver | null>(null);
  const workbenchLayerRef = useCallback((element: HTMLDivElement | null) => {
    regionObserverRef.current?.disconnect();
    regionObserverRef.current = null;
    if (element === null) return;
    const measure = () => {
      const width = Math.round(element.clientWidth);
      const height = Math.round(element.clientHeight);
      setRegionSize((current) => (current?.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    regionObserverRef.current = new ResizeObserver(measure);
    regionObserverRef.current.observe(element);
  }, []);
  useEffect(() => () => regionObserverRef.current?.disconnect(), []);
  const regionWidth = regionSize?.width ?? Math.max(0, viewport.width - insets.left - insets.right);
  const regionHeight = regionSize?.height ?? viewport.height;
  const geometry = useMemo(() => computeWorkbenchGeometry(layout, regionWidth, regionHeight), [layout, regionWidth, regionHeight]);
  const workbenchConversation = useMemo<WorkbenchConversation>(() => {
    if (surfaceDescriptor) {
      return {
        kind: "surface",
        sessionBrowser: sessionPluginId !== null && sessionScopeId !== null && sessionSubjectKey !== null
          ? { pluginId: sessionPluginId, scopeId: sessionScopeId, subjectKey: sessionSubjectKey, attach: sessionAttach }
          : null,
      };
    }
    return stageSubject ? { kind: "operation", operation: stageSubject } : { kind: "none" };
  }, [sessionAttach, sessionPluginId, sessionScopeId, sessionSubjectKey, stageSubject, surfaceDescriptor]);

  // 도구가 놓인 대화와 그 작업 위치 — 사령관은 Theater 루트, 지휘관은 그 세션의 작업 폴더(호스트가 Theater 상대로 접어 준다).
  // 도구 캡슐(Shell 열기)과 도구 칸이 모두 이 범위를 받는다. 사람은 다시 고르지 않는다.
  const theaterLabelOf = (id: string | null) => (id === null ? "" : state.theaters.find((theater) => theater.id === id)?.label ?? "");
  const scopeTheaterId = surfaceDescriptor ? surfaceTheaterId ?? toolContext.theaterId : stageSubject?.theaterId ?? null;
  // 에이전트 세션이 알린 「지금 어디」(실험 기능이 켜진 동안만 실린다) — 세션이 옮겨 가면 작업 위치도 따라간다.
  const agentWorkspace = useAgentState().sessions[stageSubject?.id ?? ""]?.workspace ?? null;
  const workLocation = useConversationWorkLocation(
    conversationKey === null || scopeTheaterId === null ? { kind: "none" }
      : !surfaceDescriptor && stageSubject ? { kind: "operation", operationId: stageSubject.id, theaterId: scopeTheaterId, theaterLabel: theaterLabelOf(scopeTheaterId), revision: stageSubject.ts.updatedAt, folder: agentWorkspace?.outside === false ? agentWorkspace.folder ?? "" : null }
        : { kind: "theater", theaterId: scopeTheaterId, theaterLabel: theaterLabelOf(scopeTheaterId) },
  );
  const scopedToolContext = useMemo<RailToolContext>(
    () => (conversationKey !== null && workLocation !== null ? { ...toolContext, conversation: { key: conversationKey, location: workLocation } } : toolContext),
    [conversationKey, toolContext, workLocation],
  );
  // 칸들은 자기 대화의 범위만 받는다 — 대화가 바뀌는 렌더에서는 작업대가 아직 앞 대화의 칸을 들고 있으므로(배치는 layout effect
  // 에서 바뀐다), 그 사이에는 앞 대화의 범위를 그대로 준다. 그러지 않으면 떠나는 칸이 새 대화의 Shell·문서로 착각한다.
  const workbenchKey = useSyncExternalStore(subscribeWorkbench, getWorkbenchKey, getWorkbenchKey);
  const workbenchScopeRef = useRef(scopedToolContext);
  if (workbenchKey === (conversationKey ?? "console")) workbenchScopeRef.current = scopedToolContext;
  const workbenchToolContext = workbenchScopeRef.current;
  const workbenchConversationRef = useRef(workbenchConversation);
  if (workbenchKey === (conversationKey ?? "console")) workbenchConversationRef.current = workbenchConversation;

  // 가운데 칸 어느 대화(사령관·지휘관·일반 Operation·빈 칸)든 머리 줄 도구 캡슐은 같다. 지구본은 그 캡슐 맨 앞에 선다.
  const [band, setBand] = useState<HTMLDivElement | null>(null);
  const tools = (lead: ReactNode = null) => <ConversationToolbar context={scopedToolContext} lead={lead} band={band} />;

  return (
    <>
    {/* 맨 위 줄은 작업 영역 전체 폭이다. 도구모음은 이 줄 오른쪽 끝(Windows 캡션 바로 왼쪽)으로 portal 되며,
        도구 분할은 그 아래만 쓴다. pill 줄은 실제 도구 폭 앞에서 drag 상자를 끝낸다. */}
    <div ref={setBand} className="conversation-band" style={{ left: insets.left, right: insets.right }} />
    <section
      className="conversation-stage"
      // 세 열은 창 높이 전체를 쓰고 서로 붙는다 — 사이드바·레일의 실제 폭이 곧 이 칸의 좌우다. 도구 분할이 서면 그 폭(오른쪽)과
      // 대화 아래 줄 높이(아래)만큼 더 비킨다. 비킨 폭은 머리 pill 줄이 그만큼 오른쪽으로 더 뻗어 맨 위 줄 전체에 걸칠 때 쓴다.
      style={{ left: insets.left, right: insets.right + geometry.conversationRight, bottom: geometry.conversationBottom, "--conversation-split-right": `${geometry.conversationRight}px` } as CSSProperties}
      aria-label={t("conversation.stage.aria")}
    >
      {newSession ? (
        <NewSessionColumn state={state} target={newSession} tools={tools(null)} />
      ) : surfaceDescriptor && surface ? (
        <ConversationSurfaceColumn
          key={surface.surfaceId}
          descriptor={surfaceDescriptor}
          selection={surface}
          language={language}
          theme={state.activeTheme}
          onToggleDetails={toggleDetails}
          tools={tools}
          sessionBrowser={sessionPluginId !== null && sessionScopeId !== null && sessionSubjectKey !== null ? { pluginId: sessionPluginId, scopeId: sessionScopeId, subjectKey: sessionSubjectKey } : null}
          browserSplitOpen={browserOpen}
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
          browserSplitOpen={browserOpen}
          tools={tools}
        />
      ) : (
        // 빈 칸에도 같은 머리 줄 도구모음이 선다 — Theater 가 없으면 Theater 도구는 비활성이고 Console 도구(Shell·스킬)만 눌린다.
        <div className="conversation-column">
          <div className="conversation-pill-row">{tools(null)}</div>
          <div className="conversation-empty">
            <strong>{t("conversation.empty.title")}</strong>
            <span>{t("conversation.empty.body", { shortcut: newSessionShortcut })}</span>
          </div>
        </div>
      )}
    </section>
    <ConversationWorkbench
      layerRef={workbenchLayerRef}
      insets={insets}
      geometry={geometry}
      layout={layout}
      focusedTileId={focusedTileId}
      bindings={railBindings}
      toolContext={workbenchToolContext}
      conversation={workbenchConversationRef.current}
      state={state}
      language={language}
      operationKinds={operationKinds}
      suspended={conversationKey !== null && workLocation === null}
    />
    </>
  );
}

/** 플러그인 대화의 params 를 대화 키로 — 키 순서와 무관하게 같은 값이면 같은 키다. 너무 길면 해시로 줄인다. */
function stableParamsKey(params: Readonly<Record<string, unknown>>): string {
  let text: string;
  try {
    text = JSON.stringify(Object.keys(params).sort().map((key) => [key, params[key]]));
  } catch {
    text = "";
  }
  if (text.length <= 160) return text;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `#${(hash >>> 0).toString(36)}:${text.length}`;
}

/**
 * 공통 도구모음에 서는 도구 — 대화에서 곧장 이어 가는 도구(conversationTab, 목표)는 Operation 대화의 오른쪽 패널 글자 탭이
 * 맡으므로 뺀다. 그래서 사령관·지휘관·일반 Operation 대화·빈 칸의 도구 집합이 같다.
 */
function isCommonTool(entry: RailEntryDescriptor): boolean {
  return entry.conversationTab !== true;
}

/** 도구 캡슐의 켜짐 — 지금 대화의 도구 칸에 그 도구가 서 있는가. 저장소·Shell 처럼 표면을 여는 도구는 그 표면 칸을 본다. */
function workbenchToolActive(entry: RailEntryDescriptor): boolean | undefined {
  if (entry.activate !== undefined) return entry.surfaceId === undefined ? undefined : isWorkbenchSurfaceOpen(entry.surfaceId);
  return isWorkbenchEntryOpen(entry.id);
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
 * 줄은 한 줄이다: 자리가 모자라면 오른쪽 끝 도구부터 걷어 「⋯」 메뉴에 모은다. 이름 pill 은
 * 도구가 모두 걷힌 다음에야 말줄임이 시작되고, 대화 동작은 걷히지 않는다.
 */
function ConversationToolbar({ context, lead = null, band }: { readonly context: RailToolContext; readonly lead?: ReactNode; readonly band: HTMLDivElement | null }) {
  const t = useT();
  const toolsRef = useRef<HTMLSpanElement | null>(null);
  const itemsRef = useRef<HTMLSpanElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [hidden, setHidden] = useState<readonly HiddenTool[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const bindings = useDesktopRailEntries();
  // 켜짐은 이 대화의 도구 칸이 말한다 — 배치가 바뀌면 다시 그린다.
  useWorkbenchLayout();
  useLayoutEffect(() => {
    const tools = toolsRef.current;
    const itemsBox = itemsRef.current;
    const stage = band?.nextElementSibling;
    const row = stage?.querySelector<HTMLElement>(":scope > .conversation-column > .conversation-pill-row") ?? null;
    if (!tools || !itemsBox || !row || !(stage instanceof HTMLElement)) return;
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
        // 제목 문이 안쪽 동작을 밀거나 그 아래로 흐르면 아직 들어가지 않은 것이다.
        const details = pill.querySelector<HTMLElement>(".conversation-pill-details");
        if (details !== null && details.scrollWidth > details.clientWidth + 1) return false;
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
    // 줄 폭(칸 폭·도구모음 예약)뿐 아니라 줄 안 요소의 폭도 본다 — 글꼴·컨테이너 질의·인라인 스타일처럼 줄 크기나 관찰하는 속성을
    // 바꾸지 않고 이름·대화 동작의 폭만 바꾸는 변화에도 이름이 먼저 잘리지 않게. 같은 대상을 다시 observe 해도 하나로 친다.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const measure = () => {
      frame = 0;
      // 이전 사용량 자리를 도구모음이 차지한다. 현재 도구 폭만큼 양쪽을 예약해 pill 을 가운데에 둔다.
      const reserve = () => {
        const right = Number.parseFloat(getComputedStyle(tools).right) || 0;
        stage.style.setProperty("--conversation-quota-space", `${Math.ceil(tools.getBoundingClientRect().width + right + 12)}px`);
      };
      const items = [...itemsBox.querySelectorAll<HTMLElement>(".right-rail-ico, .right-rail-divider")];
      for (const item of items) item.removeAttribute("data-overflow");
      tools.dataset.more = "hidden";
      reserve();
      if (resize !== null) {
        resize.observe(tools);
        // 줄의 내용 상자 — 도구모음 예약은 테두리 폭이 아니라 안쪽 여백을 바꾼다. 여백이 줄면 걷힌 도구를 다시 세운다.
        resize.observe(row, { box: "content-box" });
        // 테두리 상자로 본다 — 내용 상자만 보면 안쪽 여백·테두리만 바뀐 요소의 폭 변화를 놓친다.
        for (const child of row.children) if (child !== tools) resize.observe(child, { box: "border-box" });
        const titleElement = row.querySelector(":scope > .conversation-pill .conversation-pill-title");
        if (titleElement !== null) resize.observe(titleElement);
      }
      // 줄이 모자랄 때 줄어드는 순서 — 부제(「· 구성원 n」 등)가 먼저 말줄임으로 SUB_FLOOR 까지, 그다음 도구가 「⋯」로, 마지막에
      // 이름이 TITLE_FLOOR(이름이 그보다 짧으면 그 폭)까지. 도구가 남아 있는 동안 이름은 원래 폭에 묶어 둔다. pill 내용이 상자 밖으로
      // 흐르면(부제·이름이 하한에 닿은 뒤) 들어가지 않은 것으로 보고 도구를 더 걷는다(fits).
      const pill = row.querySelector<HTMLElement>(":scope > .conversation-pill");
      pill?.removeAttribute("data-compact");
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
      // 모든 도구를 세운 뒤, 이름이 제 폭을 지킬 때까지 오른쪽 끝부터 걷는다.
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
          reserve();
          if (fits(pill, title)) break;
        }
        // 도구를 다 걷어도 모자라면 이름을 하한까지 풀어 준다.
        if (title !== null && !fits(pill, title)) title.style.minWidth = `${Math.min(TITLE_FLOOR, titleNatural)}px`;
        // 하한으로도 모자라면 이름을 걷고 표식(아바타)만 원형 칩 가운데에 남긴다 — 상자가 내용을 자르면 표식이 한쪽으로 쏠린다.
        // 표식이 없는 pill 은 이름이 유일한 단서라 그대로 둔다.
        if (pill !== null && title !== null && !fits(pill, title)
          && pill.querySelector(".conversation-pill-details > .conversation-pill-mark, .conversation-pill-details > .conversation-pill-surface-mark") !== null) pill.dataset.compact = "true";
      }
      setHidden((current) => sameHiddenTools(current, next) ? current : next);
    };
    measure();
    // 이름·대화 동작·도구가 서고 걷히면 다시 잰다. 이 묶음이 다는 data-overflow·data-more 와 이름의 하한(style)은
    // 관찰하지 않는다.
    const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mutation?.observe(row, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "disabled"] });
    mutation?.observe(tools, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "disabled"] });
    // 웹 글꼴이 늦게 오면 이름·단추의 폭이 줄 크기 변화 없이 바뀐다 — 그때도 다시 잰다.
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.addEventListener?.("loadingdone", schedule);
    return () => { resize?.disconnect(); mutation?.disconnect(); fonts?.removeEventListener?.("loadingdone", schedule); if (frame !== 0) cancelAnimationFrame(frame); };
  }, [band]);
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
  // 지구본(lead)은 대화 동작이라 이 측정이 걷는 목록(.right-rail-ico) 밖에 선다 — 「⋯」로 걷히지 않는다.
  const showLead = lead !== null && lead !== false;
  return band === null ? null : createPortal(
    <span className="conversation-pill-tools" ref={toolsRef} role="toolbar" aria-label={t("conversation.tools.aria")}>
      {showLead ? <span className="conversation-pill-tools-lead">{lead}</span> : null}
      <span className="conversation-pill-tools-items" ref={itemsRef}>
        <RailToolIcons context={context} variant="icons" scope="tools" toolFilter={isCommonTool} toolActive={workbenchToolActive} />
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
    </span>, band
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
  /** 머리 줄 도구 캡슐. 지구본(lead)을 넘기면 캡슐 맨 앞, 「⋯」 밖이다. */
  readonly tools: (lead?: ReactNode) => ReactNode;
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
      // 본문 배치는 패널 머리와 같은 축의 공통 틀이 진다 — 탭이 `fill` 을 선언하지 않으면 가운데 읽기 열이다.
      render: () => <ConversationPanelFrame layout={tab.layout}><PluginErrorBoundary fallback={null}>{tab.render(context)}</PluginErrorBoundary></ConversationPanelFrame>,
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
  // 대화의 동작은 Operation 대화처럼 머리 pill 안에 선다 — 제목 문과 갈라 중첩 버튼을 만들지 않는다.
  // 지구본은 도구 캡슐 맨 앞이다. 플러그인 대화에는 CLI/채팅 전환이 없다.
  const actions = descriptor.actions?.(context) ?? null;
  const hasActions = actions !== null && actions !== false;
  // 플릿 브라우저는 Desktop 의 것이다 — 웹 브라우저 Console 에서는 지구본을 세우지 않는다(시안 v2 규칙 g).
  const browser = sessionBrowser === null || !isDesktopShell() ? null : <SurfaceBrowserButton session={sessionBrowser} language={language} splitOpen={browserSplitOpen} />;
  // 대화의 주인에게 몽글 아바타가 있으면 pill 도 그 아바타다(Operation 대화의 pill 과 같은 20px) — 오른쪽 패널 머리의 64px 아바타와 같은 얼굴.
  const avatar = descriptor.avatar?.(context) ?? null;
  return (
    <div className="conversation-column">
      <div className="conversation-pill-row">
        <div className="conversation-pill">
          <button type="button" className="conversation-pill-details" onClick={onToggleDetails} aria-label={t("conversation.pill.detailsAria", { title })}>
            {avatar
              ? <KeyedAvatar avatarKey={avatar.key} role={avatar.role} state={avatar.state ?? "idle"} size={20} label={avatar.label} decorative className="conversation-pill-mark" />
              : descriptor.mark ? <span className="conversation-pill-surface-mark" aria-hidden="true">{descriptor.mark()}</span> : null}
            <span className="conversation-pill-title">{title}</span>
            {subtitle ? <span className="conversation-pill-sub">· {subtitle}</span> : null}
          </button>
          {hasActions ? <span className="conversation-pill-controls"><PluginErrorBoundary fallback={null}>{actions}</PluginErrorBoundary></span> : null}
        </div>
        {tools(browser)}
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
  /** 머리 줄 도구 캡슐. 지구본(lead)을 넘기면 캡슐 맨 앞, 「⋯」 밖이다. */
  readonly tools: (lead?: ReactNode) => ReactNode;
}) {
  const t = useT();
  const capabilities = useHostCapabilities();
  const clusterIndex = useClusterIndex();
  const bodyRenderer = useConversationBodyRenderer();
  const captionRenderer = useConversationCaptionRenderer();
  // 본문이 덮는 화면(그룹 대화의 전언 대화 화면)이 이 pill 을 잠깐 제 내용으로 바꾼다 — 크로스페이드와 폭 전환은 pill-takeover 가 진다.
  const pillRef = useRef<HTMLDivElement | null>(null);
  const pillTakeover = usePillTakeoverPhase(useConversationPillTakeover(operation.id));
  const pillTaken = pillTakeover.phase === "in";
  usePillMorphWidth(pillRef, pillTaken ? pillTakeover.shown?.key ?? null : null);
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
  // 칸이 여는 브라우저의 주인은 늘 이 대화의 루트다 — 구성원(자식 세션)은 Operation 이 아니라 루트의 브라우저를 함께 쓰므로,
  // 구성원 원장을 보는 중에 지구본을 눌러도 그룹채팅과 같은 탭 집합이 열린다.
  // 칸은 이 대화의 도구 분할에 선다 — 대화 키가 이미 이 루트라 주인을 따로 싣지 않는다.
  const openOperationBrowser = useCallback(() => { openWorkbenchBrowser(); }, []);
  const closeBrowserSplit = useCallback(() => { closeWorkbenchBrowser(); }, []);
  // pill 의 지구본: 칸이 비어 있으면 이 대화의 Session 브라우저를 바로 열고, 칸이 서 있으면 걷는다.
  const onCaptionCompanion = useCallback((companionPanelId: string, visible: boolean) => {
    if (companionPanelId !== BROWSER_COMPANION_ID) return;
    if (!visible) { closeBrowserSplit(); return; }
    openOperationBrowser();
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
  const captionRender = {
    active: config.active,
    capabilities,
    geometry,
    operation: bodyOwner,
    theme: state.activeTheme,
    language,
    viewportZoom: 1,
    runtimeState,
    onActivate: activate,
    onClose: config.onClose,
    onGeometryChange: setGeometry,
    onRequestCompanions: noop,
    companionsOpen: browserSplitOpen,
    hiddenCompanionPanelIds: hiddenCompanions,
    onSetCompanionPanelVisible: onCaptionCompanion,
    companionPanelIds: CONVERSATION_COMPANION_PANEL_IDS,
    bodyLive: true as const,
  };
  const captionView = captionRenderer?.({ operation, bodyOperation: bodyOwner, nestedOperations: nested, language }) ?? null;
  const viewSwitch = descriptor?.captionViewSwitch === undefined ? null : (
    <PluginErrorBoundary fallback={<></>}>
      <PluginOperationRenderer {...captionRender} render={descriptor.captionViewSwitch} />
    </PluginErrorBoundary>
  );
  // 지구본(tools-lead)은 플릿 브라우저 문이다 — 웹 브라우저 Console 에서는 세우지 않는다(시안 v2 규칙 g).
  const toolsLead = descriptor?.captionToolsLead === undefined || !isDesktopShell() ? null : (
    <PluginErrorBoundary fallback={<></>}>
      <PluginOperationRenderer {...captionRender} render={descriptor.captionToolsLead} />
    </PluginErrorBoundary>
  );
  const shelf = descriptor?.captionActions === undefined ? null : (
    <PluginErrorBoundary fallback={<></>}>
      <PluginOperationRenderer {...captionRender} render={descriptor.captionActions} />
    </PluginErrorBoundary>
  );
  const hasPillControls = captionView !== null || viewSwitch !== null;
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
        <div className="conversation-pill" ref={pillRef} data-takeover={pillTaken || undefined}>
          <button
            type="button"
            className="conversation-pill-details"
            onClick={onToggleDetails}
            aria-label={t("conversation.pill.detailsAria", { title: operation.title })}
            inert={pillTaken || undefined}
          >
            <OperationAvatar operation={operation} state={operationMongleState(operation.id, state, clusterIndex.clusters)} size={20} label={operation.title} decorative className="conversation-pill-mark" />
            <span className="conversation-pill-title">{operation.title}</span>
            {bodyOwner !== operation ? <span className="conversation-pill-sub">› {clusterRoot?.cluster.conversation?.members.find((member) => member.operationId === bodyOwner.id)?.name ?? clusterRoot?.formation.byOperationId.get(bodyOwner.id)?.member.name ?? bodyOwner.title}</span> : null}
            {memberCount > 0 ? (
              <span className="conversation-pill-sub">· {t(memberCount === 1 ? "conversation.pill.members_one" : "conversation.pill.members_other", { count: memberCount })}</span>
            ) : null}
          </button>
          {hasPillControls ? <span className="conversation-pill-controls" inert={pillTaken || undefined}>{captionView}{viewSwitch}</span> : null}
          <PillTakeoverLayer {...pillTakeover} />
        </div>
        {/* 사용 표식·시선 말풍선은 pill 바로 뒤의 면 없는 선반에 남긴다. Operation 메뉴는 사이드바 우클릭이 맡는다. */}
        <span className="conversation-caption-shelf"><OperationCaptionContributions operation={bodyOwner} language={language} surface="caption" />{shelf}</span>
        {tools(toolsLead)}
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

// ── 도구 분할의 브라우저 ─────────────────────────────────────────────────────

function useViewportSize(): { readonly width: number; readonly height: number } {
  const read = () => (typeof window === "undefined" ? { width: 1440, height: 900 } : { width: window.innerWidth, height: window.innerHeight });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize((current) => {
      const next = read();
      return current.width === next.width && current.height === next.height ? current : next;
    });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** 플러그인 대화(사령관)가 쓰는 Session 브라우저 — 플러그인 id 는 호스트 등록 id, scopeId 는 그 대화가 돌려준 세션 scope 다. */
interface SurfaceSessionBrowser {
  readonly pluginId: string;
  readonly scopeId: string;
  /** 이 대화의 세션 열쇠 — `<pluginId>:<scopeId>`. */
  readonly subjectKey: string;
}

/**
 * 플러그인 대화(사령관)의 브라우저 지구본 — Operation 대화의 지구본과 같은 글리프·크기·말풍선이다. 누르면 이 대화의 도구 분할에
 * 브라우저 칸을 열고 닫는다(세션이 아직 서지 않았으면 칸이 그 까닭을 말한다). 엔진이 없거나 공유 중이면 지구본 자체가 닫힌 채
 * 까닭을 말한다. 웹 브라우저 Console 에서는 서지 않는다(시안 v2 규칙 g).
 */
function SurfaceBrowserButton({ language, splitOpen }: {
  readonly session: SurfaceSessionBrowser;
  readonly language: "en" | "ko";
  readonly splitOpen: boolean;
}) {
  const t = getBrowserT(language);
  const engine = useBrowserEngine();
  const engineMissing = engine !== null && !engine.available;
  const base = engineMissing
    ? t(engine.reason === "shared" ? "terminal.browser.shared" : isDesktopShell() ? "terminal.browser.desktopMissing" : "terminal.browser.desktopOnly")
    : t(splitOpen ? "terminal.browser.exit" : "terminal.browser.open");
  return (
    <span className="conversation-pill-browser">
      <CaptionActionButton actionId="browser" label={base} pressed={splitOpen} disabled={engineMissing} onClick={toggleWorkbenchBrowser}>
        <CaptionBrowserUseGlyph />
      </CaptionActionButton>
    </span>
  );
}
