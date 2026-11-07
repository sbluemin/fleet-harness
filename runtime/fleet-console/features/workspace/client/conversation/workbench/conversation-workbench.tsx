import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { FeatureErrorBoundary } from "@fleet-console/ui/react";
import { resolveLocalizedText } from "@fleet-console/i18n/translate";
import type { ObjectiveKindDescriptor } from "../../../../execution/shared/client-contract.js";
import { findAgentObjectiveKind } from "../../../../execution/shared/objective-kind.js";

import type { WorkbenchLayout, WorkbenchTile } from "../../../shared/conversation-workbench.js";
import { useT } from "../../../../../core/client/src/i18n/index.js";
import type { ConsoleState, ObjectiveGeometry, ObjectiveRecord } from "../../../../../core/client/src/integration/types.js";
import { setActiveObjective, themePolarity } from "../../../../../core/client/src/integration/store.js";
import { useHostCapabilities } from "../../../../../core/client/src/integration/use-host-capabilities.js";
import { useExpandedSurfaceDescriptors } from "../../../../../core/client/src/integration/feature-registry.js";
import { isDesktopShell } from "../../../../../core/client/src/integration/desktop-shell.js";
import { subscribeConsoleChannel } from "../../../../../core/client/src/integration/objective-records-sse.js";
import { MissingSurface, SurfacePanePart, safeExpandedSurfaceTitle, useExpandedSurfaceContext } from "../../../../../core/client/src/chrome/expanded-surface/layer.js";
import { RailSurface } from "../../../../../core/client/src/chrome/pane/rail-surface.js";
import type { RailEntryBinding } from "../../../../../core/client/src/chrome/pane/pane-registry.js";
import type { RailToolContext } from "../../../../../core/client/src/chrome/rail/right-rail.js";
import { pluginRuntimeState } from "../../../../execution/client/objective-activity.js";
import { BROWSER_COMPANION_ID } from "../../../../execution/client/agent/browser-companion.js";
import { BrowserNavTailContext } from "../../../../browser/client/browser-panel-store.js";
import { resolveSessionBrowserTarget, SessionBrowserPanel } from "../../../../browser/client/browser-panel.js";
import { announceNativeViewResize, getNativeViewResize } from "../../../../browser/client/browser-panel-store.js";
import { getT as getBrowserT } from "../../../../browser/client/i18n.js";
import { PluginObjectiveRenderer } from "../../objective-renderer.js";
import { type GutterGeometry, type Rect, type TileGeometry, type WorkbenchGeometry } from "./workbench-geometry.js";
import { useBrowserBandGlobe, useBrowserBandSlot } from "./browser-band-slot.js";
import {
  bindWorkbenchCloseGuard,
  cancelWorkbenchClose,
  closeWorkbenchTile,
  focusWorkbenchTile,
  getWorkbenchKey,
  persistWorkbench,
  replaceWorkbenchTileParams,
  setWorkbenchBelowRatio,
  setWorkbenchExpanded,
  setWorkbenchSplitRatio,
  setWorkbenchWeights,
  useWorkbenchPendingClose,
} from "./workbench-store.js";
import "./workbench.css";

