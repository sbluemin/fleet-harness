import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConversationSurfaceContext, ConversationSurfaceDescriptor, OperationKindDescriptor } from "@fleet-console/sdk/plugin";

import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import type { CanvasArenaInsets } from "../canvas/canvas-store.js";
import type { GroupContextMenuAlign } from "../canvas/group-context-menu.js";
import type { ConsoleState, OperationGeometry, OperationNode } from "../../../../core/client/src/integration/types.js";
import { openQuickLaunch, requestOperationKeyboardFocus, selectNestedBody, setActiveOperation, toggleOperationSearch } from "../../../../core/client/src/integration/store.js";
import { DEPUTY_COMMAND_BAND_ENTRY_ID, usePluginRegistry } from "../../../../core/client/src/integration/plugin-registry.js";
import { useHostCapabilities } from "../../../../core/client/src/integration/use-host-capabilities.js";
import { OperationBodySlot, type OperationBodyConfig } from "../../../../core/client/src/chrome/mobile/operation-body-pool.js";
import { ConsoleHelpMenu, HostSwitcher } from "../../../../core/client/src/chrome/components/command-band-system-cluster.js";
import { EnvironmentDiagnosticsButton } from "../../../../core/client/src/chrome/components/command-band.js";
import { ViewModeToggle } from "../../../../core/client/src/chrome/components/view-mode-toggle.js";
import { isDesktopShell } from "../../../../core/client/src/integration/desktop-shell.js";
import { ToolbarSettingsButton } from "../../../../core/client/src/chrome/toolbar/console-toolbar.js";
import { RailToolIcons, type RailToolContext } from "../../../../core/client/src/chrome/rail/right-rail.js";
import { closeRailPanel, getRailStoreSnapshot, openRailPanel, useRailActivePanelId } from "../../../../core/client/src/chrome/rail/rail-store.js";
import { mountConversationOperationTabsHost, registerConversationOperationTab } from "../../../../core/client/src/chrome/rail/operation-tabs.js";
import { useDesktopRailEntries } from "../../../../core/client/src/chrome/pane/pane-registry.js";
import { SETTINGS_RAIL_ENTRY_ID } from "../../../settings/client/settings-entry.js";
import { OperationNameMark } from "../../../execution/client/components/operation-name-mark.js";
import { pluginRuntimeState, resolveOperationActivity } from "../../../execution/client/operation-activity.js";
import { setChatReadingWidthDefault } from "../../../execution/client/terminal/shared/terminal-preferences.js";
import { OperationCaptionContributions } from "../operation-contributions.js";
import { ClusterNodeRail } from "../cluster-node-rail.js";
import { useClusterIndex } from "../operation-clusters.js";
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
import { publishConversationSubject, useConversationBodyRenderer, useConversationSubject } from "./conversation-slots.js";
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

/**
 * 아래쪽 줄 — 환경 진단(밴드 왼쪽 브랜드 마크), 호스트(원격 연결), 사용량 요약, 보기 모드(밴드 오른쪽), 도움말, 설정.
 * 보관함은 바로 위 기존 줄이 그대로 맡는다. 메뉴·팝오버는 이 줄에서 위로 열린다(conversation.css).
 */
