import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OperationKindDescriptor } from "@fleet-console/sdk/plugin";

import type { WorkbenchLayout, WorkbenchTile } from "../../../shared/conversation-workbench.js";
import { useT } from "../../../../../core/client/src/i18n/index.js";
import type { ConsoleState, OperationGeometry, OperationNode } from "../../../../../core/client/src/integration/types.js";
import { setActiveOperation, themePolarity } from "../../../../../core/client/src/integration/store.js";
import { useHostCapabilities } from "../../../../../core/client/src/integration/use-host-capabilities.js";
import { useExpandedSurfaceDescriptors } from "../../../../../core/client/src/integration/plugin-registry.js";
import { isDesktopShell } from "../../../../../core/client/src/integration/desktop-shell.js";
import { subscribeConsoleChannel } from "../../../../../core/client/src/integration/operations-sse.js";
import { useMenuButtonKeyboard } from "../../../../../core/client/src/chrome/components/use-menu-button-keyboard.js";
import { MissingSurface, SurfacePanePart, safeExpandedSurfaceTitle, useExpandedSurfaceContext } from "../../../../../core/client/src/chrome/expanded-surface/layer.js";
import { RailSurface } from "../../../../../core/client/src/chrome/pane/rail-surface.js";
import type { RailEntryBinding } from "../../../../../core/client/src/chrome/pane/pane-registry.js";
import type { RailToolContext } from "../../../../../core/client/src/chrome/rail/right-rail.js";
import { pluginRuntimeState } from "../../../../execution/client/operation-activity.js";
import { BROWSER_COMPANION_ID } from "../../../../execution/client/agent/browser-companion.js";
import { resolveSessionBrowserTarget, SessionBrowserCaption, SessionBrowserPanel } from "../../../../browser/client/browser-panel.js";
import { announceNativeViewResize, getNativeViewResize } from "../../../../browser/client/browser-panel-store.js";
import { getT as getBrowserT } from "../../../../browser/client/i18n.js";
import { PluginOperationRenderer } from "../../operation-renderer.js";
import { resolveDropPreview, type DropPreview, type GutterGeometry, type Rect, type TileGeometry, type WorkbenchGeometry } from "./workbench-geometry.js";
import {
  bindWorkbenchCloseGuard,
  cancelWorkbenchClose,
  closeWorkbenchTile,
  findWorkbenchTile,
  focusWorkbenchTile,
  moveWorkbenchTile,
  moveWorkbenchTileBelow,
  moveWorkbenchTileToSplit,
  nudgeWorkbenchTile,
  persistWorkbench,
  replaceWorkbenchTileParams,
  setWorkbenchBelowRatio,
  setWorkbenchExpanded,
  setWorkbenchSplitRatio,
  setWorkbenchWeights,
  useWorkbenchPendingClose,
  type WorkbenchNudge,
} from "./workbench-store.js";
import "./workbench.css";

/**
 * 대화 칸 안의 도구 분할 — 대화 오른쪽 분할 영역(열·칸)과 대화 아래 한 줄에 도구 칸이 선다(시안 v2 규칙 a·e·f·h).
 *
 * 레이어 하나가 작업 영역(왼쪽 사이드바와 오른쪽 사이드바 사이)을 덮고, 칸은 모두 이 레이어 위에 절대 배치된다. 자리를 옮기거나
 * 펼쳐도 칸은 같은 부모·같은 key 에 남으므로 Shell·브라우저·파일 트리가 다시 서지 않는다. 오른쪽 사이드바는 이 레이어 밖이다.
 *
 * 칸 머리 한 문법: [아이콘·제목 또는 탭 줄] · 가운데 이동 손잡이 · ⋮ · 펼치기 · 닫기. 손잡이는 마우스를 올리거나 키보드 초점이
 * 왔을 때만 보인다. ⋮ 의 「위로·아래로·왼쪽 열로·오른쪽 열로」는 끌기의 키보드 대안이고 머리에서 ⌥+화살표로도 된다.
 */

/** 대화의 Session 브라우저(사령관 같은 플러그인 대화) — 호스트 등록 플러그인 id 와 그 대화가 돌려준 세션 scope. */
export interface WorkbenchSessionBrowser {
  readonly pluginId: string;
  readonly scopeId: string;
  readonly subjectKey: string;
  readonly attach: ((files: readonly File[]) => void) | null;
}

/** 칸이 그 대화에서 파생하는 것 — 지금은 브라우저 주인만. 작업 위치(파일 루트·Shell cwd 등)는 2단계에서 여기로 더해진다. */
export type WorkbenchConversation =
  | { readonly kind: "operation"; readonly operation: OperationNode }
  | { readonly kind: "surface"; readonly sessionBrowser: WorkbenchSessionBrowser | null }
  | { readonly kind: "none" };