/**
 * 대화 칸 안의 도구 분할 — 대화 오른쪽 한 열에 도구 칸이 연 순서대로 쌓인다. 칸을 옮기는 길은 없다(폭 경계와 펼치기만 있다).
 *
 * 레이어 하나가 작업 영역(왼쪽 사이드바와 오른쪽 사이드바 사이)을 덮고, 칸은 모두 이 레이어 위에 절대 배치된다. 펼쳐도 칸은 같은
 * 부모·같은 key 에 남으므로 Shell·브라우저·파일 트리가 다시 서지 않는다. 오른쪽 사이드바는 이 레이어 밖이다.
 *
 * 칸 머리 한 문법: [아이콘·제목] · 펼치기 · 닫기. 브라우저는 예외다 — 열의 맨 위에서 머리 없이 대화와 같은 면으로 서고, 탭 줄과
 * 펼치기는 맨 위 줄의 지구본 바로 앞으로 올라간다. 지구본을 누르면 그 자리에서 번져 열리고, 닫으면 그 자리로 접혀 들어간다.
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
  | { readonly kind: "objectiveRecord"; readonly objectiveRecord: ObjectiveRecord }
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
  readonly objectiveRecordKinds: readonly ObjectiveKindDescriptor[];
}

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/** 브라우저가 지구본에서 번져 열리고 접혀 닫히는 시간과 곡선 — 대화 칸이 비키는 스프링(--ease-spring)과 같은 곡선이다. */
const BROWSER_OPEN_MS = 340;
const BROWSER_CLOSE_MS = 240;
const BROWSER_OPEN_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const BROWSER_CLOSE_EASE = "cubic-bezier(0.3, 0, 0.15, 1)";
/** 닫을 때 네이티브 뷰 대신 깔 정지 화면을 기다리는 한도 — 패널의 캡처 예산(800ms)을 조금 넘긴다. */
const BROWSER_FRAME_WAIT_MS = 900;
/** 정지 화면이 깔린 뒤 셸이 뷰를 실제로 물리기까지 두는 여유. */
const BROWSER_PARK_SETTLE_MS = 60;
type TileMotion = "enter" | "leave";

interface BrowserSettled {
  readonly key: string;
  readonly id: string | null;
  readonly entry: TileGeometry | null;
  readonly rect: Rect | null;
  readonly expanded: boolean;
}

interface BrowserLeaving {
  readonly key: string;
  readonly entry: TileGeometry;
  readonly rect: Rect;
  readonly expanded: boolean;
}

function motionAllowed(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches !== true;
}

/** 지구본 가운데를 중심으로 칸을 덮는 원 — 열 때는 지구본 크기에서 칸 전체로, 닫을 때는 그 반대로. */
function glyphClip(element: HTMLElement, direction: "open" | "close"): Keyframe[] {
  const box = element.getBoundingClientRect();
  const glyph = document.querySelector<HTMLElement>('.conversation-pill-tools [data-caption-action="browser"]')?.getBoundingClientRect() ?? null;
  const cx = glyph === null ? box.width - 24 : glyph.left + glyph.width / 2 - box.left;
  const cy = glyph === null ? -24 : glyph.top + glyph.height / 2 - box.top;
  const start = glyph === null ? 12 : glyph.width / 2;
  const far = Math.ceil(Math.max(...[[0, 0], [box.width, 0], [0, box.height], [box.width, box.height]].map(([x, y]) => Math.hypot(x! - cx, y! - cy)))) + 2;
  const small = { clipPath: `circle(${start}px at ${cx}px ${cy}px)` };
  const large = { clipPath: `circle(${far}px at ${cx}px ${cy}px)` };
  return direction === "open" ? [small, large] : [large, small];
}

function rectStyle(rect: Rect): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
}

