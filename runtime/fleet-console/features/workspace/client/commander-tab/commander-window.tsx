import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronGlyph, usePointerDrag } from "@fleet-console/ui/react";
import { focusFloatingWindow, useFloatingWindowZ } from "@fleet-console/ui/store";

import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useHostCapabilities } from "../../../../core/client/src/integration/use-host-capabilities.js";
import { ObjectiveBodySlot, type ObjectiveBodyConfig } from "../../../../core/client/src/chrome/mobile/objective-body-pool.js";
import { pluginRuntimeState } from "../../../execution/client/objective-activity.js";
import { getT as getObjectivesT } from "../../../objectives/client/i18n/index.js";
import {
  DETAIL_TABS,
  ObjectiveDetail,
  type DetailSection,
  type DetailTab,
} from "../../../objectives/client/objectives-panel.js";
import {
  loadBoard,
  objectivesApi,
  post,
  useObjectiveBoard,
  useObjectiveSummaries,
} from "../../../objectives/client/objectives-state.js";
import { commanderObjectiveId, useClusterIndex } from "../objective-clusters.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { useConversationBodyRenderer } from "../conversation/conversation-slots.js";
import { useCommanderRows } from "./commander-rows.js";
import { clusterRowSummary, ClusterRowAvatar } from "../sidebar/side-bar-cluster-row.js";
import { ObjectiveAvatar, objectiveRecordMongleState } from "../avatars.js";
import "./commander-window.css";

// 오른쪽 배치에서 목표 섹션을 고르면 뜨는 지휘관 창. 가운데는 사령관 대화를 유지하고, 다른 행을 고르면
// 같은 창이 그 지휘관으로 바뀐다(창 하나). 왼쪽 배치에서도 가운데 채팅 머리 칩의 「팝업으로 띄우기」로 쓴다.
type CommanderSelection = {
  readonly commodoreId: string;
  readonly objectiveId: string;
  readonly opener: HTMLElement | null;
};
let selection: CommanderSelection | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => selection;
const COMMANDER_WINDOW_ID = "commander-window";
const RECT_KEY = "fleet-console.commanderWindow.rect";

function updateSelection(next: CommanderSelection | null) {
  selection = next;
  // 나중에 손댄 창이 위다 — 지휘관 창을 열거나 고르면 결과물 창보다 앞으로 온다.
  if (next !== null) focusFloatingWindow(COMMANDER_WINDOW_ID);
  for (const listener of listeners) listener();
}

export function openCommanderWindow(commodoreId: string, objectiveId: string, opener: HTMLElement | null = null): void {
  updateSelection({ commodoreId, objectiveId, opener });
}

function dismissWindow(): void {
  updateSelection(null);
}

function visibleComposer(): HTMLTextAreaElement | undefined {
  return [...document.querySelectorAll<HTMLTextAreaElement>(".agent-chat-composer-input, .group-composer-input, .fc-composer-input")]
    .find((node) => !node.disabled && node.getClientRects().length > 0 && !node.closest("[hidden], [inert]"));
}

