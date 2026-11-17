import type { GlanceKit } from "@fleet-console/ui/glance-kit";

import type { MapNode } from "../map-graph.js";
import { mapNodeSize } from "../map-layout.js";
import type { MapPalette } from "../map-palette.js";
import type { MapRenderer, PositionedMapModel } from "../map-renderers.js";
import {
  DEFAULT_MAP_INSETS,
  MAP_LABEL_GAP,
  MAP_LABEL_PRIORITY,
  MAP_LABEL_SIZE,
  attachMapCanvas,
  clampMapInsets,
  drawMapLabels,
  mapGlanceKit,
  mapLabelReserve,
  mapNodeRgb,
  mapRgbPalette,
  readMapFont,
  rgbCss,
  type MapCanvasSurface,
  type MapFitInsets,
  type MapLabelCandidate,
  type MapRgbPalette,
} from "../fallback/map-fallback-common.js";

/**
 * 안 B — Canvas 2D 발광 지도. WebGL2가 없거나 동작 줄이기를 켠 환경의 대체 렌더러다.
 *
 * 동작 줄이기 경로이므로 **정지 그림**이다. 펄스·흔들림·상시 rAF 루프를 두지 않고,
 * 선택·호버·필터·크기 변경처럼 상태가 바뀔 때만 다시 그린다. 발광은 foundation으로
 * 승격한 glance 키트(`makeGlanceKit`)로 긋는다. WebGL 컨텍스트는 만들지 않는다.
 *
 * 라벨 규칙(D11): 핵·갈래 허브는 항상, 주제는 자리가 있을 때만(충돌 회피), 목표·기억·정보는
 * 호버·선택할 때만 그린다. 캔버스에는 확대가 없으므로 그 둘은 상태 라벨로만 선다.
 */