export function ConversationWorkbench({ layerRef, insets, geometry, layout, focusedTileId, bindings, toolContext, conversation, state, language, objectiveRecordKinds }: ConversationWorkbenchProps) {
  const t = useT();
  const elementRef = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element;
    layerRef(element);
  }, [layerRef]);
  const [resizing, setResizing] = useState(false);
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

  // ── 브라우저가 지구본에서 열리고 닫힌다 ──
  // 같은 대화에서 브라우저 칸이 새로 서면 번져 열리고, 사라지면 그 칸을 잠시 붙들어 접혀 닫히게 한다. 대화를 바꾸거나 처음 그릴 때,
  // 동작 줄이기 설정에서는 바로 바뀐다. 움직이는 동안은 네이티브 뷰를 정지 화면 뒤로 물린다 — 뷰는 잘라 그릴 수 없다.
  // 새로 섰는지·사라졌는지는 그리는 동안 판정한다. 그래야 첫 그림부터 뷰가 물러나 있고, 떠나는 칸이 같은 key 로 남아 다시 서지 않는다.
  const workbenchKey = getWorkbenchKey();
  const browserEntry = geometry.tiles.find((entry) => entry.tile.kind === "browser") ?? null;
  const settledRef = useRef<BrowserSettled | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<BrowserLeaving | null>(null);
  const settled = settledRef.current;
  const sameConversation = settled !== null && settled.key === workbenchKey;
  const revealId = browserEntry === null ? null
    : entering === browserEntry.tile.id || (sameConversation && settled.id !== browserEntry.tile.id && motionAllowed()) ? browserEntry.tile.id : null;
  const ghost: BrowserLeaving | null = browserEntry !== null ? null
    : leaving !== null && leaving.key === workbenchKey ? leaving
      : sameConversation && settled.entry !== null && settled.rect !== null && motionAllowed()
        ? { key: workbenchKey, entry: settled.entry, rect: settled.rect, expanded: settled.expanded } : null;

  // 끌기(경계)와 닫기 확인, 브라우저가 열리고 닫히는 동안 네이티브 브라우저 뷰를 정지 화면 뒤로 물린다 — 뷰는 페이지 위를 덮어 포인터를 가린다.
  const holdViews = resizing || pendingClose !== null || revealId !== null || ghost !== null;
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

  const browserRect = browserEntry === null ? null : expandedId === browserEntry.tile.id && geometry.expanded !== null ? geometry.expanded : browserEntry.rect;
  useLayoutEffect(() => {
    settledRef.current = { key: workbenchKey, id: browserEntry?.tile.id ?? null, entry: browserEntry, rect: browserRect, expanded: browserEntry !== null && expandedId === browserEntry.tile.id };
  });
  // 그린 판정을 상태로 붙든다 — 다음 그림부터는 settledRef 가 지금 칸을 가리킨다.
  useLayoutEffect(() => {
    if (ghost !== null && ghost !== leaving) setLeaving(ghost);
    else if (ghost === null && leaving !== null) setLeaving(null);
  }, [ghost, leaving]);

  useLayoutEffect(() => {
    if (revealId === null) return;
    setEntering(revealId);
    const element = elementRef.current?.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(revealId)}"]`) ?? null;
    if (element === null) { setEntering(null); return; }
    let live = true;
    const animation = element.animate(glyphClip(element, "open"), { duration: BROWSER_OPEN_MS, easing: BROWSER_OPEN_EASE });
    void animation.finished.then(() => { if (live) setEntering(null); }, () => undefined);
    return () => { live = false; animation.cancel(); };
  }, [revealId]);

  // 닫힘 — 네이티브 뷰가 정지 화면으로 물러난 뒤(또는 띄운 뷰가 없으면 곧바로) 지구본으로 접는다.
  const leavingId = leaving?.entry.tile.id ?? null;
  useEffect(() => {
    if (leavingId === null) return;
    const element = elementRef.current?.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(leavingId)}"]`) ?? null;
    if (element === null) { setLeaving(null); return; }
    let live = true;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let animation: Animation | null = null;
    const began = performance.now();
    const collapse = () => {
      if (!live) return;
      animation = element.animate(glyphClip(element, "close"), { duration: BROWSER_CLOSE_MS, easing: BROWSER_CLOSE_EASE, fill: "forwards" });
      void animation.finished.then(() => { if (live) setLeaving(null); }, () => undefined);
    };
    const wait = () => {
      if (!live) return;
      const native = element.querySelector(".op-browser__native");
      if (native === null) { collapse(); return; }
      if (native.querySelector(".op-browser__backdrop") !== null) { timer = setTimeout(collapse, BROWSER_PARK_SETTLE_MS); return; }
      if (performance.now() - began > BROWSER_FRAME_WAIT_MS) { collapse(); return; }
      frame = requestAnimationFrame(wait);
    };
    frame = requestAnimationFrame(wait);
    return () => { live = false; cancelAnimationFrame(frame); if (timer !== null) clearTimeout(timer); animation?.cancel(); };
  }, [leavingId]);

  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  const bindingOf = useCallback((entryId: string) => bindings.find((binding) => binding.entry.id === entryId) ?? null, [bindings]);
  const surfaceBinding = useCallback((surfaceId: string) => bindings.find((binding) => binding.entry.surfaceId === surfaceId) ?? null, [bindings]);

  const sheet = geometry.mode === "sheet" && geometry.split !== null;
  const tileCount = geometry.tiles.length;
  return (
    <div
      ref={setRef}
      className={`conversation-workbench${resizing ? " is-resizing" : ""}${expandedId !== null ? " has-expanded" : ""}`}
      data-mode={geometry.mode}
      data-resizing={holdViews && pendingClose === null ? "true" : undefined}
      style={{ left: insets.left, right: insets.right }}
      role={tileCount > 0 ? "region" : undefined}
      aria-label={tileCount > 0 ? t("conversation.workbench.aria") : undefined}
    >
      {sheet ? <div className="conversation-workbench-sheet" style={rectStyle(geometry.split!)} aria-hidden="true" /> : null}
      {expandedId === null ? geometry.gutters.map((gutter) => (
        <WorkbenchGutter key={gutterKey(gutter)} gutter={gutter} geometry={geometry} layout={layout} onResizingChange={setResizing} />
      )) : null}
      {[
        ...geometry.tiles.map((entry) => ({
          entry,
          rect: expandedId === entry.tile.id && geometry.expanded !== null ? geometry.expanded : entry.rect,
          hidden: expandedId !== null && entry.tile.id !== expandedId,
          expanded: expandedId === entry.tile.id,
          motion: entry.tile.id === revealId ? "enter" as const : null,
        })),
        // 떠나는 브라우저 칸 — 같은 key 로 남아 패널이 다시 서지 않고, 접히는 동안만 그려진다.
        ...(ghost === null ? [] : [{ entry: ghost.entry, rect: ghost.rect, hidden: false, expanded: ghost.expanded, motion: "leave" as const }]),
      ].map(({ entry, rect, hidden, expanded, motion }) => {
        return (
          <WorkbenchTileView
            key={entry.tile.id}
            entry={entry}
            rect={rect}
            hidden={hidden}
            expanded={expanded}
            focused={focusedTileId === entry.tile.id}
            motion={motion}
            pendingClose={pendingClose?.tileId === entry.tile.id ? pendingClose.message : null}
            geometry={geometry}
            binding={entry.tile.kind === "entry" ? bindingOf(entry.tile.entryId) : entry.tile.kind === "surface" ? surfaceBinding(entry.tile.surfaceId) : null}
            toolContext={toolContext}
            conversation={conversation}
            state={state}
            language={language}
            objectiveRecordKinds={objectiveRecordKinds}
          />
        );
      })}
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
  /** 브라우저 칸이 지구본에서 번져 열리는 중(enter)이거나 접혀 닫히는 중(leave). */
  readonly motion: TileMotion | null;
  /** 이 칸을 닫기 전에 묻는 말 — 사람이 닫기를 눌렀고 표면이 물어야 한다고 답했을 때만. */
  readonly pendingClose: string | null;
  readonly geometry: WorkbenchGeometry;
  readonly binding: RailEntryBinding | null;
  readonly toolContext: RailToolContext;
  readonly conversation: WorkbenchConversation;
  readonly state: ConsoleState;
  readonly language: "en" | "ko";
  readonly objectiveRecordKinds: readonly ObjectiveKindDescriptor[];
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
  readonly icon?: ReactNode;
  readonly tools?: ReactNode;
  readonly body: ReactNode;
  readonly bodyRef?: (element: HTMLDivElement | null) => void;
}

