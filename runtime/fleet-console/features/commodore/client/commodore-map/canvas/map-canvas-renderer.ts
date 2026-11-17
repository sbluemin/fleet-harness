import type { GlanceKit } from "@fleet-console/ui/glance-kit";

import type { MapBranchKey, MapNode } from "../map-graph.js";
import type { MapPalette } from "../map-palette.js";
import type { MapRenderer, PositionedMapModel } from "../map-renderers.js";
import {
  DEFAULT_MAP_INSETS,
  MAP_LABEL_PRIORITY,
  attachMapCanvas,
  clampMapInsets,
  drawMapLabels,
  mapEdgeAlpha,
  mapEdgeRgb,
  mapEdgeRole,
  mapGlanceKit,
  mapNodeDegree,
  mapNodeRadiusPx,
  mapNodeRgb,
  mapRgbPalette,
  readMapBackdrop,
  readMapFont,
  rgbCss,
  type MapCanvasSurface,
  type MapFitInsets,
  type MapLabelCandidate,
  type MapRgb,
  type MapRgbPalette,
} from "../fallback/map-fallback-common.js";

/**
 * 안 B — Canvas 2D 발광 지도. WebGL2가 없거나 동작 줄이기를 켠 환경의 대체 렌더러다.
 *
 * 동작 줄이기 경로이므로 **정지 그림**이다. 펄스·흔들림·상시 rAF 루프를 두지 않고,
 * 선택·호버·필터·크기 변경처럼 상태가 바뀔 때만 다시 그린다. 발광은 foundation으로
 * 승격한 glance 키트(`makeGlanceKit`)로 긋는다. WebGL 컨텍스트는 만들지 않는다.
 *
 * 크기·선·라벨은 시안 그대로다(m9-mockup-gap G3·G4·G8): 핵 22·허브/설명 10·주제 4.5·
 * 목표 5+deg·정보 4.5·기억 3.6+deg, 선 trunk .55/branch .4/twig .26/intel .26/link .6/목표 .11,
 * 라벨은 pill 없이 바탕색 글자 그림자 + 점 오른쪽. +N·출처 라벨은 늘 보인다.
 */

const LABEL_MAX = 180;
/** 초점 집합이 이보다 크면 라벨을 달지 않는다(시안 placeLabels). */
const LABEL_FOCUS_LIMIT = 60;

interface CanvasView {
  /** 화면 px / 배치 단위. */
  scale: number;
  /** 배치 원점의 화면 px. */
  ox: number;
  oy: number;
}

interface CanvasState {
  surface: MapCanvasSurface | null;
  model: PositionedMapModel | null;
  rgb: MapRgbPalette | null;
  backdrop: MapRgb;
  kit: GlanceKit | null;
  font: string;
  selection: string | null;
  hover: string | null;
  filter: ReadonlySet<string> | null;
  view: CanvasView;
  insets: MapFitInsets;
  /** 보기 변화 구독 — 그리기는 상태 변화 때만 돈다. */
  viewListeners: Set<() => void>;
}

