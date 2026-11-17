import type { GlanceKit } from "@fleet-console/ui/glance-kit";

import { MAP_BRANCH_ORDER, type MapBranchKey, type MapGraph, type MapNode } from "../map-graph.js";
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
 * 안 C — 궤도 지도(휴대폰). 갈래마다 고정 각도 구역을 주는 방사형 배치다.
 *
 * 구역 폭은 갈래의 노드 수에 비례하되, 노드가 하나뿐인 갈래도 `MIN_SECTOR`만큼은 받는다.
 * 손가락은 핀치로 확대하고 끌기로 옮긴다(두 번 누르면 맞춤 보기로 복귀). 움직임은
 * 손가락이 움직일 때만 그리고, 상시 rAF 루프·자동 회전은 없다.
 *
 * Canvas 2D를 고른 이유: 승격한 glance 키트의 발광(radial gradient)을 그대로 쓰고,
 * 기억 200개에서 SVG 요소 수백 개의 레이아웃·래스터 비용을 피하며, 핀치 변환을
 * 우리가 직접 소유해 라벨 컬링까지 한 번에 처리할 수 있다.
 *
 * 크기 규칙(D13): 점 크기는 보이는 노드 수와 잎 고리 둘레로 줄인다. 라벨 규칙(D11)은
 * 핵·허브는 항상, 주제는 충돌 회피, 기억·정보·목표는 2.2배 넘게 확대했거나 호버·선택일 때만.
 */

/** 작은 갈래도 받는 최소 구역 폭(20°). */
const MIN_SECTOR = Math.PI / 9;
const HUB_RADIUS = 1;
const INTEL_RADIUS = 1.85;
const TOPIC_RADIUS = 1.7;
const LEAF_RADII = [2.4, 2.72, 3.02] as const;
const SOURCE_RADIUS = 3.25;
const OBJECTIVE_RADIUS = 3.95;

/** 노드 size 1(핵)이 15 CSS px — 고르기 반경도 이 보이는 크기 × 배율이다. */
const NODE_PX = 15;
const LABEL_MAX = 132;
/** 이 배율을 넘겨 확대하면 잎(기억·정보·목표) 라벨도 단다. */
const LEAF_LABEL_ZOOM = 2.2;
/** 노드가 이보다 많으면 점을 줄이기 시작한다. */
const DENSITY_FULL = 96;
const DENSITY_MIN = 0.5;
/** 잎 점 지름이 이웃 잎 간격의 이 비율을 넘지 않게 한다. */
const LEAF_SPACING_RATIO = 0.3;
const MIN_LEAF_PX = 2;
const MIN_NODE_PX = 3;
const MAX_NODE_PX = 22;
/** 손가락 고르기 — 점이 작아도 이 반경 안이면 맞는다. */
const MIN_HIT_PX = 5;

interface OrbitSector {
  start: number;
  end: number;
}

interface OrbitRadii {
  /** 노드 수에 따른 축소 배율. */
  readonly density: number;
  /** 잎 고리 둘레의 이웃 간격(px). */
  readonly spacing: number;
}

interface OrbitView {
  /** 화면 px / 배치 단위. */
  k: number;
  /** 배치 원점의 화면 px. */
  tx: number;
  ty: number;
  /** 맞춤 보기 배율 — 노드 크기·라벨 기준의 1배. */
  fitK: number;
}

interface OrbitState {
  surface: MapCanvasSurface | null;
  model: PositionedMapModel | null;
  rgb: MapRgbPalette | null;
  kit: GlanceKit | null;
  font: string;
  points: Map<string, { x: number; y: number }>;
  selection: string | null;
  hover: string | null;
  filter: ReadonlySet<string> | null;
  view: OrbitView;
  insets: MapFitInsets;
  cleanup: (() => void) | null;
  /** 보기 변화 구독 — 그리기는 제스처·상태 변화 때만 돈다. */
  viewListeners: Set<() => void>;
}