function TileFrame({ entry, rect, hidden, expanded, focused, motion, pendingClose, geometry, parts }: WorkbenchTileViewProps & { readonly parts: FrameParts }) {
  const t = useT();
  const tile = entry.tile;
  // 브라우저는 따로 떠 있는 패널이 아니라 대화와 같은 면이다 — 머리 없이 맨 위 줄 밑에서 작업 영역 끝까지 채운다. 맨 위 줄은 탭 영역이
  // 아니며, 펼치기는 주소줄 끝(BrowserNavTailContext)에 선다. 대화 위에 뜨는 시트(좁은 창)와, 지구본이 서지 않는 브라우저 탭·모바일 화면(저장된 배치로
  // 브라우저 칸이 남아 있을 때)에서는 다른 칸과 같은 틀이다 — 닫기 단추가 그 칸을 닫는 길이다.
  const seamless = tile.kind === "browser" && geometry.mode !== "sheet" && isDesktopShell();
  const frameRect = seamless ? seamlessRect(entry, rect, geometry, expanded) : rect;
  const expandLabel = expanded ? t("conversation.workbench.collapse") : t("conversation.workbench.expand");
  const expandButton = (
    <button
      type="button"
      className="workbench-tile-button"
      aria-pressed={expanded}
      aria-label={expandLabel}
      title={expandLabel}
      onClick={() => setWorkbenchExpanded(expanded ? null : tile.id)}
    >
      {expanded
        ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M6.5 6.5 2.5 2.5M9.5 9.5l4 4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>
        : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6.5v-4h4M13.5 9.5v4h-4M2.5 2.5l4 4M13.5 13.5l-4-4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </button>
  );

  return (
    <section
      className={`workbench-tile${focused ? " is-focused" : ""}${expanded ? " is-expanded" : ""}${hidden ? " is-hidden" : ""}`}
      style={rectStyle(frameRect)}
      data-tile-id={tile.id}
      data-tile-kind={tile.kind}
      data-tile-area={entry.area}
      data-seamless={seamless ? "true" : undefined}
      data-motion={motion ?? undefined}
      data-keep-objective-active
      aria-label={parts.title}
      aria-hidden={hidden ? true : undefined}
      inert={hidden || motion === "leave" || undefined}
      // 본문을 만질 때만 이 칸이 포커스를 얻는다 — 머리(펼치기·닫기)의 초점이 본문을 깨우면 터미널 같은 본문이 초점을 가져간다.
      onPointerDownCapture={(event) => { if (!isInHead(event.target)) focusWorkbenchTile(tile.id); }}
      onFocusCapture={(event) => { if (!isInHead(event.target)) focusWorkbenchTile(tile.id); }}
    >
      {seamless ? (
        <BrowserBandChrome motion={motion} hidden={hidden}>
          <BrowserBandClose tileId={tile.id} title={parts.title} />
        </BrowserBandChrome>
      ) : (
        <header className="workbench-tile-head">
          <span className="workbench-tile-title">
            {parts.icon ? <span className="workbench-tile-icon" aria-hidden="true">{parts.icon}</span> : null}
            <span className="workbench-tile-name">{parts.title}</span>
          </span>
          {parts.tools ? <span className="workbench-tile-tools">{parts.tools}</span> : null}
          <span className="workbench-tile-actions">
            {expandButton}
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
      )}
      {pendingClose !== null ? (
        <div className="workbench-tile-confirm" role="alertdialog" aria-label={pendingClose}>
          <span>{pendingClose}</span>
          <button type="button" className="is-danger" autoFocus onClick={() => closeWorkbenchTile(tile.id, { confirmed: true })}>{t("conversation.workbench.closeConfirm")}</button>
          <button type="button" onClick={cancelWorkbenchClose}>{t("conversation.workbench.closeCancel")}</button>
        </div>
      ) : null}
      <div className="workbench-tile-body" ref={parts.bodyRef}>
        {/* 머리 없는 브라우저 칸의 펼치기는 머리가 없으므로 주소줄 끝(도구모음 옆)에 선다 — 본문이 그 자리를 그린다. */}
        {seamless ? <BrowserNavTailContext.Provider value={expandButton}>{parts.body}</BrowserNavTailContext.Provider> : parts.body}
      </div>
    </section>
  );
}

/**
 * 지구본이 닫는 길이 아닐 때만 서는 닫기 — 이 대화가 지구본을 세우지 않거나(작업대는 사령관 단위로 공유되므로 다른 대화에서 연 칸이
 * 남는다), 다른 화면이 붙어 브라우저가 멈춰 지구본이 꺼지면, 열려 있던 칸을 닫을 다른 길이 없다.
 */
function BrowserBandClose({ tileId, title }: { readonly tileId: string; readonly title: string }) {
  const t = useT();
  const globe = useBrowserBandGlobe();
  if (globe) return null;
  const label = t("conversation.workbench.close", { title });
  return (
    <button type="button" className="workbench-tile-button" aria-label={label} title={label} onClick={() => closeWorkbenchTile(tileId)}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
    </button>
  );
}

/** 머리 없는 브라우저 칸의 자리 — 맨 위 줄 밑에서 시작해 작업 영역 오른쪽 끝까지, 아래에 다른 칸이 없으면 바닥까지 채운다. */
function seamlessRect(entry: TileGeometry, rect: Rect, geometry: WorkbenchGeometry, expanded: boolean): Rect {
  if (expanded) return { x: 0, y: 0, w: geometry.width, h: geometry.height };
  const below = geometry.tiles.some((other) => other.area === entry.area && other.column === entry.column && other.index > entry.index);
  return { x: rect.x, y: 0, w: Math.max(0, geometry.width - rect.x), h: below ? rect.y + rect.h : geometry.height };
}

/**
 * 맨 위 줄의 브라우저 칸 자리 — 지구본 바로 앞 자리(browser-band-slot)로 portal 된다. 탭은 이 줄에 서지 않는다(탭은 브라우저 본문 왼쪽의
 * 세로 레일이 가진다). 여기 서는 것은 지구본이 닫는 길이 아닐 때의 닫기뿐이다. 펼친 동안에도 분할 영역 위에 남아 대화 pill 을 덮지 않는다.
 */
function BrowserBandChrome({ motion, hidden, children }: {
  readonly motion: TileMotion | null;
  readonly hidden: boolean;
  readonly children: ReactNode;
}) {
  const slot = useBrowserBandSlot();
  if (slot === null || hidden) return null;
  return createPortal(
    <span className={`workbench-band-chrome${motion === null ? "" : ` is-${motion}`}`} data-keep-objective-active>
      {children}
    </span>,
    slot,
  );
}

function isInHead(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".workbench-tile-head") !== null;
}