function closeWindow(): void {
  const opener = selection?.opener;
  updateSelection(null);
  if (opener?.isConnected && opener.getClientRects().length && !opener.closest("[hidden], [inert]")) {
    opener.focus({ preventScroll: true });
    return;
  }
  // 연 단추가 사라졌으면(탭 전환 등) 현재 화면의 채팅 입력으로 돌아간다.
  visibleComposer()?.focus({ preventScroll: true });
}

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
type Direction = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const DIRECTIONS: readonly Direction[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const GAP = 12, MIN_W = 360, MIN_H = 260, BOARD_FOLD_W = 720;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
function fit(rect: Rect): Rect {
  const maxW = Math.max(1, window.innerWidth - GAP * 2), maxH = Math.max(1, window.innerHeight - GAP * 2);
  const w = clamp(rect.w, Math.min(MIN_W, maxW), maxW), h = clamp(rect.h, Math.min(MIN_H, maxH), maxH);
  return { x: clamp(rect.x, GAP, window.innerWidth - GAP - w), y: clamp(rect.y, GAP, window.innerHeight - GAP - h), w, h };
}
function defaultRect(): Rect {
  return fit({ x: Math.round((window.innerWidth - 880) / 2), y: 72, w: 880, h: Math.min(580, window.innerHeight - 160) });
}
function initialRect(): Rect {
  try {
    const value = JSON.parse(localStorage.getItem(RECT_KEY) ?? "null") as Rect | null;
    if (value && [value.x, value.y, value.w, value.h].every((part) => typeof part === "number" && Number.isFinite(part))) return fit(value);
  } catch { /* 저장소 없이도 화면 안에서 연다. */ }
  return defaultRect();
}
function saveRect(rect: Rect) { try { localStorage.setItem(RECT_KEY, JSON.stringify(rect)); } catch { /* 선택적 편의 상태 */ } }

/** 대화 중심 화면의 가운데 칸이 그리는 떠 있는 지휘관 창. 폰 셸에는 서지 않는다. */
export function CommanderWindowHost({ language }: { readonly language: "en" | "ko" }) {
  const opened = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (opened === null) return null;
  return createPortal(<CommanderWindow key={`${opened.commodoreId}:${opened.objectiveId}`} opened={opened} language={language} />, document.body);
}

function CommanderWindow({ opened, language }: { readonly opened: CommanderSelection; readonly language: "en" | "ko" }) {
  const t = useT();
  const ot = getObjectivesT(language);
  const locale = useConsoleLocale();
  const state = useConsoleState();
  const capabilities = useHostCapabilities();
  const rootRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState(initialRect);
  const [dragging, setDragging] = useState(false);
  const [boardOpen, setBoardOpen] = useState(true);
  const drag = usePointerDrag();
  // 결과물 창과 겹치면 나중에 손댄 쪽이 위다.
  const zIndex = useFloatingWindowZ(COMMANDER_WINDOW_ID, 59);
  const { commodoreId, objectiveId } = opened;

  const record = state.objectiveRecords.find((candidate) => candidate.id === objectiveId) ?? null;
  const clusterIndex = useClusterIndex();
  const { sorted } = useCommanderRows(commodoreId, objectiveId);
  const row = useMemo(() => {
    for (const item of sorted) {
      if (commanderObjectiveId(item.layout.cluster) === objectiveId) return item;
    }
    return null;
  }, [sorted, objectiveId]);
  const summary = row ? clusterRowSummary(row, locale, t) : null;
  const title = row?.layout.cluster.title ?? record?.title ?? ot("objectives.results.title");
  const commanderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of sorted) {
      const id = commanderObjectiveId(item.layout.cluster);
      if (id !== null) ids.add(id);
    }
    return ids;
  }, [sorted]);
  const openBoardObjective = (id: string) => {
    if (commanderIds.has(id)) updateSelection({ commodoreId, objectiveId: id, opener: selection?.opener ?? null });
    else openCommanderConversation(commodoreId, id);
  };

  const board = useObjectiveBoard(commodoreId);
  useEffect(() => { const api = objectivesApi(); if (api !== null) void loadBoard(api, commodoreId); }, [commodoreId]);
  const objective = board.objectives.find((candidate) => candidate.id === objectiveId) ?? null;
  const narrow = rect.w < BOARD_FOLD_W;

  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, [opened.opener, opened.objectiveId]);
  useEffect(() => {
    const resize = () => setRect((current) => fit(current));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !root.contains(document.activeElement) || root.closest("[inert]") || event.defaultPrevented || event.isComposing) return;
      if (event.target instanceof Element && (event.target.closest("input, textarea, select, [contentEditable=true]"))) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeWindow(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  const start = (event: ReactPointerEvent<HTMLElement>, direction?: Direction) => {
    if (event.button !== 0 || !event.isPrimary || (!direction && (event.target as Element).closest("button, select, a"))) return;
    event.preventDefault();
    rootRef.current?.focus({ preventScroll: true });
    const origin = rect, px = event.clientX, py = event.clientY;
    let latest = origin, frame = 0;
    drag(event, event.currentTarget, {
      onStart: () => setDragging(true),
      onMove: (next) => {
        const dx = next.clientX - px, dy = next.clientY - py;
        let { x, y, w, h } = origin;
        if (!direction) { x += dx; y += dy; }
        else {
          if (direction.includes("e")) w = clamp(origin.w + dx, MIN_W, window.innerWidth - GAP - origin.x);
          if (direction.includes("s")) h = clamp(origin.h + dy, MIN_H, window.innerHeight - GAP - origin.y);
          if (direction.includes("w")) { x = clamp(origin.x + dx, GAP, origin.x + origin.w - MIN_W); w = origin.x + origin.w - x; }
          if (direction.includes("n")) { y = clamp(origin.y + dy, GAP, origin.y + origin.h - MIN_H); h = origin.y + origin.h - y; }
        }
        latest = fit({ x, y, w, h });
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; setRect(latest); });
      },
      onEnd: (end) => {
        cancelAnimationFrame(frame); setDragging(false);
        setRect(end ? latest : fit(origin));
        if (end) saveRect(latest);
      },
    });
  };

  const showBoard = boardOpen;
  // 폭 720px 미만이면 보드를 접는다 — 「보드」 단추로 펼치면 본문 위에 덮는다.
  const wasNarrow = useRef(narrow);
  useEffect(() => {
    if (narrow && !wasNarrow.current) setBoardOpen(false);
    wasNarrow.current = narrow;
  }, [narrow]);
  const openInCenter = () => {
    dismissWindow();
    openCommanderConversation(commodoreId, objectiveId);
    visibleComposer()?.focus({ preventScroll: true });
  };

  return <div ref={rootRef} className={`commander-window${narrow ? " is-narrow" : ""}${dragging ? " is-dragging" : ""}`}
    role="dialog" aria-label={`${t("commanderWindow.title")} · ${title}`} tabIndex={-1}
    onPointerDownCapture={() => focusFloatingWindow(COMMANDER_WINDOW_ID)}
    style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex }}>
    <header className="commander-window-head" onPointerDown={(event) => start(event)}>
      {row ? <span className="commander-window-face"><ClusterRowAvatar item={row} rowState={summary!.state} label={summary!.label} size={26} decorative /></span>
        : record ? <span className="commander-window-face"><ObjectiveAvatar objectiveRecord={record} state={objectiveRecordMongleState(record.id, state, clusterIndex.clusters)} size={26} label={title} decorative /></span> : null}
      <strong className="commander-window-title">{title}</strong>
      {summary ? <span className="commander-window-status">{summary.conversationLine}</span> : null}
      <button type="button" className={`commander-window-button${boardOpen ? " is-active" : ""}`} aria-pressed={boardOpen} aria-label={t("commanderWindow.board")} title={t("commanderWindow.board")} onClick={() => setBoardOpen((open) => !open)}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M9.5 2.5v11" /></svg>
      </button>
      <button type="button" className="commander-window-button" aria-label={t("commanderWindow.openInCenter")} title={t("commanderWindow.openInCenter")} onClick={openInCenter}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></svg>
      </button>
      <button type="button" className="commander-window-button" aria-label={t("commanderWindow.resetSize")} title={t("commanderWindow.resetSize")} onClick={() => { const next = defaultRect(); setRect(next); saveRect(next); }}>↺</button>
      <button type="button" className="commander-window-button" aria-label={t("commanderWindow.close")} title={t("commanderWindow.close")} onClick={closeWindow}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </header>
    <div className="commander-window-body">
      <div className="commander-window-chat">
        {record ? <CommanderWindowChat key={record.id} recordId={record.id} language={language} theme={state.activeTheme} /> : <p className="commander-window-empty" role="status">{t("commanderWindow.noConversation")}</p>}
      </div>
      {showBoard ? <div className="commander-window-board">
        {objective ? <CommanderWindowBoard key={objective.id} commodoreId={commodoreId} objectiveId={objective.id} language={language} openBoardObjective={openBoardObjective} /> : <p className="commander-window-empty" role="status">{ot("objectives.results.window.empty")}</p>}
      </div> : null}
    </div>
    {DIRECTIONS.map((direction) => <span key={direction} className={`commander-window-resize is-${direction}`} aria-hidden="true" onPointerDown={(event) => start(event, direction)} />)}
  </div>;
}