/** 노드 size 1(핵)이 17 CSS px — 고르기 반경도 이 보이는 크기를 그대로 쓴다. */
const NODE_PX = 17;
const LABEL_MAX = 180;

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

  /** `+N` 묶음은 정보 점보다 크게 그린다 — 갈래 안의 묶음으로 읽히게(수정 8-1). */
  const nodeRadius = (node: MapNode): number =>
    Math.max(0.01, mapNodeSize(node.kind) * NODE_PX * (node.kind === "intel-overflow" ? 1.55 : 1));

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

  /** 라벨을 달 후보인가 — 목표·기억·정보는 호버·선택일 때만 강제로 단다. */
  const labelPriority = (node: MapNode): number | null => {
    switch (node.kind) {
      case "core":
        return MAP_LABEL_PRIORITY.core;
      case "description":
      case "intel-hub":
      case "branch":
        return MAP_LABEL_PRIORITY.hub;
      case "topic":
        return MAP_LABEL_PRIORITY.topic;
      case "source":
        return MAP_LABEL_PRIORITY.secondary;
      case "intel-overflow":
        // `+N`은 늘 보이는 라벨 — 허브와 같은 급으로 놓는다(수정 8-1).
        return MAP_LABEL_PRIORITY.hub;
      case "objective":
      case "memory":
      case "intel":
        return node.id === state.hover || node.id === state.selection ? MAP_LABEL_PRIORITY.forced : null;
    }
  };

  /** 맞춤 보기 — 여백(setFitInsets)·아래 라벨 예약을 포함한 bounds가 용기 안에 들어오게 맞춘다. */
  const fit = (): void => {
    const surface = state.surface;
    const model = state.model;
    if (!surface || !model || surface.width <= 0 || surface.height <= 0) return;
    const { width: w, height: h } = surface;
    const nodes = shownNodes();
    const insets = clampMapInsets(state.insets, w, h);

    const pad = 6;
    const left = insets.left + pad;
    const right = w - insets.right - pad;
    const top = insets.top + pad;
    // 아래는 라벨 높이 + 가장 낮은 라벨 노드의 반지름만 예약한다(무대를 넉넉히 채우게, 수정 8-4).
    const bottom = h - insets.bottom - pad - mapLabelReserve() - 10;

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

    // 연결선 — 보이는 두 점 사이만 긋고, 호버·선택의 이웃은 밝힌다.
    for (const edge of graph.edges) {
      if (!isVisible(edge.from) || !isVisible(edge.to)) continue;
      const a = points.get(edge.from);
      const b = points.get(edge.to);
      if (!a || !b) continue;
      const highlighted = focus !== null && (focus.has(edge.from) || focus.has(edge.to));
      const dim = focus !== null && !highlighted;
      const to = graph.byId.get(edge.to);
      const color = to ? mapNodeRgb(rgb, to) : rgb.inkDim;
      const alpha = dim ? 0.05 : highlighted ? 0.85 : edge.kind === "tree" ? 0.38 : edge.kind === "link" ? 0.4 : edge.kind === "objective" ? 0.17 : 0.18;
      // 같은 목표 연결은 구조선보다 확실히 약하게 — 점선이라 더 눈에 띄던 것을 낮춘다(수정 8-8).
      const width = highlighted ? 1.9 : edge.kind === "tree" ? 1.6 : edge.kind === "objective" ? 0.8 : 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const cx = core ? mx + (core.x - mx) * 0.16 : mx;
      const cy = core ? my + (core.y - my) * 0.16 : my;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = rgbCss(color);
      ctx.lineWidth = width;
      if (edge.kind === "link" || edge.kind === "objective" || edge.kind === "source") ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }

    // 노드 — 발광(glow) → 점(dot) → 상태 링(stale) → 선택 링.
    for (const node of graph.nodes) {
      if (!isVisible(node.id)) continue;
      const point = points.get(node.id);
      if (!point) continue;
      const r = nodeRadius(node);
      const dim = focus !== null && !focus.has(node.id);
      const color = mapNodeRgb(rgb, node);
      const alpha = dim ? 0.18 : node.stale ? 0.55 : 1;
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
        kit.ring(point.x, point.y, r, r, rgbCss(color, 0.8), dim ? 0.15 : 0.8, 1.2);
      }
      if (node.kind === "intel-overflow") {
        // 정보 점과 구별되는 큰 점 + 고리 — 묶음으로 읽히게(수정 8-1).
        kit.ring(point.x, point.y, r + 3, r + 3, rgbCss(color, 0.9), dim ? 0.15 : 0.85, 1.8);
      }
      if (node.stale && !dim) {
        kit.ring(point.x, point.y, r + 3.5, r + 3.5, rgbCss(rgb.stale, 0.85), 1, 1.2, [2.5, 2]);
      }
      if (node.id === state.selection || node.id === state.hover) {
        kit.ring(point.x, point.y, r + 5, r + 5, rgbCss(node.id === state.selection ? rgb.ink : rgb.inkDim), 1, node.id === state.selection ? 2 : 1.2);
      }
    }

    // 라벨 — 우선순위대로 자리를 잡고 겹치면 낮은 쪽을 버린다(D11). 아래 예약은 fit이 잡았다.
    const candidates: MapLabelCandidate[] = [];
    for (const node of graph.nodes) {
      if (!isVisible(node.id)) continue;
      const priority = labelPriority(node);
      if (priority === null || !node.label) continue;
      const point = points.get(node.id);
      if (!point) continue;
      const dim = focus !== null && !focus.has(node.id);
      candidates.push({
        text: node.label,
        x: point.x,
        y: point.y + nodeRadius(node) + MAP_LABEL_GAP + MAP_LABEL_SIZE * 0.6,
        priority,
        color: rgbCss(dim ? rgb.inkDim : rgb.ink),
        alpha: dim ? 0.35 : 0.92,
      });
    }
    drawMapLabels(ctx, kit, state.font, candidates, w, h, Math.min(LABEL_MAX, Math.max(60, w * 0.5)));
    for (const listener of state.viewListeners) {
      try { listener(); } catch { /* DOM 동기 실패는 다음 그림으로 미룬다 */ }
    }
  };

  const readPalette = (palette: MapPalette): void => {
    state.rgb = mapRgbPalette(palette);
    state.font = readMapFont();
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
