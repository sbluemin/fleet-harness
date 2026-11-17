import type { GlanceKit } from "@fleet-console/ui/glance-kit";

import type { MapNode } from "../map-graph.js";
import { mapNodeSize } from "../map-layout.js";
import type { MapPalette } from "../map-palette.js";
import type { MapRenderer, PositionedMapModel } from "../map-renderers.js";
import {
  MAP_LABEL_GAP,
  MAP_LABEL_SIZE,
  attachMapCanvas,
  mapGlanceKit,
  mapLabelReserve,
  mapNodeRgb,
  mapRgbPalette,
  readMapFont,
  rgbCss,
  setMapLabelFont,
  truncateLabel,
  type MapCanvasSurface,
  type MapRgbPalette,
} from "../fallback/map-fallback-common.js";

/**
 * 안 B — Canvas 2D 발광 지도. WebGL2가 없거나 동작 줄이기를 켠 환경의 대체 렌더러다.
 *
 * 동작 줄이기 경로이므로 **정지 그림**이다. 펄스·흔들림·상시 rAF 루프를 두지 않고,
 * 선택·호버·필터·크기 변경처럼 상태가 바뀔 때만 다시 그린다. 발광은 foundation으로
 * 승격한 glance 키트(`makeGlanceKit`)로 긋는다. WebGL 컨텍스트는 만들지 않는다.
 */

/** 노드 size 1(핵)이 17 CSS px — 고르기 반경도 이 보이는 크기를 그대로 쓴다. */
const NODE_PX = 17;
/** 이보다 적은 잎 노드만 보이면 라벨을 모두 단다(21개 기준). 200개에서는 겹침을 피한다. */
const LEAF_LABEL_LIMIT = 24;
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
  leafLabels: boolean;
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
    leafLabels: false,
  };

  const isVisible = (id: string): boolean => state.filter === null || state.filter.has(id);

  const nodeRadius = (node: MapNode): number => Math.max(0.01, mapNodeSize(node.kind) * NODE_PX);

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

  const labelsLeaves = (nodes: readonly MapNode[]): boolean => {
    let leaves = 0;
    for (const node of nodes) {
      if (node.kind === "intel" || node.kind === "memory") leaves += 1;
      if (leaves > LEAF_LABEL_LIMIT) return false;
    }
    return true;
  };

  const hasLabel = (node: MapNode): boolean => {
    switch (node.kind) {
      case "intel":
      case "memory":
        return state.leafLabels || node.id === state.hover || node.id === state.selection;
      default:
        return Boolean(node.label);
    }
  };

  /** 맞춤 보기 — 라벨 여백과 아래 예약을 포함한 bounds가 용기 안에 들어오게 맞춘다. */
  const fit = (): void => {
    const surface = state.surface;
    const model = state.model;
    if (!surface || !model || surface.width <= 0 || surface.height <= 0) return;
    const { ctx, width: w, height: h } = surface;
    const nodes = shownNodes();
    state.leafLabels = labelsLeaves(nodes);

    const labelShown = nodes.filter(hasLabel);
    setMapLabelFont(ctx, state.font);
    const labelMax = Math.min(LABEL_MAX, Math.max(60, w * 0.5));
    let halfLabel = 0;
    for (const node of labelShown) {
      halfLabel = Math.max(halfLabel, ctx.measureText(truncateLabel(ctx, node.label, labelMax)).width / 2);
    }
    const coreRadius = Math.max(...nodes.map(nodeRadius), 0);

    const pad = 18;
    const side = Math.min(halfLabel, w * 0.18);
    const left = pad + side;
    const right = w - pad - side;
    const top = pad + coreRadius * 0.4;
    const bottom = h - pad - (labelShown.length > 0 ? mapLabelReserve() + coreRadius : coreRadius);

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
    state.leafLabels = labelsLeaves(shownNodes());
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
      const alpha = dim ? 0.05 : highlighted ? 0.85 : edge.kind === "tree" ? 0.38 : edge.kind === "link" ? 0.4 : edge.kind === "objective" ? 0.3 : 0.18;
      const width = highlighted ? 1.9 : edge.kind === "tree" ? 1.6 : 1;
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
      if (node.stale && !dim) {
        kit.ring(point.x, point.y, r + 3.5, r + 3.5, rgbCss(rgb.stale, 0.85), 1, 1.2, [2.5, 2]);
      }
      if (node.id === state.selection || node.id === state.hover) {
        kit.ring(point.x, point.y, r + 5, r + 5, rgbCss(node.id === state.selection ? rgb.ink : rgb.inkDim), 1, node.id === state.selection ? 2 : 1.2);
      }
    }

    // 라벨 — 노드 아래. 아래 예약은 fit이 이미 잡았다.
    setMapLabelFont(ctx, state.font);
    const labelMax = Math.min(LABEL_MAX, Math.max(60, w * 0.5));
    for (const node of graph.nodes) {
      if (!isVisible(node.id) || !hasLabel(node)) continue;
      const point = points.get(node.id);
      if (!point) continue;
      const dim = focus !== null && !focus.has(node.id);
      kit.text(truncateLabel(ctx, node.label, labelMax), point.x, point.y + nodeRadius(node) + MAP_LABEL_GAP + MAP_LABEL_SIZE * 0.6, {
        color: rgbCss(dim ? rgb.inkDim : rgb.ink, dim ? 0.35 : 0.92),
        size: MAP_LABEL_SIZE,
        weight: 600,
        a: 1,
      });
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
    dispose,
  };

  function dispose(): void {
    state.surface?.dispose();
    state.surface = null;
    state.model = null;
    state.rgb = null;
    state.kit = null;
    state.filter = null;
  }
}