// ── 왼쪽: 지휘관 채팅 — 가운데 대화의 본문 렌더를 그대로 쓴다. 창은 활성 대화를 바꾸지 않는다. ──

function CommanderWindowChat({ recordId, language, theme }: { readonly recordId: string; readonly language: "en" | "ko"; readonly theme: "light" | "dark" }) {
  const state = useConsoleState();
  const capabilities = useHostCapabilities();
  const bodyRenderer = useConversationBodyRenderer();
  const record = state.objectiveRecords.find((candidate) => candidate.id === recordId) ?? null;
  const [geometry, setGeometry] = useState({ x: 0, y: 0, width: 720, height: 640, zIndex: 0 });
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
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => { frame = 0; update(); });
    });
    observer.observe(element);
    return () => { observer.disconnect(); if (frame !== 0) cancelAnimationFrame(frame); };
  }, []);
  if (record === null) return null;
  const runtimeState = pluginRuntimeState(state.objectiveRecordRuntime, state.objectiveRecordRuntimeHydration, record.id);
  const config: ObjectiveBodyConfig = {
    active: false,
    geometry,
    objectiveRecord: record,
    runtimeState,
    bodyLive: true,
    theme,
    language,
    zoom: 1,
    onActivate: () => {},
    onClose: () => dismissWindow(),
    onGeometryChange: setGeometry,
  };
  const defaultBody = <ObjectiveBodySlot key={record.id} objectiveId={record.id} config={config} className="commander-window-chat-slot" />;
  const custom = bodyRenderer?.({ objectiveRecord: record, bodyObjective: record, nestedObjectiveRecords: [], language, defaultBody, navigate: capabilities.navigate }) ?? null;
  return <div className="commander-window-chat-body" ref={bodyRef}>{custom ?? defaultBody}</div>;
}