function sectorAllocation(graph: MapGraph): Map<MapBranchKey, OrbitSector> {
  const counts = MAP_BRANCH_ORDER.map((branch) => Math.max(1, graph.branchCounts[branch] ?? 0));
  const total = counts.reduce((sum, count) => sum + count, 0);
  const free = Math.PI * 2 - MIN_SECTOR * MAP_BRANCH_ORDER.length;
  const out = new Map<MapBranchKey, OrbitSector>();
  let cursor = -Math.PI / 2;
  MAP_BRANCH_ORDER.forEach((branch, index) => {
    const span = MIN_SECTOR + (free * (counts[index] ?? 1)) / total;
    out.set(branch, { start: cursor, end: cursor + span });
    cursor += span;
  });
  return out;
}

const polar = (angle: number, radius: number): { x: number; y: number } => ({
  x: Math.cos(angle) * radius,
  y: Math.sin(angle) * radius,
});

const sectorMid = (sector: OrbitSector): number => (sector.start + sector.end) / 2;

/** 구역 안에서 i번째(0-based)의 각도 — 작은 갈래도 최소 폭 안에서 고르게 편다. */
function angleAt(sector: OrbitSector, index: number, count: number): number {
  const span = sector.end - sector.start;
  return sector.start + span * ((index + 0.5) / Math.max(1, count));
}

/** 갈래별 고정 각도 방사형 배치 — 같은 그래프는 항상 같은 좌표다. */
function placeGraph(graph: MapGraph): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  out.set("core", { x: 0, y: 0 });
  const sectors = sectorAllocation(graph);
  const sectorOf = (branch: MapBranchKey): OrbitSector => sectors.get(branch) ?? { start: 0, end: MIN_SECTOR };
  const nodeOf = (branch: MapBranchKey): { x: number; y: number } => polar(sectorMid(sectorOf(branch)), HUB_RADIUS);

  // 허브 — 설명·정보·기억 4갈래는 자기 구역의 중앙, 반지름 1.
  for (const node of graph.nodes) {
    if (node.kind === "description" || node.kind === "intel-hub" || node.kind === "branch") {
      out.set(node.id, nodeOf(node.branch ?? "description"));
    }
  }

  // 정보 갈래 — 정보·묶음은 안쪽 고리, 출처는 바깥 고리.
  const intelSector = sectorOf("intel");
  const intelNodes = graph.nodes.filter((node) => node.kind === "intel" || node.kind === "intel-overflow");
  intelNodes.forEach((node, index) => {
    const radius = node.kind === "intel-overflow" ? 1.28 : INTEL_RADIUS + (index % 2) * 0.26;
    out.set(node.id, polar(angleAt(intelSector, index, intelNodes.length), radius));
  });
  const sources = graph.nodes.filter((node) => node.kind === "source");
  sources.forEach((node, index) => {
    out.set(node.id, polar(angleAt(intelSector, index, sources.length), SOURCE_RADIUS));
  });

  // 기억 갈래 — 주제는 중간 고리, 기억은 주제 구역 안에서 세 고리를 번갈아 쓴다.
  let leafIndex = 0;
  for (const branch of MAP_BRANCH_ORDER) {
    if (branch === "description" || branch === "intel") continue;
    const sector = sectorOf(branch);
    const topics = graph.nodes.filter((node) => node.kind === "topic" && node.branch === branch);
    const span = sector.end - sector.start;
    const inner = { start: sector.start + span * 0.06, end: sector.end - span * 0.06 };
    topics.forEach((topic, topicIndex) => {
      const topicSpan = (inner.end - inner.start) / Math.max(1, topics.length);
      const start = inner.start + topicSpan * topicIndex;
      const sub = { start, end: start + topicSpan };
      out.set(topic.id, polar(sectorMid(sub), TOPIC_RADIUS));
      const memories = graph.nodes.filter(
        (node) => node.kind === "memory" && node.branch === branch && node.topic === topic.topic,
      );
      memories.forEach((memory, memoryIndex) => {
        const radius = LEAF_RADII[leafIndex % LEAF_RADII.length] ?? LEAF_RADII[0];
        out.set(memory.id, polar(angleAt(sub, memoryIndex, memories.length), radius));
        leafIndex += 1;
      });
    });
  }

  // 목표 — 이어진 기억들의 평균 각도 바깥 고리에 세운다(결정 d9c36b41의 같은 목표 연결).
  const objectives = graph.nodes
    .filter((node) => node.kind === "objective")
    .map((node) => {
      let sx = 0;
      let sy = 0;
      let count = 0;
      for (const edge of graph.edges) {
        if (edge.kind !== "objective" || edge.from !== node.id) continue;
        const point = out.get(edge.to);
        if (!point) continue;
        const length = Math.hypot(point.x, point.y) || 1;
        sx += point.x / length;
        sy += point.y / length;
        count += 1;
      }
      const angle = count > 0 ? Math.atan2(sy, sx) : sectorMid(sectorOf(node.branch ?? "person"));
      return { node, angle };
    })
    .sort((a, b) => a.angle - b.angle || (a.node.id < b.node.id ? -1 : 1));
  objectives.forEach(({ node, angle }, index) => {
    out.set(node.id, polar(angle, OBJECTIVE_RADIUS + (index % 2) * 0.16));
  });

  return out;
}