export function createMapRenderer(): MapRenderer {
  const state: CanvasState = {
    surface: null,
    model: null,
    rgb: null,
    backdrop: readMapBackdrop(),
    kit: null,
    font: readMapFont(),
    selection: null,
    hover: null,
    filter: null,
    view: { scale: 1, ox: 0, oy: 0 },
    insets: DEFAULT_MAP_INSETS,
    viewListeners: new Set(),
  };

  const isVisible = (id: string): boolean => state.filter === null || state.filter.has(id);

  /** 시안 radius() 그대로 — 호버·선택은 ×1.4(그리기·고르기 같은 보이는 크기). */
  const baseRadius = (node: MapNode): number => {
    const model = state.model;
    const degree = model ? mapNodeDegree(model.graph, node.id) : 0;
    return Math.max(0.01, mapNodeRadiusPx(node, degree));
  };
  const nodeRadius = (node: MapNode): number => {
    const enlarged = node.id === state.hover || node.id === state.selection ? 1.4 : 1;
    return baseRadius(node) * enlarged;
  };

  const screenOf = (node: MapNode): { x: number; y: number } | null => {
    const point = state.model?.layout.positions.get(node.id);
    if (!point) return null;
    return { x: state.view.ox + point.x * state.view.scale, y: state.view.oy + point.y * state.view.scale };
  };

  const shownNodes = (): MapNode[] => {
    const model = state.model;
    if (!model) return [];
    return model.graph.nodes.filter((node) => isVisible(node.id) && model.layout.positions.has(node.id));
  };

  /**
   * 검색 중인가 — 칩 필터는 갈래를 통째로 가리지만, 검색은 한 갈래의 일부만 남긴다.
   * 계약에 검색 집합이 없어 이 차이로 알아본다(선 ×2에만 쓴다).
   */
  const searchActive = (): boolean => {
    const model = state.model;
    if (!model || state.filter === null) return false;
    const branches = new Map<MapBranchKey, { seen: boolean; hidden: boolean }>();
    for (const node of model.graph.nodes) {
      if (node.branch === null) continue;
      const entry = branches.get(node.branch) ?? { seen: false, hidden: false };
      if (isVisible(node.id)) entry.seen = true;
      else entry.hidden = true;
      branches.set(node.branch, entry);
    }
    for (const entry of branches.values()) if (entry.seen && entry.hidden) return true;
    return false;
  };

  /** 맞춤 보기 — 시안 `extent()*1.04`처럼 보이는 점 반경 최대의 1.04배를 여백으로 쓴다. */
  const fit = (): void => {
    const surface = state.surface;
    const model = state.model;
    if (!surface || !model || surface.width <= 0 || surface.height <= 0) return;
    const { width: w, height: h } = surface;
    const nodes = shownNodes();
    const insets = clampMapInsets(state.insets, w, h);
    const maxRadius = nodes.reduce((max, node) => Math.max(max, baseRadius(node)), 1);
    const margin = maxRadius * 1.04;
    const left = insets.left + margin;
    const right = w - insets.right - margin;
    const top = insets.top + margin;
    const bottom = h - insets.bottom - margin;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      const point = model.layout.positions.get(node.id)!;
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
    if (!Number.isFinite(minX)) {
      state.view = { scale: 1, ox: w / 2, oy: h / 2 };
      return;
    }

    const worldW = Math.max(1e-3, maxX - minX);
    const worldH = Math.max(1e-3, maxY - minY);
    const availW = Math.max(1, right - left);
    const availH = Math.max(1, bottom - top);
    const scale = Math.min(400, Math.max(8, Math.min(availW / worldW, availH / worldH)));
    state.view = {
      scale,
      ox: left + (availW - worldW * scale) / 2 - minX * scale,
      oy: top + (availH - worldH * scale) / 2 - minY * scale,
    };
  };

  const focusSet = (): ReadonlySet<string> | null => {
    const focus = state.hover ?? state.selection;
    const model = state.model;
    if (!focus || !model || !model.graph.byId.has(focus)) return null;
    return new Set([focus, ...(model.graph.adjacent.get(focus) ?? [])]);
  };

  const draw = (): void => {
    const surface = state.surface;
    const model = state.model;
    const rgb = state.rgb;
    const kit = state.kit;
    if (!surface || !model || !rgb || !kit) return;
    const { ctx, width: w, height: h } = surface;
    const { graph } = model;

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";

    const points = new Map<string, { x: number; y: number }>();
    for (const node of graph.nodes) {
      const screen = screenOf(node);
      if (screen) points.set(node.id, screen);
    }
    const core = points.get("core");
    const focus = focusSet();
    const search = searchActive();

    // 연결선 — 시안 알파. 초점과 이어진 선은 a×2.6+0.25, 나머지는 ×0.12. 검색 중엔 남은 선 ×2.
    for (const edge of graph.edges) {
      if (!isVisible(edge.from) || !isVisible(edge.to)) continue;
      const a = points.get(edge.from);
      const b = points.get(edge.to);
      if (!a || !b) continue;
      const role = mapEdgeRole(graph, edge);
      const base = mapEdgeAlpha(role);
      const touches = focus !== null && (focus.has(edge.from) || focus.has(edge.to));
      const alpha = search
        ? Math.min(1, base * 2)
        : focus !== null
          ? touches ? Math.min(1, base * 2.6 + 0.25) : base * 0.12
          : base;
      const color = mapEdgeRgb(rgb, graph, edge);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const cx = core ? mx + (core.x - mx) * 0.16 : mx;
      const cy = core ? my + (core.y - my) * 0.16 : my;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = rgbCss(color);
      ctx.lineWidth = touches ? 1.6 : role === "trunk" ? 1.2 : 1;
      if (edge.kind === "link" || edge.kind === "objective" || edge.kind === "source") ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }

    // 노드 — 시안 알파(0.9 · 초점 밖 0.13 · stale ×0.5 · 주제 ×0.6), 발광 → 점 → 고리.
    for (const node of graph.nodes) {
      if (!isVisible(node.id)) continue;
      const point = points.get(node.id);
      if (!point) continue;
      const r = nodeRadius(node);
      const dim = focus !== null && !focus.has(node.id);
      const color = mapNodeRgb(rgb, node);
      const alpha = 0.9 * (dim ? 0.13 : 1) * (node.stale ? 0.5 : 1) * (node.kind === "topic" ? 0.6 : 1);
      const glowColor = node.fresh && !dim ? rgb.fresh : color;
      kit.glow(point.x, point.y, Math.max(0.01, r * 3), rgbCss(glowColor), dim ? 0.08 : node.kind === "core" ? 0.9 : node.fresh ? 0.7 : 0.35);

      if (node.kind === "intel") {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = rgbCss(color);
        ctx.fillRect(point.x - r, point.y - r, r * 2, r * 2);
        ctx.restore();
      } else {
        kit.dot(point.x, point.y, Math.max(0.01, node.kind === "objective" ? r * 0.55 : r), rgbCss(color), alpha);
      }
      if (node.kind === "objective") {
        kit.ring(point.x, point.y, r, r, rgbCss(color, 0.8), dim ? 0.13 : 0.8, 1.2);
      }
      if (node.kind === "intel-overflow") {
        // 정보 점과 구별되는 큰 점 + 고리 — 묶음으로 읽히게(수정 8-1).
        kit.ring(point.x, point.y, r + 3, r + 3, rgbCss(color, 0.9), dim ? 0.13 : 0.85, 1.8);
      }
      if (node.stale && !dim) {
        kit.ring(point.x, point.y, r + 3.5, r + 3.5, rgbCss(rgb.stale, 0.85), 0.5, 1.2, [2.5, 2]);
      }
      if (node.id === state.selection || node.id === state.hover) {
        kit.ring(point.x, point.y, r + 5, r + 5, rgbCss(node.id === state.selection ? rgb.ink : rgb.inkDim), 1, node.id === state.selection ? 2 : 1.2);
      }
    }

    // 라벨 — 기본은 핵·설명·허브·+N·출처. 초점(≤60)은 그 점들, 주제는 확대가 없어 달지 않는다.
    const shown = shownNodes();
    const focusLabels = focus !== null && focus.size <= LABEL_FOCUS_LIMIT
      ? focus
      : search && shown.length <= LABEL_FOCUS_LIMIT
        ? new Set(shown.map((node) => node.id))
        : null;
    const candidates: MapLabelCandidate[] = [];
    for (const node of graph.nodes) {
      if (!isVisible(node.id) || !node.label) continue;
      const point = points.get(node.id);
      if (!point) continue;
      const priority = labelPriority(node, focusLabels);
      if (priority === null) continue;
      const strong = node.kind === "core" || node.kind === "description" || node.kind === "branch" || node.kind === "intel-hub";
      const outside = focus !== null && !focus.has(node.id);
      candidates.push({
        text: node.label,
        x: point.x,
        y: point.y,
        radius: nodeRadius(node),
        priority,
        color: rgbCss(outside ? rgb.inkDim : strong ? rgb.ink : rgb.inkDim),
        alpha: outside ? 0.35 : 1,
        strong,
      });
    }
    drawMapLabels(ctx, state.font, state.backdrop, candidates, w, h, Math.min(LABEL_MAX, Math.max(60, w * 0.5)));

    for (const listener of state.viewListeners) {
      try { listener(); } catch { /* DOM 동기 실패는 다음 그림으로 미룬다 */ }
    }
  };

  /** 시안 라벨 집합 — 기본(핵·설명·허브·+N·출처), 초점 집합(주제 제외), 선택은 언제나. */
  const labelPriority = (node: MapNode, focusLabels: ReadonlySet<string> | null): number | null => {
    switch (node.kind) {
      case "core":
        return MAP_LABEL_PRIORITY.core;
      case "description":
      case "intel-hub":
      case "branch":
        return MAP_LABEL_PRIORITY.hub;
      case "intel-overflow":
        return MAP_LABEL_PRIORITY.hub;
      case "source":
        return MAP_LABEL_PRIORITY.secondary;
      case "objective":
      case "memory":
      case "intel":
      case "topic":
        if (node.id === state.selection || node.id === state.hover) return MAP_LABEL_PRIORITY.forced;
        // 시안 placeLabels는 초점에서도 주제 라벨을 달지 않는다 — 궤도의 확대에서만.
        if (node.kind === "topic") return null;
        return focusLabels?.has(node.id) ? MAP_LABEL_PRIORITY.focus : null;
    }
  };

  const readPalette = (palette: MapPalette): void => {
    state.rgb = mapRgbPalette(palette);
    state.font = readMapFont();
    state.backdrop = readMapBackdrop();
    state.kit = state.surface ? mapGlanceKit(state.surface.ctx, palette, state.font) : null;
  };

  return {
    mount(container, model, palette) {
      dispose();
      const surface = attachMapCanvas(container, () => {
        fit();
        draw();
      });
      if (!surface) return;
      state.surface = surface;
      state.model = model;
      readPalette(palette);
      fit();
      draw();
    },
    update(model, palette) {
      state.model = model;
      readPalette(palette);
      fit();
      draw();
    },
    setSelection(id) {
      if (state.selection === id) return;
      state.selection = id;
      draw();
    },
    setHover(id) {
      if (state.hover === id) return;
      state.hover = id;
      draw();
    },
    setFilter(visible) {
      state.filter = visible;
      draw();
    },
    setFitInsets(insets) {
      const next = { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left };
      const current = state.insets;
      if (next.top === current.top && next.right === current.right && next.bottom === current.bottom && next.left === current.left) return;
      state.insets = next;
      fit();
      draw();
    },
    pick(x, y) {
      const model = state.model;
      if (!model) return null;
      let best: string | null = null;
      let bestDistance = Infinity;
      for (const node of model.graph.nodes) {
        if (!isVisible(node.id)) continue;
        const point = screenOf(node);
        if (!point) continue;
        const r = nodeRadius(node);
        const distance = Math.hypot(point.x - x, point.y - y);
        if (distance <= r && distance < bestDistance) {
          best = node.id;
          bestDistance = distance;
        }
      }
      return best;
    },
    project(id) {
      const surface = state.surface;
      const node = state.model?.graph.byId.get(id);
      if (!surface || !node) return null;
      const point = screenOf(node);
      if (!point) return null;
      const visible = point.x >= 0 && point.x <= surface.width && point.y >= 0 && point.y <= surface.height;
      return { x: point.x, y: point.y, visible };
    },
    fit,
    onViewChange(listener) {
      state.viewListeners.add(listener);
      return () => { state.viewListeners.delete(listener); };
    },
    dispose,
  };

  function dispose(): void {
    state.surface?.dispose();
    state.surface = null;
    state.model = null;
    state.rgb = null;
    state.kit = null;
    state.filter = null;
    state.viewListeners.clear();
  }
}