function entryIcon(binding: RailEntryBinding | null): ReactNode {
  const icon = binding?.entry.icon;
  return typeof icon === "function" ? icon() : icon ?? null;
}

/** 레일 엔트리의 페인 묶음 — 오른쪽 사이드바가 쓰던 같은 표면 렌더러를 칸 안에 세운다. */
function EntryTile(props: WorkbenchTileViewProps & { readonly tile: Extract<WorkbenchTile, { kind: "entry" }> }) {
  const t = useT();
  const { binding, toolContext, language } = props;
  const title = binding ? resolveLocalizedText(binding.entry.title, language) : props.tile.entryId;
  const effectiveTheaterId = toolContext.theaterId;
  const needsTheater = binding !== null && binding.entry.scope !== "fleet" && binding.entry.opensWithoutTheater !== true && effectiveTheaterId === null;
  const body = binding === null || binding.panes.length === 0
    ? <div className="workbench-tile-notice">{t("conversation.workbench.missingTool")}</div>
    : (needsTheater
      ? <div className="workbench-tile-notice">{t("conversation.workbench.needsTheater")}</div>
      : (
        <div className="workbench-tile-rail">
          <RailSurface
            binding={binding}
            theaterId={effectiveTheaterId}
            commodoreId={toolContext.commodoreId}
            api={toolContext.api}
            language={language}
            {...(toolContext.theme === undefined ? {} : { theme: toolContext.theme })}
            {...(toolContext.surfaces === undefined ? {} : { surfaces: toolContext.surfaces })}
            {...(toolContext.launchObjective === undefined ? {} : { onLaunchObjective: toolContext.launchObjective })}
            {...(toolContext.openLink === undefined ? {} : { openLink: toolContext.openLink })}
            {...(toolContext.conversation === undefined ? {} : { conversation: toolContext.conversation })}
          />
        </div>
      ));
  return <TileFrame {...props} parts={{ title, icon: entryIcon(binding), body }} />;
}