export function createMapRenderer(): MapRenderer {
  const state: OrbitState = {
    surface: null,
    model: null,
    rgb: null,
    kit: null,
    font: readMapFont(),
    points: new Map(),
    selection: null,
    hover: null,
    filter: null,
    view: { k: 1, tx: 0, ty: 0, fitK: 1 },
    insets: DEFAULT_MAP_INSETS,
    cleanup: null,
    viewListeners: new Set(),
  };

  const isVisible = (id: string): boolean => state.filter === null || state.filter.has(id);
  const zoom = (): number => (state.view.fitK > 0 ? state.view.k / state.view.fitK : 1);

  /**
   * 노드 수가 많을수록 점을 줄인다(D13). 200개 무대에서 잎이 궤도보다 커 보이던 것을
   * 96개를 기준으로 줄이고, 아래에서는 잎 고리 둘레의 이웃 간격에도 맞춘다.
   */
  const densityFactor = (): number => {
    const count = Math.max(1, shownNodes().length);
    return Math.min(1, Math.max(DENSITY_MIN, Math.sqrt(DENSITY_FULL / count)));
  };

  /** 잎이 놓인 세 고리의 둘레를 잎 수로 나눈 화면 간격(px). */
  const leafSpacing = (): number => {
    const model = state.model;
    if (!model) return Infinity;
    let leaves = 0;
    for (const node of model.graph.nodes) {
      if (!isVisible(node.id)) continue;
      if (node.kind === "intel" || node.kind === "memory") leaves += 1;
    }
    if (leaves === 0) return Infinity;
    const circumference = Math.PI * 2 * state.view.k * LEAF_RADII.reduce((sum, radius) => sum + radius, 0);
    return circumference / leaves;
  };

  /** 보이는 크기(노드 size × 배율) — 고르기 반경도 이 값을 쓴다. */
  const nodeRadius = (node: MapNode, radii: OrbitRadii): number => {
    // `+N` 묶음은 정보 점보다 크게(수정 8-1).
    const boost = node.kind === "intel-overflow" ? 1.6 : 1;
    const base = mapNodeSize(node.kind) * NODE_PX * boost * radii.density * zoom();
    const leaf = node.kind === "intel" || node.kind === "memory";
    const capped = leaf ? Math.min(base, radii.spacing * LEAF_SPACING_RATIO) : base;
    const floor = leaf ? MIN_LEAF_PX : node.kind === "core" ? MIN_NODE_PX + 2 : MIN_NODE_PX;
    return Math.max(0.01, Math.min(MAX_NODE_PX, Math.max(floor, capped)));
  };

  /** 한 번 그릴 때의 밀도·간격 — 노드마다 다시 세지 않는다. */
  const orbitRadii = (): OrbitRadii => ({ density: densityFactor(), spacing: leafSpacing() });

  const screenOf = (node: MapNode): { x: number; y: number } | null => {
    const point = state.points.get(node.id);
    if (!point) return null;
    return { x: state.view.tx + point.x * state.view.k, y: state.view.ty + point.y * state.view.k };
  };

  const shownNodes = (): MapNode[] => {
    const model = state.model;
    if (!model) return [];
    return model.graph.nodes.filter((node) => isVisible(node.id) && state.points.has(node.id));
  };

  /** 라벨 후보 — 목표·기억·정보는 충분히 확대했거나 호버·선택일 때만. */
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
        // `+N`은 늘 보이는 라벨 — 허브와 같은 급(수정 8-1).
        return MAP_LABEL_PRIORITY.hub;
      case "objective":
      case "memory":
      case "intel": {
        if (node.id === state.hover || node.id === state.selection) return MAP_LABEL_PRIORITY.forced;
        return zoom() >= LEAF_LABEL_ZOOM ? MAP_LABEL_PRIORITY.leaf : null;
      }
    }
  };

  const fit = (): void => {
    const surface = state.surface;
    const model = state.model;
    if (!surface || !model || surface.width <= 0 || surface.height <= 0) return;
    const { width: w, height: h } = surface;
    const nodes = shownNodes();
    const insets = clampMapInsets(state.insets, w, h);

    const pad = 10;
    const left = insets.left + pad;
    const right = w - insets.right - pad;
    const top = insets.top + pad;
    const bottom = h - insets.bottom - pad - mapLabelReserve();

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      const point = state.points.get(node.id);
      if (!point) continue;
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
    if (!Number.isFinite(minX)) {
      state.view = { k: 1, tx: w / 2, ty: h / 2, fitK: 1 };
      return;
    }

    const worldW = Math.max(1e-3, maxX - minX);
    const worldH = Math.max(1e-3, maxY - minY);
    const availW = Math.max(1, right - left);
    const availH = Math.max(1, bottom - top);
    const k = Math.min(400, Math.max(8, Math.min(availW / worldW, availH / worldH)));
    state.view = {
      k,
      fitK: k,
      tx: left + (availW - worldW * k) / 2 - minX * k,
      ty: top + (availH - worldH * k) / 2 - minY * k,
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
    const radii = orbitRadii();

    // 궤도 안내 고리 — 방사형 읽기를 돕는다. 중심은 핵.
    if (core) {
      for (const radius of [HUB_RADIUS, TOPIC_RADIUS, LEAF_RADII[1], SOURCE_RADIUS, OBJECTIVE_RADIUS]) {
        kit.ring(core.x, core.y, radius * state.view.k, radius * state.view.k, rgbCss(rgb.hair, 0.16), 1, 1, [3, 6]);
      }
    }

    for (const edge of graph.edges) {
      if (!isVisible(edge.from) || !isVisible(edge.to)) continue;
      const a = points.get(edge.from);
      const b = points.get(edge.to);
      if (!a || !b) continue;
      const highlighted = focus !== null && (focus.has(edge.from) || focus.has(edge.to));
      const dim = focus !== null && !highlighted;
      const to = graph.byId.get(edge.to);
      const color = to ? mapNodeRgb(rgb, to) : rgb.inkDim;
      const alpha = dim ? 0.05 : highlighted ? 0.85 : edge.kind === "tree" ? 0.34 : edge.kind === "link" ? 0.4 : edge.kind === "objective" ? 0.17 : 0.16;
      // 같은 목표 연결은 구조선보다 확실히 약하게(수정 8-8).
      const width = highlighted ? 1.9 : edge.kind === "tree" ? 1.5 : edge.kind === "objective" ? 0.8 : 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const cx = core ? mx + (core.x - mx) * 0.1 : mx;
      const cy = core ? my + (core.y - my) * 0.1 : my;
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

    for (const node of graph.nodes) {
      if (!isVisible(node.id)) continue;
      const point = points.get(node.id);
      if (!point) continue;
      const r = nodeRadius(node, radii);
      const dim = focus !== null && !focus.has(node.id);
      const color = mapNodeRgb(rgb, node);
      const alpha = dim ? 0.18 : node.stale ? 0.55 : 1;
      const glowColor = node.fresh && !dim ? rgb.fresh : color;
      kit.glow(point.x, point.y, Math.max(0.01, r * 3), rgbCss(glowColor), dim ? 0.08 : node.kind === "core" ? 0.95 : node.fresh ? 0.7 : 0.4);

      if (node.kind === "intel") {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = rgbCss(color);
        ctx.fillRect(point.x - r, point.y - r, r * 2, r * 2);
        ctx.restore();
      } else {
        kit.dot(point.x, point.y, Math.max(0.01, node.kind === "objective" ? r * 0.55 : r), rgbCss(color), alpha);
      }
      if (node.kind === "objective") kit.ring(point.x, point.y, r, r, rgbCss(color, 0.8), dim ? 0.15 : 0.8, 1.2);
      if (node.kind === "intel-overflow") {
        // 정보 점과 구별되는 큰 점 + 고리(수정 8-1).
        kit.ring(point.x, point.y, r + 3, r + 3, rgbCss(color, 0.9), dim ? 0.15 : 0.85, 1.8);
      }
      if (node.stale && !dim) kit.ring(point.x, point.y, r + 3.5, r + 3.5, rgbCss(rgb.stale, 0.85), 1, 1.2, [2.5, 2]);
      if (node.id === state.selection || node.id === state.hover) {
        kit.ring(point.x, point.y, r + 5, r + 5, rgbCss(node.id === state.selection ? rgb.ink : rgb.inkDim), 1, node.id === state.selection ? 2 : 1.2);
      }
    }

    // 라벨 — 우선순위대로 자리를 잡고 겹치면 낮은 쪽을 버린다(D11·D13).
    // 설명 허브는 핵 반대 바깥쪽에 둔다 — 중앙에서 핵 라벨과 겹치던 것을 떼어 놓는다(수정 4 D2).
    const candidates: MapLabelCandidate[] = [];
    const corePoint = points.get("core");
    for (const node of graph.nodes) {
      if (!isVisible(node.id) || !node.label) continue;
      const priority = labelPriority(node);
      if (priority === null) continue;
      const point = points.get(node.id);
      if (!point) continue;
      if (point.x < -40 || point.x > w + 40 || point.y < -20 || point.y > h + 20) continue;
      const dim = focus !== null && !focus.has(node.id);
      const outward = node.kind === "description" && corePoint ? Math.sign(point.y - corePoint.y) || 1 : 1;
      candidates.push({
        text: node.label,
        x: point.x,
        y: point.y + outward * (nodeRadius(node, radii) + MAP_LABEL_GAP + MAP_LABEL_SIZE * 0.6),
        priority,
        color: rgbCss(dim ? rgb.inkDim : rgb.ink),
        alpha: dim ? 0.3 : 0.92,
      });
    }
    drawMapLabels(ctx, kit, state.font, candidates, w, h, Math.min(LABEL_MAX, Math.max(56, w * 0.42)));
    for (const listener of state.viewListeners) {
      try { listener(); } catch { /* DOM 동기 실패는 다음 그림으로 미룬다 */ }
    }
  };

  /** 포인터 — 한 손가락은 끌기, 두 손가락은 핀치. 두 번 누르면 맞춤 보기. */
  const bindGestures = (surface: MapCanvasSurface): (() => void) | null => {
    const { canvas } = surface;
    canvas.style.touchAction = "none";
    canvas.style.cursor = "grab";
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; worldX: number; worldY: number; k: number } | null = null;
    let tap: { at: number; x: number; y: number } | null = null;
    let lastTap: { at: number; x: number; y: number } | null = null;

    const local = (event: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const pair = (): [{ x: number; y: number }, { x: number; y: number }] | null => {
      const list = [...pointers.values()];
      if (list.length < 2 || !list[0] || !list[1]) return null;
      return [list[0], list[1]];
    };

    const startPinch = (): void => {
      const both = pair();
      if (!both) return;
      const [a, b] = both;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const { k, tx, ty } = state.view;
      pinch = { dist, worldX: (mid.x - tx) / k, worldY: (mid.y - ty) / k, k };
    };

    const down = (event: PointerEvent): void => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      canvas.setPointerCapture(event.pointerId);
      const point = local(event);
      pointers.set(event.pointerId, point);
      tap = pointers.size === 1 ? { at: performance.now(), x: point.x, y: point.y } : null;
      if (pointers.size === 1) pinch = null;
      if (pointers.size === 2) startPinch();
      canvas.style.cursor = "grabbing";
    };

    const move = (event: PointerEvent): void => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const point = local(event);
      pointers.set(event.pointerId, point);
      if (pointers.size >= 2) {
        const both = pair();
        if (!both || !pinch) return;
        const [a, b] = both;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const k = Math.min(400, Math.max(8, pinch.k * (dist / pinch.dist)));
        state.view = { k, fitK: state.view.fitK, tx: mid.x - pinch.worldX * k, ty: mid.y - pinch.worldY * k };
        draw();
        return;
      }
      state.view = {
        ...state.view,
        tx: state.view.tx + (point.x - previous.x),
        ty: state.view.ty + (point.y - previous.y),
      };
      draw();
    };

    const up = (event: PointerEvent): void => {
      const point = pointers.get(event.pointerId) ?? local(event);
      pointers.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (pointers.size === 1) {
        pinch = null;
        canvas.style.cursor = "grabbing";
      } else if (pointers.size === 0) {
        pinch = null;
        canvas.style.cursor = "grab";
        if (tap && performance.now() - tap.at < 320 && Math.hypot(point.x - tap.x, point.y - tap.y) < 10) {
          if (lastTap && performance.now() - lastTap.at < 340 && Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < 26) {
            lastTap = null;
            fit();
            draw();
          } else {
            lastTap = { at: performance.now(), x: point.x, y: point.y };
          }
        }
        tap = null;
      }
    };

    const dblclick = (): void => {
      fit();
      draw();
    };

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("dblclick", dblclick);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("dblclick", dblclick);
      pointers.clear();
    };
  };

  const readPalette = (palette: MapPalette): void => {
    state.rgb = mapRgbPalette(palette);
    state.font = readMapFont();
    state.kit = state.surface ? mapGlanceKit(state.surface.ctx, palette, state.font) : null;
  };

  const rebuild = (): void => {
    state.points = state.model ? placeGraph(state.model.graph) : new Map();
    fit();
    draw();
  };

  return {
    mount(container, model, palette) {
      dispose();
      const surface = attachMapCanvas(container, rebuild);
      if (!surface) return;
      state.surface = surface;
      state.model = model;
      readPalette(palette);
      state.cleanup = bindGestures(surface);
      rebuild();
    },
    update(model, palette) {
      state.model = model;
      readPalette(palette);
      rebuild();
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
      const radii = orbitRadii();
      let best: string | null = null;
      let bestDistance = Infinity;
      for (const node of model.graph.nodes) {
        if (!isVisible(node.id)) continue;
        const point = screenOf(node);
        if (!point) continue;
        const r = Math.max(nodeRadius(node, radii), MIN_HIT_PX);
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
    state.cleanup?.();
    state.cleanup = null;
    state.surface?.dispose();
    state.surface = null;
    state.model = null;
    state.rgb = null;
    state.kit = null;
    state.filter = null;
    state.points = new Map();
    state.viewListeners.clear();
  }
}