export function ConversationSideBarBottom({ connection }: { readonly connection: ConsoleState["connection"] }) {
  const t = useT();
  return (
    <div className="conversation-side-bottom" role="group" aria-label={t("conversation.side.systemAria")}>
      <div className="conversation-side-bottom-row">
        <EnvironmentDiagnosticsButton className="conversation-side-env" />
        <span className="conversation-side-host">
          <HostSwitcher />
          {connection !== "live" ? <span className="conversation-side-link" data-link-state={connection} aria-hidden="true" /> : null}
        </span>
        <span className="conversation-side-bottom-spacer" aria-hidden="true" />
        {/* 밴드 오른쪽의 보기 모드 선택 — 밴드와 같은 조건(Desktop 셸이 아닐 때)으로 선다. */}
        {!isDesktopShell() ? <ViewModeToggle className="command-band-button conversation-side-viewmode" /> : null}
        <ConsoleHelpMenu />
        <ToolbarSettingsButton canvas />
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
      const items = [...row.querySelectorAll<HTMLElement>(".right-rail-ico, .right-rail-divider")];
      for (const item of items) item.removeAttribute("data-overflow");
      const more = moreRef.current;
      const limit = row.clientWidth - (more ? more.offsetWidth + 8 : 0);
      const rowLeft = row.getBoundingClientRect().left;
      const fits = (item: HTMLElement) => item.getBoundingClientRect().right - rowLeft <= row.clientWidth;
      const everythingFits = items.every(fits);
      const hidden: OverflowTab[] = [];
      if (!everythingFits) {
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
      {/* 맨 위 줄 — 작전구역 도구는 글리프 단추(이름은 툴팁·aria-label), 오른쪽 끝은 닫기. 넘치는 도구는 「⋯」에 모인다. */}
      <div className="conversation-panel-toolbar">
        <div className="conversation-panel-tools" ref={rowRef}>
          <RailToolIcons context={context} variant="icons" scope="tools" />
        </div>
        <span className={`conversation-panel-more-wrap${overflow.length > 0 ? "" : " is-idle"}`}>
          <button
            type="button"
            ref={moreRef}
            className={`conversation-round conversation-panel-more${hiddenActive ? " is-active" : ""}`}
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
        <button type="button" className="conversation-round conversation-panel-close" onClick={() => { const active = getRailStoreSnapshot().activePanelId; if (active !== null) closeRailPanel(active); }} aria-label={t("conversation.panel.close")} title={t("conversation.panel.close")}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>
      <ConversationPanelIdentity />
      {/* 가운데 칸 대상의 탭(사령관의 행위 기록·지시·정보·설정 등) — Grok 의 세부 정보 세그먼트 자리, 글자 탭이다. */}
      <div className="conversation-panel-tabs">
        <RailToolIcons context={context} variant="text" scope="core" />
      </div>
    </div>
  );
}

/** 오른쪽 패널 머리 가운데 — 지금 가운데 칸 대상의 표식과 이름(Grok 세부 정보의 아바타·이름 자리). 대상이 없으면 서지 않는다. */
function ConversationPanelIdentity() {
  const subject = useConversationSubject();
  const surface = useConversationSurface();
  const { conversationSurfaces } = usePluginRegistry();
  const state = useConsoleState();
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const descriptor = subject === null && surface !== null ? conversationSurfaces.find((candidate) => candidate.id === surface.surfaceId) ?? null : null;
  if (subject !== null) {
    return (
      <div className="conversation-panel-identity">
        <OperationNameMark operation={subject} status={resolveOperationActivity(subject, state.operationRuntime)} decorative className="conversation-panel-identity-mark" />
        <strong className="conversation-panel-identity-name">{subject.title}</strong>
      </div>
    );
  }
  if (descriptor !== null && surface !== null) {
    const context = { params: surface.params, language, theme: state.activeTheme, close: () => closeConversationSurface(descriptor.id) } as const;
    return (
      <div className="conversation-panel-identity">
        {descriptor.mark ? <span className="conversation-panel-identity-mark is-surface" aria-hidden="true">{descriptor.mark()}</span> : null}
        <strong className="conversation-panel-identity-name">{descriptor.title(context)}</strong>
      </div>
    );
  }
  return null;
}

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
  readonly onOpenOperationMenu: (operationId: string, anchor: DOMRect, returnFocus?: HTMLElement | null, align?: GroupContextMenuAlign) => void;
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

export function ConversationStage({ state, insets, language, operationKinds, onClose, onOpenOperationMenu }: ConversationStageProps) {
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
          onOpenOperationMenu={onOpenOperationMenu}
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
  if (usage.length === 0) return null;
  return (
    <div className="conversation-quota" role="group" aria-label={t("conversation.quota.aria")}>
      {usage.map((entry) => (
        <PluginErrorBoundary key={entry.id} fallback={null}>
          <PluginEntry render={entry.render} />
        </PluginErrorBoundary>
      ))}
    </div>
  );
}

/**
 * 가운데 칸의 플러그인 대화 — 머리 pill 은 호스트가, 본문은 플러그인이 그린다. 대화가 선 동안 플러그인 탭이 오른쪽
 * 패널 앞 묶음에 서고, 패널이 닫혀 있으면 기본 탭을 연다.
 */
function ConversationSurfaceColumn({ descriptor, selection, language, theme, onToggleDetails }: {
  readonly descriptor: ConversationSurfaceDescriptor;
  readonly selection: ConversationSurfaceSelection;
  readonly language: "en" | "ko";
  readonly theme: ConversationSurfaceContext["theme"];
  readonly onToggleDetails: () => void;
}) {
  const t = useT();
  const context = useMemo<ConversationSurfaceContext>(() => ({
    params: selection.params,
    language,
    theme,
    close: () => closeConversationSurface(descriptor.id),
  }), [descriptor.id, language, selection.params, theme]);
  // 탭은 레일 패널로 선다 — 독점 슬롯·폭 기억·밀어내기를 그대로 받는다. 대화가 걷히면 탭도, 그 탭이 연 패널도 걷힌다.
  useEffect(() => {
    const tabs = descriptor.tabs ?? [];
    const disposers = tabs.map((tab, order) => registerConversationOperationTab({
      id: tab.id,
      title: tab.title,
      icon: tab.icon ?? null,
      order,
      ...(tab.defaultWidth === undefined ? {} : { defaultWidth: tab.defaultWidth }),
      render: () => <PluginErrorBoundary fallback={null}>{tab.render(context)}</PluginErrorBoundary>,
    }));
    return () => {
      for (const dispose of disposers) dispose();
      const active = getRailStoreSnapshot().activePanelId;
      if (active !== null && tabs.some((tab) => tab.id === active)) closeRailPanel(active);
    };
  }, [context, descriptor]);
  // 연 순간(같은 대화를 다시 연 때도) 패널이 닫혀 있으면 기본 탭을 연다.
  useEffect(() => {
    if (descriptor.defaultTab === undefined || getRailStoreSnapshot().activePanelId !== null) return;
    openRailPanel(descriptor.defaultTab);
  }, [descriptor.defaultTab, selection.nonce]);
  const title = descriptor.title(context);
  const subtitle = descriptor.subtitle?.(context) ?? null;
  return (
    <div className="conversation-column">
      <div className="conversation-pill-row">
        <button type="button" className="conversation-pill" onClick={onToggleDetails} aria-label={t("conversation.pill.detailsAria", { title })}>
          {descriptor.mark ? <span className="conversation-pill-surface-mark" aria-hidden="true">{descriptor.mark()}</span> : null}
          <span className="conversation-pill-title">{title}</span>
          {subtitle ? <span className="conversation-pill-sub">· {subtitle}</span> : null}
        </button>
      </div>
      <div className="conversation-body is-surface">
        <PluginErrorBoundary fallback={null}>{descriptor.render(context)}</PluginErrorBoundary>
      </div>
    </div>
  );
}

function ConversationColumn({ state, operation, language, operationKinds, warRoom, onToggleDetails, onClose, onOpenOperationMenu }: {
  readonly state: ConsoleState;
  readonly operation: OperationNode;
  readonly language: "en" | "ko";
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly warRoom: { readonly waiting: number; readonly next: () => void } | null;
  readonly onToggleDetails: () => void;
  readonly onClose: (operationId: string) => void;
  readonly onOpenOperationMenu: (operationId: string, anchor: DOMRect, returnFocus?: HTMLElement | null, align?: GroupContextMenuAlign) => void;
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
  const activity = resolveOperationActivity(operation, state.operationRuntime);
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
          <OperationNameMark operation={operation} status={activity} className="conversation-pill-mark" />
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
                bodyLive
                render={descriptor.captionActions}
              />
            </PluginErrorBoundary>
          )}
          <button
            type="button"
            className="conversation-round conversation-pill-menu"
            aria-label={t("canvas.frame.openMenuAria", { title: operation.title })}
            title={t("canvas.frame.openMenuTitle")}
            aria-haspopup="menu"
            onClick={(event) => { activate(); onOpenOperationMenu(operation.id, event.currentTarget.getBoundingClientRect(), event.currentTarget, "end"); }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="12.5" cy="8" r="1.2" fill="currentColor" /></svg>
          </button>
        </span>
      </div>
      {/* 그룹 대화가 본문을 맡으면 구성원은 pill 의 「구성원 n」과 오른쪽 「구성원」 탭이 말한다(원장 보기도 그 탭) — 노드 줄을 따로
          세우지 않는다. 본문 렌더러가 없는 묶음만 노드 줄로 구성원 본문을 고른다. */}
      {clusterRoot && custom === null ? (
        <div className="conversation-nodes">
          <ClusterNodeRail
            layout={clusterRoot}
            current={clusterRoot.formation.byOperationId.has(chosen ?? "") ? chosen! : operation.id}
            rootActivity={activity}
            onPick={(operationId) => {
              selectNestedBody(operation.id, operationId);
              setActiveOperation(operation.id);
              requestOperationKeyboardFocus(operation.id);
            }}
          />
        </div>
      ) : null}
      <div className="conversation-body" ref={bodyRef} onPointerDownCapture={activate}>
        {custom ?? defaultBody}
      </div>
    </div>
  );
}

const NO_HIDDEN_COMPANIONS: readonly string[] = [];