const NO_MINIMUM = () => undefined;

/** 확대 표면 서술자 하나 — 옛 가운데 덮개가 쓰던 같은 서술자를 칸 안에 그린다. */
function SurfaceTile(props: WorkbenchTileViewProps & { readonly tile: Extract<WorkbenchTile, { kind: "surface" }> }) {
  const { tile, entry, focused, toolContext, state, language, binding } = props;
  const descriptors = useExpandedSurfaceDescriptors();
  const descriptor = descriptors.get(tile.surfaceId);
  const capabilities = useHostCapabilities();
  const instance = useMemo(() => ({ instanceId: tile.id, surfaceId: tile.surfaceId, params: tile.params, weight: 1 }), [tile.id, tile.params, tile.surfaceId]);
  const effectiveTheaterId = toolContext.theaterId;
  const context = useExpandedSurfaceContext({
    instance,
    index: entry.index,
    paneCount: 1,
    paneWidth: Math.round(entry.rect.w),
    focused,
    theaterId: effectiveTheaterId,
    commodoreId: toolContext.commodoreId,
    theme: state.activeTheme,
    language,
    capabilities,
    onReportMinimum: NO_MINIMUM,
    // 표면이 스스로 닫는 길은 묻지 않는다.
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
          <FeatureErrorBoundary><SurfacePanePart render={descriptor.aside} context={context} /></FeatureErrorBoundary>
        </aside>
      ) : null}
      <div className="expanded-surface-pane-main">
        <FeatureErrorBoundary>
          {descriptor ? <SurfacePanePart render={descriptor.render} context={context} /> : <MissingSurface surfaceId={tile.surfaceId} />}
        </FeatureErrorBoundary>
      </div>
    </div>
  );
  const tools = descriptor?.tools ? <FeatureErrorBoundary fallback={null}><SurfacePanePart render={descriptor.tools} context={context} /></FeatureErrorBoundary> : null;
  return <TileFrame {...props} parts={{ title, icon: entryIcon(binding), tools, body }} />;
}