// ── 오른쪽: 그 지휘관의 목표 보드 — 목표·구성원·결과물 탭. 창 안에서만 기억한다. ──

function CommanderWindowBoard({ commodoreId, objectiveId, language, openBoardObjective }: {
  readonly commodoreId: string;
  readonly objectiveId: string;
  readonly language: "en" | "ko";
  /** 보드 안에서 목표를 고르면 — 지휘관은 같은 창, 구성원은 가운데에서 연다. */
  readonly openBoardObjective: (objectiveId: string) => void;
}) {
  const ot = getObjectivesT(language);
  const board = useObjectiveBoard(commodoreId);
  const objectiveRecords = useObjectiveSummaries();
  const [tab, setTab] = useState<DetailTab>("goal");
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({});
  const [groupCollapsed, setGroupCollapsed] = useState<Readonly<Record<string, boolean>>>({});
  const detailRef = useRef<HTMLElement | null>(null);
  const api = objectivesApi();
  const objective = api === null ? null : board.objectives.find((candidate) => candidate.id === objectiveId) ?? null;
  useEffect(() => { if (api !== null) void loadBoard(api, commodoreId); }, [api, commodoreId]);
  if (api === null || objective === null) return <p className="commander-window-empty" role="status">{ot("objectives.results.window.empty")}</p>;
  // 중앙 하단 알림은 두지 않는다 — 결과는 화면 자체가 말한다. 호출부는 남겨 두되 아무것도 띄우지 않는다.
  const toast = (_text: string, _undo?: () => Promise<void>) => undefined;
  const call = async <R,>(path: string, body: Record<string, unknown>): Promise<R | null> => {
    try { return await post<R>(api, path, { ...body, language }); }
    catch { return null; }
  };
  const modeLabel = (mode: "direct" | "coordinate" | "mixed") => ot(mode === "direct" ? "objectives.mode.direct" : mode === "coordinate" ? "objectives.mode.coordinate" : "objectives.mode.mixed");
  const stateLabel = (activity: string) => ot((["running", "awaiting", "idle", "ended", "closed"].includes(activity) ? `objectives.state.${activity}` : "objectives.state.unknown") as Parameters<typeof ot>[0]);
  const objectiveRecordOf = (id: string) => objectiveRecords.find((candidate) => candidate.id === id) ?? null;
  const shownActivity = (activity: string): string => (activity === "background" ? "running" : activity);
  const objectiveRecordTitle = (id: string) => objectiveRecordOf(id)?.title ?? "—";
  const objectiveRecordState = (id: string): string => shownActivity(objectiveRecordOf(id)?.activity ?? "closed");
  const objectiveRecordOwnState = (id: string): string => {
    const record = objectiveRecordOf(id);
    return record ? shownActivity(record.ownActivity ?? record.activity) : "closed";
  };
  const busy = objective !== null && !objective.done && objectiveRecordState(objective.id) === "running";
  const request = (path: string, body: Record<string, unknown>) => post<unknown>(api, path, { ...body, language });
  const onToggleEdge = async (from: string, to: string, linked?: boolean) => {
    await call<{ objective: { id: string }; linked: boolean }>("/edge/toggle", { objectiveId: objective.id, from, to, linked });
  };
  return <>
    <div className="commander-window-board-tabs" role="tablist" aria-label={ot("objectives.panel.title")}>
      {DETAIL_TABS.map((id) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={`commander-window-board-tab${tab === id ? " is-active" : ""}`} onClick={() => setTab(id)}>{ot(`objectives.tabs.${id}` as Parameters<typeof ot>[0])}</button>)}
    </div>
    <ObjectiveDetail
      objective={objective}
      t={ot}
      language={language}
      call={call}
      toast={toast}
      modeLabel={modeLabel}
      stateLabel={stateLabel}
      objectiveRecordTitle={objectiveRecordTitle}
      objectiveRecordState={objectiveRecordState}
      objectiveRecordOwnState={objectiveRecordOwnState}
      busy={busy}
      request={request}
      tab={tab}
      onTab={setTab}
      sectionOpen={(key) => key in collapsed ? !collapsed[key] : false}
      onToggleSection={(key) => setCollapsed((current) => ({ ...current, [key]: key in current ? !current[key] : false }))}
      groupOpen={(key) => key in groupCollapsed ? !groupCollapsed[key] : false}
      onToggleGroup={(key) => setGroupCollapsed((current) => ({ ...current, [key]: key in current ? !current[key] : false }))}
      onOpenGroup={(key) => setGroupCollapsed((current) => ({ ...current, [key]: false }))}
      highlightMission={null}
      detailRef={detailRef}
      onToggleEdge={onToggleEdge}
      onOpenObjective={openBoardObjective}
    />
  </>;
}
