import type { GlanceKit } from "@fleet-console/ui/glance-kit";

import { MAP_BRANCH_ORDER, type MapBranchKey, type MapGraph, type MapNode } from "../map-graph.js";
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
 * 크기·선·라벨은 시안 비율을 휴대폰 크기로 줄여 쓴다(m9-mockup-gap G3·G4·G8):
 * 점은 `ORBIT_RADIUS_SCALE`만큼 작게, 라벨은 pill 없이 바탕색 그림자 + 점 오른쪽.
 */

/** 작은 갈래도 받는 최소 구역 폭(20°). */
const MIN_SECTOR = Math.PI / 9;
/** 허브 고리는 라벨이 서로 겹치지 않게 조금 넓힌다 — 바깥 고리 대비 비율은 시안과 같다. */
const HUB_RADIUS = 1.8;
const INTEL_RADIUS = 2.35;
const TOPIC_RADIUS = 2.2;
const LEAF_RADII = [2.7, 2.95, 3.2] as const;
const SOURCE_RADIUS = 3.6;
const OBJECTIVE_RADIUS = 4.1;

/** 시안 radius를 휴대폰 무대에 맞게 줄인 배율 — 고르기 반경도 이 보이는 크기다. */
const ORBIT_RADIUS_SCALE = 0.7;
const LABEL_MAX = 132;
/** 이 배율을 넘겨 확대하면 주제 라벨도 단다(자문 답 I). */
const TOPIC_LABEL_ZOOM = 2.2;
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
/** 초점 집합이 이보다 크면 라벨을 달지 않는다(시안 placeLabels). */
const LABEL_FOCUS_LIMIT = 60;

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
  backdrop: MapRgb;
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
    const radius = node.kind === "intel-overflow" ? 1.6 : INTEL_RADIUS + (index % 2) * 0.26;
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
    backdrop: readMapBackdrop(),
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

  /** 보이는 크기 — 시안 radius × 휴대폰 배율 × 밀도 × 확대. 고르기 반경도 이 값이다. */
  const nodeRadius = (node: MapNode, radii: OrbitRadii, atZoom = zoom()): number => {
    const model = state.model;
    const degree = model ? mapNodeDegree(model.graph, node.id) : 0;
    const enlarged = node.id === state.hover || node.id === state.selection ? 1.4 : 1;
    const base = mapNodeRadiusPx(node, degree) * ORBIT_RADIUS_SCALE * radii.density * atZoom * enlarged;
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

  /** 시안 라벨 집합 — 기본(핵·설명·허브·+N·출처), 초점(주제 제외), 확대 시 주제(자문 답 I). */
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
      case "topic":
        if (node.id === state.selection || node.id === state.hover) return MAP_LABEL_PRIORITY.forced;
        return zoom() >= TOPIC_LABEL_ZOOM ? MAP_LABEL_PRIORITY.zoomTopic : null;
      case "objective":
      case "memory":
      case "intel":
        if (node.id === state.selection || node.id === state.hover) return MAP_LABEL_PRIORITY.forced;
        return focusLabels?.has(node.id) ? MAP_LABEL_PRIORITY.focus : null;
    }
  };

  /** 맞춤 보기 — 시안 `extent()*1.04`처럼 보이는 점 반경 최대의 1.04배를 여백으로 쓴다. */
  const fit = (): void => {
    const surface = state.surface;
    const model = state.model;
    if (!surface || !model || surface.width <= 0 || surface.height <= 0) return;
    const { width: w, height: h } = surface;
    const nodes = shownNodes();
    const insets = clampMapInsets(state.insets, w, h);
    const radii = { density: densityFactor(), spacing: Infinity };
    const maxRadius = nodes.reduce((max, node) => Math.max(max, nodeRadius(node, radii, 1)), 1);
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
    const search = searchActive();
    const radii = orbitRadii();
    const light = (0.2126 * rgb.ink[0] + 0.7152 * rgb.ink[1] + 0.0722 * rgb.ink[2]) / 255 < 0.45;
    const mixRgb = (a: MapRgb, b: MapRgb, t: number): MapRgb => [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
    const drawOpticalBead = (x: number, y: number, r: number, color: MapRgb, a: number, major: boolean): void => {
      if (r <= 0.1 || a <= 0.005) return;
      ctx.save();
      ctx.globalAlpha = Math.min(1, a);
      if (major || r >= 3.8) {
        const g = ctx.createRadialGradient(x - r * 0.32, y - r * 0.34, r * 0.06, x, y, r);
        g.addColorStop(0, rgbCss(mixRgb(color, [255, 255, 255], major ? 0.56 : 0.44)));
        g.addColorStop(0.48, rgbCss(color));
        g.addColorStop(1, rgbCss(mixRgb(color, [14, 18, 26], light ? 0.28 : 0.34)));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = rgbCss(color);
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = light
        ? `rgba(255, 255, 255, ${(0.72 * a).toFixed(3)})`
        : rgbCss(mixRgb(color, [255, 255, 255], 0.36), major ? 0.54 : 0.32);
      ctx.lineWidth = major ? 1.15 : 0.75;
      ctx.stroke();
      ctx.restore();
    };

    // 1) A+B 공간 안내층 — 사령관 톤 중앙 광원 · 6갈래 구역 웨지 틴트 · 보정된 극좌표 링 + 나침반 틱.
    if (core) {
      const outerR = Math.max(24, OBJECTIVE_RADIUS * state.view.k);
      const focusFade = focus !== null ? 0.4 : 1;
      // 사령관 톤 중심 광원
      const auraR = outerR * 0.86;
      const ag = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, auraR);
      ag.addColorStop(0, rgbCss(rgb.core, (light ? 0.08 : 0.14) * focusFade));
      ag.addColorStop(0.55, rgbCss(rgb.core, (light ? 0.025 : 0.04) * focusFade));
      ag.addColorStop(1, rgbCss(rgb.core, 0));
      ctx.fillStyle = ag;
      ctx.beginPath();
      ctx.arc(core.x, core.y, auraR, 0, Math.PI * 2);
      ctx.fill();

      // 갈래별 부채꼴 구역 틴트
      const sectors = sectorAllocation(graph);
      for (const branch of MAP_BRANCH_ORDER) {
        const sector = sectors.get(branch);
        if (!sector) continue;
        const bCol = branch === "description" ? rgb.core : rgb[branch];
        const wg = ctx.createRadialGradient(core.x, core.y, outerR * 0.08, core.x, core.y, outerR * 1.06);
        wg.addColorStop(0, rgbCss(bCol, 0));
        wg.addColorStop(0.55, rgbCss(bCol, (light ? 0.068 : 0.075) * focusFade));
        wg.addColorStop(1, rgbCss(bCol, 0));
        ctx.fillStyle = wg;
        ctx.beginPath();
        ctx.moveTo(core.x, core.y);
        ctx.arc(core.x, core.y, outerR * 1.06, sector.start + 0.03, sector.end - 0.03);
        ctx.closePath();
        ctx.fill();
      }

      // 극좌표 안내 고리 + 36개 나침반 틱 + 미세 십자선
      const ringSpecs: readonly { readonly r: number; readonly dash?: readonly number[]; readonly a: number }[] = [
        { r: HUB_RADIUS, a: 0.16 },
        { r: TOPIC_RADIUS, dash: [3, 5], a: 0.14 },
        { r: LEAF_RADII[1], a: 0.15 },
        { r: SOURCE_RADIUS, dash: [2, 5], a: 0.12 },
        { r: OBJECTIVE_RADIUS, a: 0.22 },
      ];
      for (const spec of ringSpecs) {
        kit.ring(core.x, core.y, spec.r * state.view.k, spec.r * state.view.k, rgbCss(rgb.hair, spec.a * focusFade), 1, 1, spec.dash);
      }
      ctx.save();
      ctx.strokeStyle = rgbCss(rgb.inkDim, (light ? 0.18 : 0.18) * focusFade);
      ctx.lineWidth = 0.85;
      for (let i = 0; i < 36; i += 1) {
        const a = (i / 36) * Math.PI * 2;
        const major = i % 3 === 0;
        const r0 = outerR * (major ? 0.945 : 0.968);
        const r1 = outerR * 1.01;
        ctx.beginPath();
        ctx.moveTo(core.x + Math.cos(a) * r0, core.y + Math.sin(a) * r0);
        ctx.lineTo(core.x + Math.cos(a) * r1, core.y + Math.sin(a) * r1);
        ctx.stroke();
      }
      ctx.strokeStyle = rgbCss(rgb.inkDim, 0.07 * focusFade);
      ctx.beginPath();
      ctx.moveTo(core.x - outerR * 1.04, core.y);
      ctx.lineTo(core.x + outerR * 1.04, core.y);
      ctx.moveTo(core.x, core.y - outerR * 1.04);
      ctx.lineTo(core.x, core.y + outerR * 1.04);
      ctx.stroke();
      ctx.restore();
    }

    // 2) 곡선 시냅스 연결선 — 줄기→가지→잔가지 두께 위계 + 줄기 색 전이 + 다크 발광 피복.
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
          ? touches ? Math.min(0.95, base * 2.4 + 0.28) : base * 0.11
          : base;
      const color = mapEdgeRgb(rgb, graph, edge);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const cx = core ? mx + (core.x - mx) * 0.14 : mx;
      const cy = core ? my + (core.y - my) * 0.14 : my;
      const lw = touches ? 2.0 : role === "trunk" ? 1.9 : role === "link" ? 1.3 : role === "branch" ? 1.2 : 0.85;
      ctx.save();
      if (edge.kind === "objective" || edge.kind === "source") ctx.setLineDash([2.5, 3.5]);
      if (!light && (role === "trunk" || touches || role === "link")) {
        ctx.strokeStyle = rgbCss(color, alpha * 0.28);
        ctx.lineWidth = lw + 2.8;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cx, cy, b.x, b.y);
        ctx.stroke();
      }
      if (role === "trunk") {
        const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        grad.addColorStop(0, rgbCss(rgb.core, Math.min(1, alpha * 1.1)));
        grad.addColorStop(1, rgbCss(color, Math.min(1, alpha)));
        ctx.strokeStyle = grad;
      } else {
        ctx.strokeStyle = rgbCss(color, light ? alpha * 0.88 : alpha);
      }
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }

    // 3) 광학 노드 — 다크 생체 발광 구슬 / 라이트 광학 법랑 비드 + 범례 도형 100% 일치.
    for (const node of graph.nodes) {
      if (!isVisible(node.id)) continue;
      const point = points.get(node.id);
      if (!point) continue;
      const r = nodeRadius(node, radii);
      const dim = focus !== null && !focus.has(node.id);
      const color = mapNodeRgb(rgb, node);
      const alpha = 0.96 * (dim ? 0.14 : 1) * (node.stale ? 0.6 : 1) * (node.kind === "topic" ? 0.78 : 1);
      const isMajor = node.kind === "core" || node.kind === "description" || node.kind === "branch" || node.kind === "intel-hub";

      if (!light) {
        if (isMajor || r >= 3.5) {
          const haloR = Math.max(2, r * (node.kind === "core" ? 3.4 : isMajor ? 2.8 : 2.1));
          const hg = ctx.createRadialGradient(point.x, point.y, r * 0.2, point.x, point.y, haloR);
          hg.addColorStop(0, rgbCss(color, (node.kind === "core" ? 0.48 : isMajor ? 0.34 : 0.22) * alpha));
          hg.addColorStop(0.45, rgbCss(color, 0.12 * alpha));
          hg.addColorStop(1, rgbCss(color, 0));
          ctx.fillStyle = hg;
          ctx.beginPath();
          ctx.arc(point.x, point.y, haloR, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // 라이트: 미세 접지 그림자
        ctx.fillStyle = `rgba(22, 30, 44, ${(0.12 * alpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(point.x, point.y + Math.max(0.8, r * 0.2), r * 1.06, 0, Math.PI * 2);
        ctx.fill();
      }

      if (node.kind === "core") {
        // 사령관 핵: 동심 시냅스 고리 + 4방위 나침반 틱 + 광학 구슬
        kit.ring(point.x, point.y, r * 1.38, r * 1.38, rgbCss(color, (light ? 0.42 : 0.48) * alpha), 1, 1.3);
        kit.ring(point.x, point.y, r * 1.82, r * 1.82, rgbCss(color, (light ? 0.22 : 0.24) * alpha), 1, 1, [3, 4]);
        ctx.save();
        ctx.strokeStyle = rgbCss(color, 0.5 * alpha);
        ctx.lineWidth = 1;
        for (let k = 0; k < 4; k += 1) {
          const ka = (k * Math.PI) / 2;
          ctx.beginPath();
          ctx.moveTo(point.x + Math.cos(ka) * r * 1.25, point.y + Math.sin(ka) * r * 1.25);
          ctx.lineTo(point.x + Math.cos(ka) * r * 1.98, point.y + Math.sin(ka) * r * 1.98);
          ctx.stroke();
        }
        ctx.restore();
        drawOpticalBead(point.x, point.y, r, color, alpha, true);
      } else if (node.kind === "intel") {
        // 정보: 45도 회전 둥근 마름모 크리스탈
        ctx.save();
        ctx.translate(point.x, point.y);
        ctx.rotate(Math.PI / 4);
        const s = r * 1.48;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = rgbCss(color);
        ctx.beginPath();
        ctx.roundRect(-s / 2, -s / 2, s, s, Math.max(1.2, s * 0.22));
        ctx.fill();
        ctx.strokeStyle = light ? "rgba(255,255,255,0.78)" : rgbCss(mixRgb(color, [255, 255, 255], 0.42), 0.85);
        ctx.lineWidth = 0.9;
        ctx.stroke();
        ctx.restore();
      } else if (node.kind === "objective") {
        // 목표: 바탕 채움 + 또렷한 외곽 링 + 중앙 점
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = rgbCss(rgb.stageCore, 0.94);
        ctx.beginPath();
        ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rgbCss(color, 0.92);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = rgbCss(color, 0.92);
        ctx.beginPath();
        ctx.arc(point.x, point.y, Math.max(1.4, r * 0.34), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (node.kind === "intel-overflow") {
        // +N 묶음: 외곽 고리 + 내부 3점
        kit.ring(point.x, point.y, r * 1.15, r * 1.15, rgbCss(color, 0.92), alpha, 1.5);
        for (let k = 0; k < 3; k += 1) {
          const ka = k * 2.0943951;
          kit.dot(point.x + Math.cos(ka) * r * 0.44, point.y + Math.sin(ka) * r * 0.44, Math.max(1.3, r * 0.25), rgbCss(color), alpha);
        }
      } else {
        if (isMajor) kit.ring(point.x, point.y, r * 1.38, r * 1.38, rgbCss(color, 0.46), alpha, 1.15);
        drawOpticalBead(point.x, point.y, r, color, alpha, isMajor);
      }

      // 상태 신호: fresh = 청록 외곽 아크(범주 색을 오염시키지 않음), stale = 점선 호박 고리
      if (node.fresh && !dim && node.kind !== "core") {
        ctx.save();
        ctx.strokeStyle = rgbCss(rgb.fresh, light ? 0.86 : 0.92);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(point.x, point.y, r + 2.8, -Math.PI * 0.65, Math.PI * 0.6);
        ctx.stroke();
        ctx.restore();
      }
      if (node.stale && !dim) {
        kit.ring(point.x, point.y, r + 3.4, r + 3.4, rgbCss(rgb.stale, 0.9), 0.9, 1.3, [2.5, 2.2]);
      }
      if (node.id === state.selection || node.id === state.hover) {
        const rr = r + 5.2;
        ctx.save();
        ctx.strokeStyle = rgbCss(node.id === state.selection ? rgb.ink : color, 0.94);
        ctx.lineWidth = node.id === state.selection ? 1.8 : 1.3;
        for (let k = 0; k < 4; k += 1) {
          const sa = (k * Math.PI) / 2 + 0.24;
          ctx.beginPath();
          ctx.arc(point.x, point.y, rr, sa, sa + Math.PI / 2 - 0.48);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 라벨 — 기본은 핵·설명·허브·+N·출처. 초점(≤60)은 그 점들(주제 제외),
    // 주제는 2.2배 넘게 확대했을 때만 단다(자문 답 I). 충돌하면 낮은 쪽을 버린다.
    const shown = shownNodes();
    const focusLabels = focus !== null && focus.size <= LABEL_FOCUS_LIMIT
      ? focus
      : search && shown.length <= LABEL_FOCUS_LIMIT
        ? new Set(shown.map((node) => node.id))
        : null;
    const candidates: MapLabelCandidate[] = [];
    for (const node of graph.nodes) {
      if (!isVisible(node.id) || !node.label) continue;
      const priority = labelPriority(node, focusLabels);
      if (priority === null) continue;
      const point = points.get(node.id);
      if (!point) continue;
      if (point.x < -40 || point.x > w + 40 || point.y < -20 || point.y > h + 20) continue;
      const strong = node.kind === "core" || node.kind === "description" || node.kind === "branch" || node.kind === "intel-hub";
      const outside = focus !== null && !focus.has(node.id);
      candidates.push({
        text: node.label,
        x: point.x,
        y: point.y,
        radius: nodeRadius(node, radii),
        priority,
        color: rgbCss(outside ? rgb.inkDim : strong ? rgb.ink : rgb.inkDim),
        alpha: outside ? 0.35 : 1,
        strong,
      });
    }
    drawMapLabels(ctx, state.font, state.backdrop, candidates, w, h, Math.min(LABEL_MAX, Math.max(56, w * 0.42)));
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
    state.backdrop = readMapBackdrop();
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