/** 칸 안의 Session 브라우저가 쓰는 호스트 손잡이 — Objective companion 과 같은 값이다. */
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
  if (conversation.kind === "objectiveRecord") return <ObjectiveBrowserTile {...props} objectiveRecord={conversation.objectiveRecord} title={title} />;
  if (conversation.kind === "surface" && conversation.sessionBrowser !== null) return <SessionBrowserTile {...props} session={conversation.sessionBrowser} title={title} />;
  return <TileFrame {...props} parts={{ title, body: <div className="workbench-tile-notice">{browserT("terminal.chooser.noObjective")}</div> }} />;
}

function ObjectiveBrowserTile(props: WorkbenchTileViewProps & { readonly objectiveRecord: ObjectiveRecord; readonly title: string }) {
  const { objectiveRecord, state, language, objectiveRecordKinds, hidden, title } = props;
  const capabilities = useHostCapabilities();
  const descriptor = findAgentObjectiveKind(objectiveRecordKinds);
  const companion = descriptor?.companions?.find((panel) => panel.id === BROWSER_COMPANION_ID) ?? null;
  const runtimeState = pluginRuntimeState(state.objectiveRecordRuntime, state.objectiveRecordRuntimeHydration, objectiveRecord.id);
  const [geometry, setGeometry] = useState<ObjectiveGeometry>({ x: 0, y: 0, width: 480, height: 640, zIndex: 0 });
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
  const activate = useCallback(() => setActiveObjective(objectiveRecord.id), [objectiveRecord.id]);
  const tileId = props.entry.tile.id;
  const onCompanion = useCallback((companionPanelId: string, visible: boolean) => {
    if (companionPanelId === BROWSER_COMPANION_ID && !visible) closeWorkbenchTile(tileId);
  }, [tileId]);
  if (companion === null) {
    return <TileFrame {...props} parts={{ title, body: <div className="workbench-tile-notice">{getBrowserT(language)("terminal.chooser.noObjective")}</div> }} />;
  }
  const shared = {
    active: state.activeObjectiveId === objectiveRecord.id,
    capabilities,
    geometry,
    objectiveRecord,
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
  const body = (
    <FeatureErrorBoundary fallback={null}>
      <PluginObjectiveRenderer {...shared} render={companion.render} />
    </FeatureErrorBoundary>
  );
  return <TileFrame {...props} parts={{ title, body, bodyRef }} />;
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
    const notice = resolved === null ? "" : browserT(resolved.failed ? "terminal.chooser.noObjective" : "terminal.chooser.sessionNotStarted");
    return <TileFrame {...props} parts={{ title, body: <div className="workbench-tile-notice">{notice}</div> }} />;
  }
  const ownerId = resolved.ownerId;
  return (
    <TileFrame
      {...props}
      parts={{
        title,
        body: <SessionBrowserPanel key={ownerId} ownerId={ownerId} language={language} theme={state.activeTheme} bodyLive={!hidden} services={SESSION_BROWSER_SERVICES} {...(session.attach ? { onAttach: session.attach } : {})} />,
      }}
    />
  );
}