export interface ConversationWorkbenchProps {
  readonly layerRef: (element: HTMLDivElement | null) => void;
  readonly insets: { readonly left: number; readonly right: number };
  readonly geometry: WorkbenchGeometry;
  readonly layout: WorkbenchLayout;
  readonly focusedTileId: string | null;
  readonly bindings: readonly RailEntryBinding[];
  readonly toolContext: RailToolContext;
  readonly conversation: WorkbenchConversation;
  readonly state: ConsoleState;
  readonly language: "en" | "ko";
  readonly operationKinds: readonly OperationKindDescriptor[];
  /** 대화의 작업 위치를 아직 모른다 — 칸을 세우지 않는다(자리는 비켜 둔 채). 도구가 엉뚱한 자리에서 서지 않게. */
  readonly suspended?: boolean;
}

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;
const DRAG_THRESHOLD = 4;

function rectStyle(rect: Rect): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
}

export function ConversationWorkbench({ layerRef, insets, geometry, layout, focusedTileId, bindings, toolContext, conversation, state, language, operationKinds, suspended = false }: ConversationWorkbenchProps) {
  const t = useT();
  const elementRef = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element;
    layerRef(element);
  }, [layerRef]);
  const [resizing, setResizing] = useState(false);
  const [drag, setDrag] = useState<{ readonly tileId: string; readonly title: string; readonly x: number; readonly y: number; readonly preview: DropPreview | null } | null>(null);
  const [menuTileId, setMenuTileId] = useState<string | null>(null);
  const descriptors = useExpandedSurfaceDescriptors();
  const pendingClose = useWorkbenchPendingClose();

  // 사람이 칸을 닫을 때 물을 말 — 표면이 `confirmClose`로 답한다(Shell: 명령이 돌고 있으면).
  useEffect(() => bindWorkbenchCloseGuard((tile) => {
    if (tile.kind !== "surface") return null;
    const descriptor = descriptors.get(tile.surfaceId);
    const resolve = (message: Parameters<typeof resolveLocalizedText>[0] | null) => (message === null ? null : resolveLocalizedText(message, language));
    try {
      const answer = descriptor?.confirmClose?.({ surfaceId: tile.surfaceId, instanceId: tile.id, params: tile.params }) ?? null;
      return answer instanceof Promise ? answer.then(resolve, () => null) : resolve(answer);
    } catch {
      return null;
    }
  }), [descriptors, language]);

  // 끌기(경계·칸)와 ⋮ 메뉴가 열린 동안 네이티브 브라우저 뷰를 정지 화면 뒤로 물린다 — 뷰는 페이지 위를 덮어 포인터와 메뉴를 가린다.
  const holdViews = resizing || drag !== null || menuTileId !== null || pendingClose !== null;
  useEffect(() => {
    const element = elementRef.current;
    if (!holdViews || element === null) return;
    announceNativeViewResize({ container: element, held: true });
    return () => {
      if (getNativeViewResize()?.container === element) announceNativeViewResize(null);
    };
  }, [holdViews]);

  // 펼친 칸은 Esc 로 접는다 — 입력 중인 자리(입력창·편집기·터미널)의 Esc 는 그 자리의 몫이다.
  const expandedId = geometry.expanded === null ? null : layout.expandedTileId;
  useEffect(() => {
    if (expandedId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const origin = event.target instanceof Element ? event.target : null;
      if (origin?.closest('input, textarea, select, [contenteditable="true"], .xterm, [role="menu"], [role="dialog"], [aria-modal="true"]')) return;
      event.preventDefault();
      setWorkbenchExpanded(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expandedId]);

  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  const beginTileDrag = useCallback((tileId: string, title: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const element = elementRef.current;
    if (element === null) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const { pointerId, clientX: startX, clientY: startY } = event;
    let started = false;
    let preview: DropPreview | null = null;
    try { handle.setPointerCapture(pointerId); } catch { /* 붙들지 못해도 창 전체의 움직임으로 따라간다. */ }
    const local = (clientX: number, clientY: number) => {
      const box = element.getBoundingClientRect();
      return { x: clientX - box.left, y: clientY - box.top };
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (!started && Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD) return;
      started = true;
      const point = local(move.clientX, move.clientY);
      preview = resolveDropPreview(geometryRef.current, tileId, point.x, point.y);
      setDrag({ tileId, title, x: point.x, y: point.y, preview });
    };
    const finish = (end: PointerEvent | null) => {
      if (end !== null && end.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* 이미 풀렸다. */ }
      setDrag(null);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      if (started && preview !== null) moveWorkbenchTile(tileId, preview.target);
      finish(up);
    };
    const onCancel = (cancel: PointerEvent) => finish(cancel);
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopPropagation();
      preview = null;
      finish(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  }, []);

  const bindingOf = useCallback((entryId: string) => bindings.find((binding) => binding.entry.id === entryId) ?? null, [bindings]);
  const surfaceBinding = useCallback((surfaceId: string) => bindings.find((binding) => binding.entry.surfaceId === surfaceId) ?? null, [bindings]);

  const sheet = geometry.mode === "sheet" && geometry.split !== null;
  const tileCount = geometry.tiles.length;
  return (
    <div
      ref={setRef}
      className={`conversation-workbench${resizing ? " is-resizing" : ""}${drag !== null ? " is-dragging" : ""}${expandedId !== null ? " has-expanded" : ""}`}
      data-mode={geometry.mode}
      data-resizing={resizing || drag !== null ? "true" : undefined}
      style={{ left: insets.left, right: insets.right }}
      role={tileCount > 0 ? "region" : undefined}
      aria-label={tileCount > 0 ? t("conversation.workbench.aria") : undefined}
    >
      {sheet ? <div className="conversation-workbench-sheet" style={rectStyle(geometry.split!)} aria-hidden="true" /> : null}
      {expandedId === null ? geometry.gutters.map((gutter) => (
        <WorkbenchGutter key={gutterKey(gutter)} gutter={gutter} geometry={geometry} layout={layout} onResizingChange={setResizing} />
      )) : null}
      {(suspended ? [] : geometry.tiles).map((entry) => {
        const hidden = expandedId !== null && entry.tile.id !== expandedId;
        const rect = expandedId === entry.tile.id && geometry.expanded !== null ? geometry.expanded : entry.rect;
        return (
          <WorkbenchTileView
            key={entry.tile.id}
            entry={entry}
            rect={rect}
            hidden={hidden}
            expanded={expandedId === entry.tile.id}
            focused={focusedTileId === entry.tile.id}
            dragging={drag?.tileId === entry.tile.id}
            menuOpen={menuTileId === entry.tile.id}
            pendingClose={pendingClose?.tileId === entry.tile.id ? pendingClose.message : null}
            onMenuOpenChange={(open) => setMenuTileId(open ? entry.tile.id : null)}
            layout={layout}
            geometry={geometry}
            binding={entry.tile.kind === "entry" ? bindingOf(entry.tile.entryId) : entry.tile.kind === "surface" ? surfaceBinding(entry.tile.surfaceId) : null}
            toolContext={toolContext}
            conversation={conversation}
            state={state}
            language={language}
            operationKinds={operationKinds}
            onBeginDrag={beginTileDrag}
          />
        );
      })}
      {drag?.preview ? <div className="conversation-workbench-drop" style={rectStyle(drag.preview.rect)} aria-hidden="true" /> : null}
      {drag !== null ? (
        <div className="conversation-workbench-ghost" style={{ left: drag.x + 12, top: drag.y + 10 }} aria-hidden="true">{drag.title}</div>
      ) : null}
    </div>
  );
}

function gutterKey(gutter: GutterGeometry): string {
  switch (gutter.kind) {
    case "columns": return `columns:${gutter.index}`;
    case "column": return `column:${gutter.column}:${gutter.index}`;
    case "below-tiles": return `below-tiles:${gutter.index}`;
    default: return gutter.kind;
  }
}

// ── 경계 ──────────────────────────────────────────────────────────────────

/**
 * 비율을 끄는 경계 — 대화와 분할 영역 사이(split), 대화와 아래 줄 사이(below), 열 사이(columns), 한 열의 칸 사이(column),
 * 아래 줄의 칸 사이(below-tiles). 끄는 동안은 저장 없이 따라가고, 놓을 때 한 번 쓴다. 키보드는 화살표(Shift 로 크게)다.
 * 두 번 누르면 분할 영역·아래 줄은 기본 몫으로, 칸 사이는 고르게 돌아간다.
 */
function WorkbenchGutter({ gutter, geometry, layout, onResizingChange }: {
  readonly gutter: GutterGeometry;
  readonly geometry: WorkbenchGeometry;
  readonly layout: WorkbenchLayout;
  readonly onResizingChange: (resizing: boolean) => void;
}) {
  const t = useT();
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const vertical = gutter.kind === "split" || gutter.kind === "columns" || gutter.kind === "below-tiles";

  // 이웃한 두 칸(또는 열)의 지금 폭·높이 — 그 둘 사이에서만 주고받는다.
  const pairSizes = (): { readonly sizes: number[]; readonly index: number } | null => {
    const current = geometryRef.current;
    if (gutter.kind === "columns") {
      const widths: number[] = [];
      for (const entry of current.tiles) if (entry.area === "column" && entry.index === 0) widths[entry.column] = entry.rect.w;
      return { sizes: widths, index: gutter.index };
    }
    if (gutter.kind === "column") {
      const heights = current.tiles.filter((entry) => entry.area === "column" && entry.column === gutter.column).sort((a, b) => a.index - b.index).map((entry) => entry.rect.h);
      return { sizes: heights, index: gutter.index };
    }
    if (gutter.kind === "below-tiles") {
      const widths = current.tiles.filter((entry) => entry.area === "below").sort((a, b) => a.index - b.index).map((entry) => entry.rect.w);
      return { sizes: widths, index: gutter.index };
    }
    return null;
  };

  const apply = (delta: number, base: { readonly sizes: number[]; readonly index: number } | null, startValue: number, persist: boolean) => {
    const current = geometryRef.current;
    if (gutter.kind === "split") {
      const width = Math.max(current.splitMin, Math.min(current.mode === "sheet" ? current.width - 24 : current.splitMax, startValue - delta));
      setWorkbenchSplitRatio(current.width > 0 ? width / current.width : null, { persist });
      return;
    }
    if (gutter.kind === "below") {
      const height = Math.max(120, Math.min(current.height - 200, startValue - delta));
      setWorkbenchBelowRatio(current.height > 0 ? height / current.height : null, { persist });
      return;
    }
    if (base === null) return;
    const { sizes, index } = base;
    const left = sizes[index] ?? 0;
    const right = sizes[index + 1] ?? 0;
    const pair = left + right;
    const floor = Math.min(pair / 2, gutter.kind === "column" ? 96 : 160);
    const nextLeft = Math.max(floor, Math.min(pair - floor, left + delta));
    const next = [...sizes];
    next[index] = nextLeft;
    next[index + 1] = pair - nextLeft;
    if (gutter.kind === "columns") setWorkbenchWeights({ area: "columns" }, next, { persist });
    else if (gutter.kind === "column") setWorkbenchWeights({ area: "column", column: gutter.column }, next, { persist });
    else setWorkbenchWeights({ area: "below" }, next, { persist });
  };

  const startValueOf = () => {
    const current = geometryRef.current;
    if (gutter.kind === "split") return current.splitWidth;
    if (gutter.kind === "below") return current.conversationBottom;
    return 0;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const { pointerId } = event;
    const start = vertical ? event.clientX : event.clientY;
    const base = pairSizes();
    const startValue = startValueOf();
    let moved = false;
    try { handle.setPointerCapture(pointerId); } catch { /* 창 전체의 움직임으로 따라간다. */ }
    onResizingChange(true);
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if ((move.buttons & 1) === 0) { finish(move); return; }
      moved = true;
      apply((vertical ? move.clientX : move.clientY) - start, base, startValue, false);
    };
    const finish = (end: PointerEvent) => {
      if (end.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* 이미 풀렸다. */ }
      if (moved) persistWorkbench();
      onResizingChange(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const back = vertical ? "ArrowLeft" : "ArrowUp";
    const forward = vertical ? "ArrowRight" : "ArrowDown";
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    apply(event.key === back ? -step : step, pairSizes(), startValueOf(), true);
  };

  const onDoubleClick = () => {
    if (gutter.kind === "split") setWorkbenchSplitRatio(null);
    else if (gutter.kind === "below") setWorkbenchBelowRatio(null);
    else if (gutter.kind === "columns") setWorkbenchWeights({ area: "columns" }, layout.columns.map(() => 1));
    else if (gutter.kind === "column") setWorkbenchWeights({ area: "column", column: gutter.column }, (layout.columns[gutter.column]?.tiles ?? []).map(() => 1));
    else setWorkbenchWeights({ area: "below" }, layout.below.tiles.map(() => 1));
  };

  const label = gutter.kind === "split" ? t("conversation.workbench.resizeSplit") : gutter.kind === "below" ? t("conversation.workbench.resizeBelow") : t("conversation.workbench.resizeTiles");
  return (
    <div
      className={`conversation-workbench-gutter is-${gutter.kind}${vertical ? " is-vertical" : " is-horizontal"}`}
      style={rectStyle(gutter.rect)}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      title={t("conversation.workbench.resetHint")}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    />
  );
}

// ── 칸 ────────────────────────────────────────────────────────────────────

interface WorkbenchTileViewProps {
  readonly entry: TileGeometry;
  readonly rect: Rect;
  readonly hidden: boolean;
  readonly expanded: boolean;
  readonly focused: boolean;
  readonly dragging: boolean;
  readonly menuOpen: boolean;
  /** 이 칸을 닫기 전에 묻는 말 — 사람이 닫기를 눌렀고 표면이 물어야 한다고 답했을 때만. */
  readonly pendingClose: string | null;
  readonly onMenuOpenChange: (open: boolean) => void;
  readonly layout: WorkbenchLayout;
  readonly geometry: WorkbenchGeometry;
  readonly binding: RailEntryBinding | null;
  readonly toolContext: RailToolContext;
  readonly conversation: WorkbenchConversation;
  readonly state: ConsoleState;
  readonly language: "en" | "ko";
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly onBeginDrag: (tileId: string, title: string, event: ReactPointerEvent<HTMLElement>) => void;
}

/** 칸 하나 — 출처별 본문을 고르고, 머리·자리는 공통 틀(TileFrame)이 진다. */
function WorkbenchTileView(props: WorkbenchTileViewProps) {
  const { entry } = props;
  const tile = entry.tile;
  if (tile.kind === "entry") return <EntryTile {...props} tile={tile} />;
  if (tile.kind === "surface") return <SurfaceTile {...props} tile={tile} />;
  return <BrowserTile {...props} />;
}

interface FrameParts {
  readonly title: string;
  readonly titleNode?: ReactNode;
  readonly icon?: ReactNode;
  readonly tools?: ReactNode;
  readonly body: ReactNode;
  readonly bodyRef?: (element: HTMLDivElement | null) => void;
}

function TileFrame({ entry, rect, hidden, expanded, focused, dragging, menuOpen, pendingClose, onMenuOpenChange, layout, geometry, onBeginDrag, parts }: WorkbenchTileViewProps & { readonly parts: FrameParts }) {
  const t = useT();
  const tile = entry.tile;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const setMenuOpen = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    onMenuOpenChange(typeof next === "function" ? next(menuOpen) : next);
  }, [menuOpen, onMenuOpenChange]);
  useMenuButtonKeyboard(rootRef, menuButtonRef, menuRef, menuOpen, setMenuOpen);

  const place = findWorkbenchTile(layout, tile.id)?.place ?? null;
  const inBelow = place?.area === "below";
  const columns = layout.columns.length;
  const column = place?.area === "column" ? layout.columns[place.column] : undefined;
  const can = {
    up: place?.area === "column" ? place.index > 0 : inBelow,
    down: place?.area === "column" && column !== undefined ? place.index < column.tiles.length - 1 : false,
    left: place?.area === "column"
      ? (place.column > 0 ? (layout.columns[place.column - 1]?.tiles.length ?? 3) < 3 : (column?.tiles.length ?? 0) > 1 && columns < 3)
      : place?.area === "below" ? place.index > 0 : false,
    right: place?.area === "column"
      ? (place.column < columns - 1 ? (layout.columns[place.column + 1]?.tiles.length ?? 3) < 3 : (column?.tiles.length ?? 0) > 1 && columns < 3)
      : place?.area === "below" ? place.index < layout.below.tiles.length - 1 : false,
    below: !inBelow && layout.below.tiles.length < 2,
  };
  const nudge = (direction: WorkbenchNudge) => { nudgeWorkbenchTile(tile.id, direction); };
  const onHeadKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!event.altKey || event.metaKey || event.ctrlKey) return;
    const direction = ({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as const)[event.key as "ArrowUp"];
    if (direction === undefined) return;
    event.preventDefault();
    nudge(direction);
  };
  const onGripKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const direction = ({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as const)[event.key as "ArrowUp"];
    if (direction === undefined) return;
    event.preventDefault();
    nudge(direction);
    // 옮긴 뒤에도 손잡이에 초점을 둔다 — 같은 칸이 새 자리에서 다시 그려진다.
    queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>(".workbench-tile-grip")?.focus());
  };

  const menuItems: { readonly key: string; readonly label: string; readonly hint?: string; readonly enabled: boolean; readonly run: () => void }[] = inBelow
    ? [
      { key: "left", label: t("conversation.workbench.moveLeftBelow"), hint: "⌥←", enabled: can.left, run: () => nudge("left") },
      { key: "right", label: t("conversation.workbench.moveRightBelow"), hint: "⌥→", enabled: can.right, run: () => nudge("right") },
      { key: "split", label: t("conversation.workbench.toSplit"), hint: "⌥↑", enabled: true, run: () => { moveWorkbenchTileToSplit(tile.id); } },
    ]
    : [
      { key: "up", label: t("conversation.workbench.moveUp"), hint: "⌥↑", enabled: can.up, run: () => nudge("up") },
      { key: "down", label: t("conversation.workbench.moveDown"), hint: "⌥↓", enabled: can.down, run: () => nudge("down") },
      { key: "left", label: t("conversation.workbench.moveLeft"), hint: "⌥←", enabled: can.left && !geometry.collapsedColumns, run: () => nudge("left") },
      { key: "right", label: t("conversation.workbench.moveRight"), hint: "⌥→", enabled: can.right && !geometry.collapsedColumns, run: () => nudge("right") },
      { key: "below", label: t("conversation.workbench.toBelow"), enabled: can.below, run: () => { moveWorkbenchTileBelow(tile.id); } },
    ];

  // 창 오른쪽 위 모서리에 닿은 칸 — Windows 캡션 단추 띠가 그 머리 위에 앉는다(workbench.css).
  const touchesTop = rect.y <= 16 && rect.x + rect.w >= geometry.width - 16;
  return (
    <section
      ref={rootRef}
      className={`workbench-tile${focused ? " is-focused" : ""}${expanded ? " is-expanded" : ""}${dragging ? " is-dragging" : ""}${hidden ? " is-hidden" : ""}`}
      style={rectStyle(rect)}
      data-tile-kind={tile.kind}
      data-tile-area={entry.area}
      data-touch-top={touchesTop ? "true" : undefined}
      data-keep-operation-active
      aria-label={parts.title}
      aria-hidden={hidden ? true : undefined}
      inert={hidden || undefined}
      // 본문을 만질 때만 이 칸이 포커스를 얻는다 — 머리(손잡이·⋮·펼치기)의 초점이 본문을 깨우면 터미널 같은 본문이 초점을 가져가
      // 손잡이의 화살표·⋮ 메뉴가 본문으로 새어 든다.
      onPointerDownCapture={(event) => { if (!isInHead(event.target)) focusWorkbenchTile(tile.id); }}
      onFocusCapture={(event) => { if (!isInHead(event.target)) focusWorkbenchTile(tile.id); }}
    >
      <header className="workbench-tile-head" onKeyDown={onHeadKeyDown}>
        <span className="workbench-tile-title">
          {parts.titleNode ?? (
            <>
              {parts.icon ? <span className="workbench-tile-icon" aria-hidden="true">{parts.icon}</span> : null}
              <span className="workbench-tile-name">{parts.title}</span>
            </>
          )}
        </span>
        {parts.tools ? <span className="workbench-tile-tools">{parts.tools}</span> : null}
        <button
          type="button"
          className="workbench-tile-grip"
          aria-label={t("conversation.workbench.move", { title: parts.title })}
          title={t("conversation.workbench.moveHint")}
          onPointerDown={(event) => onBeginDrag(tile.id, parts.title, event)}
          onKeyDown={onGripKeyDown}
        >
          <svg viewBox="0 0 18 10" aria-hidden="true"><circle cx="5" cy="3" r="1.1" fill="currentColor" /><circle cx="9" cy="3" r="1.1" fill="currentColor" /><circle cx="13" cy="3" r="1.1" fill="currentColor" /><circle cx="5" cy="7" r="1.1" fill="currentColor" /><circle cx="9" cy="7" r="1.1" fill="currentColor" /><circle cx="13" cy="7" r="1.1" fill="currentColor" /></svg>
        </button>
        <span className="workbench-tile-actions">
          <span className="workbench-tile-menu-wrap">
            <button
              type="button"
              ref={menuButtonRef}
              className="workbench-tile-button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t("conversation.workbench.menu", { title: parts.title })}
              title={t("conversation.workbench.menu", { title: parts.title })}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3.5" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="12.5" r="1.2" fill="currentColor" /></svg>
            </button>
            {menuOpen ? (
              <div ref={menuRef} className="workbench-tile-menu" role="menu" aria-label={t("conversation.workbench.menu", { title: parts.title })}>
                {menuItems.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    className="workbench-tile-menu-item"
                    disabled={!item.enabled}
                    onClick={() => { onMenuOpenChange(false); item.run(); menuButtonRef.current?.focus(); }}
                  >
                    <span>{item.label}</span>
                    {item.hint ? <kbd>{item.hint}</kbd> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </span>
          <button
            type="button"
            className="workbench-tile-button"
            aria-pressed={expanded}
            aria-label={expanded ? t("conversation.workbench.collapse") : t("conversation.workbench.expand")}
            title={expanded ? t("conversation.workbench.collapse") : t("conversation.workbench.expand")}
            onClick={() => setWorkbenchExpanded(expanded ? null : tile.id)}
          >
            {expanded
              ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M6.5 6.5 2.5 2.5M9.5 9.5l4 4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>
              : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6.5v-4h4M13.5 9.5v4h-4M2.5 2.5l4 4M13.5 13.5l-4-4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </button>
          <button
            type="button"
            className="workbench-tile-button"
            aria-label={t("conversation.workbench.close", { title: parts.title })}
            title={t("conversation.workbench.close", { title: parts.title })}
            onClick={() => closeWorkbenchTile(tile.id)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </span>
      </header>
      {pendingClose !== null ? (
        <div className="workbench-tile-confirm" role="alertdialog" aria-label={pendingClose}>
          <span>{pendingClose}</span>
          <button type="button" className="is-danger" autoFocus onClick={() => closeWorkbenchTile(tile.id, { confirmed: true })}>{t("conversation.workbench.closeConfirm")}</button>
          <button type="button" onClick={cancelWorkbenchClose}>{t("conversation.workbench.closeCancel")}</button>
        </div>
      ) : null}
      <div className="workbench-tile-body" ref={parts.bodyRef}>
        {parts.body}
      </div>
    </section>
  );
}

function isInHead(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".workbench-tile-head") !== null;
}

function entryIcon(binding: RailEntryBinding | null): ReactNode {
  const icon = binding?.entry.icon;
  return typeof icon === "function" ? icon() : icon ?? null;
}

/** 레일 엔트리의 페인 묶음(파일·Codex·스킬 등) — 오른쪽 사이드바가 쓰던 같은 표면 렌더러를 칸 안에 세운다. */
function EntryTile(props: WorkbenchTileViewProps & { readonly tile: Extract<WorkbenchTile, { kind: "entry" }> }) {
  const t = useT();
  const { binding, toolContext, language } = props;
  const title = binding ? resolveLocalizedText(binding.entry.title, language) : props.tile.entryId;
  const needsTheater = binding !== null && binding.entry.scope !== "fleet" && toolContext.theaterId === null;
  const body = binding === null || binding.panes.length === 0
    ? <div className="workbench-tile-notice">{t("conversation.workbench.missingTool")}</div>
    : needsTheater
      ? <div className="workbench-tile-notice">{t("conversation.workbench.needsTheater")}</div>
      : (
        <div className="workbench-tile-rail">
          <RailSurface
            binding={binding}
            theaterId={toolContext.theaterId}
            api={toolContext.api}
            language={language}
            {...(toolContext.theme === undefined ? {} : { theme: toolContext.theme })}
            {...(toolContext.surfaces === undefined ? {} : { surfaces: toolContext.surfaces })}
            {...(toolContext.launchOperation === undefined ? {} : { onLaunchOperation: toolContext.launchOperation })}
            {...(toolContext.openLink === undefined ? {} : { openLink: toolContext.openLink })}
            {...(toolContext.conversation === undefined ? {} : { conversation: toolContext.conversation })}
          />
        </div>
      );
  return <TileFrame {...props} parts={{ title, icon: entryIcon(binding), body }} />;
}

const NO_MINIMUM = () => undefined;

/** 확대 표면 서술자 하나(저장소·Shell·Codex 정독 등) — 옛 가운데 덮개가 쓰던 같은 서술자를 칸 안에 그린다. */
function SurfaceTile(props: WorkbenchTileViewProps & { readonly tile: Extract<WorkbenchTile, { kind: "surface" }> }) {
  const { tile, entry, focused, toolContext, state, language, binding } = props;
  const descriptors = useExpandedSurfaceDescriptors();
  const descriptor = descriptors.get(tile.surfaceId);
  const capabilities = useHostCapabilities();
  const instance = useMemo(() => ({ instanceId: tile.id, surfaceId: tile.surfaceId, params: tile.params, weight: 1 }), [tile.id, tile.params, tile.surfaceId]);
  const context = useExpandedSurfaceContext({
    instance,
    index: entry.index,
    paneCount: 1,
    paneWidth: Math.round(entry.rect.w),
    focused,
    theaterId: toolContext.theaterId,
    theme: state.activeTheme,
    language,
    capabilities,
    onReportMinimum: NO_MINIMUM,
    // 표면이 스스로 닫는 길(셸 종료 등)은 묻지 않는다.
    close: () => closeWorkbenchTile(tile.id, { confirmed: true }),
    focus: () => focusWorkbenchTile(tile.id),
    replaceParams: (next) => replaceWorkbenchTileParams(tile.id, next),
    conversation: toolContext.conversation,
  });
  const title = safeExpandedSurfaceTitle(descriptor, context, language, binding ? resolveLocalizedText(binding.entry.title, language) : tile.surfaceId);
  const body = (
    <div className="workbench-tile-surface">
      {descriptor?.aside ? (
        <aside className="expanded-surface-pane-aside">
          <PluginErrorBoundary><SurfacePanePart render={descriptor.aside} context={context} /></PluginErrorBoundary>
        </aside>
      ) : null}
      <div className="expanded-surface-pane-main">
        <PluginErrorBoundary>
          {descriptor ? <SurfacePanePart render={descriptor.render} context={context} /> : <MissingSurface surfaceId={tile.surfaceId} />}
        </PluginErrorBoundary>
      </div>
    </div>
  );
  const tools = descriptor?.tools ? <PluginErrorBoundary fallback={null}><SurfacePanePart render={descriptor.tools} context={context} /></PluginErrorBoundary> : null;
  return <TileFrame {...props} parts={{ title, icon: entryIcon(binding), tools, body }} />;
}

/** 칸 안의 Session 브라우저가 쓰는 호스트 손잡이 — Operation companion 과 같은 값이다. */
const SESSION_BROWSER_SERVICES = { isDesktopShell, themePolarity, subscribeConsoleChannel } as const;
const NO_HIDDEN_COMPANIONS: readonly string[] = [];
const BROWSER_COMPANION_PANEL_IDS: readonly string[] = [BROWSER_COMPANION_ID];
function noop(): void {}

/**
 * 그 대화의 Session 브라우저 칸. 웹 브라우저 Console 에는 뷰를 그릴 셸이 없다 — Desktop 에서 열어 둔 칸에는 안내 한 줄만 남는다.
 */
function BrowserTile(props: WorkbenchTileViewProps) {
  const t = useT();
  const browserT = getBrowserT(props.language);
  const title = t("conversation.workbench.browser");
  if (!isDesktopShell()) {
    return <TileFrame {...props} parts={{ title, body: <div className="workbench-tile-notice">{t("conversation.workbench.desktopOnly")}</div> }} />;
  }
  const { conversation } = props;
  if (conversation.kind === "operation") return <OperationBrowserTile {...props} operation={conversation.operation} title={title} />;
  if (conversation.kind === "surface" && conversation.sessionBrowser !== null) return <SessionBrowserTile {...props} session={conversation.sessionBrowser} title={title} />;
  return <TileFrame {...props} parts={{ title, body: <div className="workbench-tile-notice">{browserT("terminal.chooser.noOperation")}</div> }} />;
}

function OperationBrowserTile(props: WorkbenchTileViewProps & { readonly operation: OperationNode; readonly title: string }) {
  const { operation, state, language, operationKinds, hidden, title } = props;
  const capabilities = useHostCapabilities();
  const descriptor = operationKinds.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);
  const companion = descriptor?.companions?.find((panel) => panel.id === BROWSER_COMPANION_ID) ?? null;
  const runtimeState = pluginRuntimeState(state.operationRuntime, state.operationRuntimeHydration, operation.id);
  const [geometry, setGeometry] = useState<OperationGeometry>({ x: 0, y: 0, width: 480, height: 640, zIndex: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);
  const bodyRef = useCallback((element: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (element === null) return;
    const update = () => setGeometry((current) => {
      const width = Math.max(1, element.clientWidth);
      const height = Math.max(1, element.clientHeight);
      return current.width === width && current.height === height ? current : { ...current, width, height };
    });
    update();
    if (typeof ResizeObserver === "undefined") return;
    observerRef.current = new ResizeObserver(update);
    observerRef.current.observe(element);
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  const activate = useCallback(() => setActiveOperation(operation.id), [operation.id]);
  const tileId = props.entry.tile.id;
  const onCompanion = useCallback((companionPanelId: string, visible: boolean) => {
    if (companionPanelId === BROWSER_COMPANION_ID && !visible) closeWorkbenchTile(tileId);
  }, [tileId]);
  if (companion === null) {
    return <TileFrame {...props} parts={{ title, body: <div className="workbench-tile-notice">{getBrowserT(language)("terminal.chooser.noOperation")}</div> }} />;
  }
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
    onClose: () => closeWorkbenchTile(tileId),
    onGeometryChange: setGeometry,
    onRequestCompanions: noop,
    companionsOpen: true,
    hiddenCompanionPanelIds: NO_HIDDEN_COMPANIONS,
    onSetCompanionPanelVisible: onCompanion,
    companionPanelIds: BROWSER_COMPANION_PANEL_IDS,
    // 다른 칸이 펼쳐져 이 칸이 숨은 동안은 네이티브 뷰도 물린다 — 숨은 칸의 뷰가 펼친 칸 위를 덮지 않게.
    bodyLive: !hidden,
  } as const;
  const titleNode = companion.caption === undefined ? <span className="workbench-tile-name">{resolveLocalizedText(companion.title, language)}</span> : (
    <PluginErrorBoundary fallback={<></>}>
      <PluginOperationRenderer {...shared} render={companion.caption} />
    </PluginErrorBoundary>
  );
  const body = (
    <PluginErrorBoundary fallback={null}>
      <PluginOperationRenderer {...shared} render={companion.render} />
    </PluginErrorBoundary>
  );
  return <TileFrame {...props} parts={{ title, titleNode, body, bodyRef }} />;
}

function SessionBrowserTile(props: WorkbenchTileViewProps & { readonly session: WorkbenchSessionBrowser; readonly title: string }) {
  const { session, language, state, hidden, title } = props;
  const browserT = getBrowserT(language);
  const [owner, setOwner] = useState<{ readonly key: string; readonly ownerId: string | null; readonly failed: boolean } | null>(null);
  useLayoutEffect(() => {
    let live = true;
    const key = session.subjectKey;
    void resolveSessionBrowserTarget({ pluginId: session.pluginId, scopeId: session.scopeId })
      .then((ownerId) => ({ ownerId, failed: false }), () => ({ ownerId: null, failed: true }))
      .then((result) => { if (live) setOwner({ key, ...result }); });
    return () => { live = false; };
  }, [session.pluginId, session.scopeId, session.subjectKey]);
  const resolved = owner?.key === session.subjectKey ? owner : null;
  if (resolved === null || resolved.ownerId === null) {
    const notice = resolved === null ? "" : browserT(resolved.failed ? "terminal.chooser.noOperation" : "terminal.chooser.sessionNotStarted");
    return <TileFrame {...props} parts={{ title, body: <div className="workbench-tile-notice">{notice}</div> }} />;
  }
  const ownerId = resolved.ownerId;
  return (
    <TileFrame
      {...props}
      parts={{
        title,
        titleNode: <SessionBrowserCaption ownerId={ownerId} language={language} />,
        body: <SessionBrowserPanel key={ownerId} ownerId={ownerId} language={language} theme={state.activeTheme} bodyLive={!hidden} services={SESSION_BROWSER_SERVICES} {...(session.attach ? { onAttach: session.attach } : {})} />,
      }}
    />
  );
}
