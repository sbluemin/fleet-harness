import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OneMinusSrcColorFactor,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { MapEdgeKind, MapNode } from "../map-graph.js";
import { mapNodeSize } from "../map-layout.js";
import { mapPaletteToRgb, type MapPalette } from "../map-palette.js";
import type { MapRenderer, PositionedMapModel } from "../map-renderers.js";

/**
 * three.js 렌더러(안 D) — 이 파일과 three는 지도를 열 때만 받는 지연 청크다.
 * 점 셰이더 1개(발광·초점 흐림)·연결선 셰이더 1개(화면 폭 리본)·Bloom, WebGL2 컨텍스트 1개.
 * 카메라는 정면이 기본이고 끌 때만 돈다(자동 회전 없음, 손을 떼면 그 각도로 머문다).
 * CSP 때문에 blob 워커·WASM·eval은 쓰지 않는다.
 */

/** 맞춤 보기 여백(CSS px) — 라벨은 점 오른쪽에 서고 아래에는 패널·범례가 걸친다. */
export interface MapFitInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface MapWebglRenderer extends MapRenderer {
  /** 맞춤 보기 여백 갈아끼우기(라벨·패널 크기를 아는 상위용). 기본값은 아래 `DEFAULT_INSETS`. */
  setFitInsets(insets: MapFitInsets): void;
}

const DEFAULT_INSETS: MapFitInsets = { top: 36, right: 110, bottom: 56, left: 36 };

const FOV_DEG = 40;
/** 점 지름(세계 단위) = `mapNodeSize` × 이 값. 배치 간격(크기 합×0.22)보다 작게 둔다. */
const DOT_UNIT = 0.2;
/** 스프라이트(발광 포함) 지름 / 또렷한 점 지름 — 프래그먼트 셰이더의 점 반경 0.36과 짝이다. */
const HALO = 2.8;
/** 초점 흐림 — 초점에서 이 비율(거리 대비)만큼 떨어지면 가장 흐리고, 흐릴수록 스프라이트가 이만큼 커진다. */
const DOF_RANGE = 0.55;
const DOF_GROW = 0.9;
const MAX_SPRITE_CSS = 96;
const MIN_HIT_PX = 4;
const MAX_PIXEL_RATIO = 1.5;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 2.5;
/** 끌기 감도(rad/px)와 회전 범위 — 점 z 깊이가 ±8%뿐이라 그 이상 돌리면 옆면에서 점만 겹친다. */
const DRAG_RAD_PER_PX = 0.0016;
const ANGLE_LIMIT = (35 * Math.PI) / 180;
const DRAG_THRESHOLD_PX = 3;
const FIT_TWEEN_MS = 450;
/** 밀도 보정이 서는 구간 — 이 수 이하는 성글게, 이 수 이상은 가장 빽빽하게 본다. */
const CROWD_FROM = 24;
const CROWD_TO = 200;

const POINT_VERTEX = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
uniform float uScale;
uniform float uFocus;
uniform float uRange;
uniform float uMaxPx;
varying vec3 vColor;
varying float vAlpha;
varying float vCoc;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 0.01);
  float coc = clamp(abs(depth - uFocus) / uRange, 0.0, 1.0);
  vCoc = coc;
  vColor = aColor;
  vAlpha = aAlpha * (1.0 - coc * 0.55) / (1.0 + coc * 2.2);
  gl_PointSize = min(aSize * ${HALO.toFixed(1)} * uScale / depth * (1.0 + coc * ${DOF_GROW.toFixed(1)}), uMaxPx);
  gl_Position = projectionMatrix * mv;
}`;

const POINT_FRAGMENT = /* glsl */ `
uniform float uGain;
uniform float uLight;
varying vec3 vColor;
varying float vAlpha;
varying float vCoc;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0);
  if (d > 1.0) discard;
  float sharp = smoothstep(0.42, 0.3, d) + exp(-d * d * 7.0) * 0.45 * smoothstep(1.0, 0.6, d);
  float bokeh = smoothstep(1.0, 0.84, d) * (0.42 + 0.58 * smoothstep(0.5, 0.95, d));
  float a = clamp(mix(sharp, bokeh, vCoc) * vAlpha, 0.0, 1.0);
  vec3 rgb = vColor * uGain;
  gl_FragColor = vec4(mix(rgb * a, rgb, uLight), a);
}`;

/**
 * 연결선 — 화면 폭이 있는 리본. 선택·호버 강조에서 굵기를 키우려고 GL 선(1px 고정) 대신 쓴다.
 * 두 끝점을 화면 px로 옮겨 수직 방향으로 `aWidth`만큼 벌린다.
 */
const LINE_VERTEX = /* glsl */ `
attribute vec3 aOther;
attribute vec2 aSide;
attribute vec4 aRgba;
attribute float aWidth;
uniform vec2 uRes;
varying vec4 vC;
varying float vDist;
varying float vHalf;
void main() {
  mat4 m = projectionMatrix * modelViewMatrix;
  vec4 p0 = m * vec4(position, 1.0);
  vec4 p1 = m * vec4(aOther, 1.0);
  vec2 half_ = uRes * 0.5;
  vec2 s0 = p0.xy / p0.w * half_;
  vec2 s1 = p1.xy / p1.w * half_;
  vec2 d = s1 - s0;
  float len = length(d);
  d = len > 1e-4 ? d / len * aSide.y : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  float hw = aWidth * 0.5;
  vec2 s = s0 + n * aSide.x * (hw + 0.75);
  gl_Position = vec4(s / half_ * p0.w, p0.z, p0.w);
  vC = aRgba;
  vDist = aSide.x * (hw + 0.75);
  vHalf = hw;
}`;

const LINE_FRAGMENT = /* glsl */ `
uniform float uLight;
varying vec4 vC;
varying float vDist;
varying float vHalf;
void main() {
  float a = vC.a * clamp(vHalf - abs(vDist) + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(mix(vC.rgb * a, vC.rgb, uLight), a);
}`;

/**
 * 마지막 패스 — 밝은 부분의 채널 비율(색조)을 지킨 채 눌러 흰색으로 뭉치지 않게 하고,
 * 투명 캔버스 위 합성을 위해 알파를 밝기(최대 채널)로 둔다(곱셈 알파 캔버스).
 */
const FINAL_SHADER = {
  uniforms: { tDiffuse: { value: null as unknown } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    // 화면 위치 기반 삼각 분포 잡음 — 어두운 발광 꼬리가 8비트에서 동심원 띠로 끊기는 것을 푼다.
    float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
    void main() {
      vec3 c = max(texture2D(tDiffuse, vUv).rgb, vec3(0.0));
      float m = max(c.r, max(c.g, c.b));
      if (m <= 0.0) { gl_FragColor = vec4(0.0); return; }
      float knee = 0.7;
      float soft = m < knee ? m : knee + (1.0 - knee) * (1.0 - exp(-(m - knee) / (1.0 - knee)));
      float noise = (ign(gl_FragCoord.xy) + ign(gl_FragCoord.xy + vec2(5.588238, 5.588238)) - 1.0) / 255.0;
      vec3 outRgb = max(c * (soft / m) + noise, vec3(0.0));
      gl_FragColor = vec4(outRgb, max(soft + noise, 0.0));
    }`,
};

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

type Rgb = readonly [number, number, number];
type PaletteKey = keyof MapPalette;

/** 연결선 기본 굵기(CSS px) — 강조되면 최대 +1.9. */
const EDGE_WIDTH = 1.1;
const EDGE_ALPHA: Record<MapEdgeKind, number> = { tree: 0.38, link: 0.45, objective: 0.4, source: 0.14 };

function paletteKeyOf(node: MapNode): PaletteKey {
  switch (node.kind) {
    case "core": return "core";
    case "description": return "description";
    case "intel-hub": case "intel": case "intel-overflow": return "intel";
    case "source": return "source";
    case "objective": return "objective";
    case "branch": case "topic": case "memory":
      return node.branch === "person" || node.branch === "theater" || node.branch === "lessons" || node.branch === "crew"
        ? node.branch
        : "ink";
  }
}

function relativeLuminance(rgb: Rgb): number {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

class MapWebglRendererImpl implements MapWebglRenderer {
  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: WebGLRenderer | null = null;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV_DEG, 1, 0.05, 400);
  private pointGeo = new BufferGeometry();
  private lineGeo = new BufferGeometry();
  private pointMat: ShaderMaterial | null = null;
  private lineMat: ShaderMaterial | null = null;
  private readonly lightUniform = { value: 0 };
  private points: Points | null = null;
  private lines: Mesh | null = null;
  private readonly resUniform = { value: new Vector2(1, 1) };

  private model: PositionedMapModel | null = null;
  private rgb: Record<PaletteKey, Rgb> | null = null;
  private light = false;
  private signature = "";
  private ids: string[] = [];
  private index = new Map<string, number>();
  private nodes: MapNode[] = [];
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  private pz = new Float32Array(0);
  private edgeIdx: { a: number; b: number; kind: MapEdgeKind }[] = [];
  private center = new Vector3();

  private filter: ReadonlySet<string> | null = null;
  private selection: string | null = null;
  private hover: string | null = null;
  /** 노드별 강조 정도 0–1 — 고른 점·호버 점과 그 이웃. */
  private emph = new Float32Array(0);
  private focused = false;
  private visibleCount = 0;

  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private insets: MapFitInsets = DEFAULT_INSETS;
  private fitDist = 6;
  private zoom = 1;
  private yaw = 0;
  private pitch = 0;
  private tween: { t0: number; dur: number; yaw0: number; pitch0: number; zoom0: number } | null = null;
  private drag: { id: number; x: number; y: number; active: boolean } | null = null;

  private raf = 0;
  private dataDirty = true;
  private disposed = false;
  private readonly tmp = new Vector3();
  /** 보기 변화 구독 — 그릴 때마다 알린다(그리기는 요청 때만 돈다). */
  private readonly viewListeners = new Set<() => void>();

  private readonly onResize = () => this.resize();
  private readonly onContextLost = (event: Event) => { event.preventDefault(); };
  private readonly onContextRestored = () => { this.dataDirty = true; this.schedule(); };
  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.drag) return;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, active: false };
  };
  private readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      this.tween = null;
      try { this.canvas?.setPointerCapture(event.pointerId); } catch { /* 캡처 실패는 끌기에 영향 없다 */ }
      if (this.canvas) this.canvas.style.cursor = "grabbing";
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    this.yaw = clamp(this.yaw - dx * DRAG_RAD_PER_PX, -ANGLE_LIMIT, ANGLE_LIMIT);
    this.pitch = clamp(this.pitch + dy * DRAG_RAD_PER_PX, -ANGLE_LIMIT, ANGLE_LIMIT);
    this.schedule();
  };
  private readonly onPointerEnd = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    this.drag = null;
    if (drag.active && this.canvas) {
      this.canvas.style.cursor = "";
      try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* 이미 풀렸다 */ }
    }
  };
  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.tween = null;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    this.zoom = clamp(this.zoom * Math.exp(event.deltaY * unit * 0.0012), ZOOM_MIN, ZOOM_MAX);
    this.schedule();
  };

  mount(container: HTMLElement, model: PositionedMapModel, palette: MapPalette): void {
    if (this.container) throw new Error("map-webgl: already mounted");
    const canvas = document.createElement("canvas");
    // 컨텍스트는 여기서 한 번만 만든다 — 실패하면 throw해 상위가 Canvas 렌더러로 넘어간다.
    const gl = canvas.getContext("webgl2", {
      alpha: true, antialias: false, depth: false, stencil: false, powerPreference: "high-performance",
    });
    if (!gl) throw new Error("map-webgl: webgl2 unavailable");
    try {
      const renderer = new WebGLRenderer({ canvas, context: gl, alpha: true, antialias: false });
      this.renderer = renderer;
      this.canvas = canvas;
      this.container = container;
      this.pixelRatio = Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, MAX_PIXEL_RATIO);
      renderer.setPixelRatio(this.pixelRatio);
      renderer.setClearColor(0x000000, 0);

      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;";
      canvas.addEventListener("webglcontextlost", this.onContextLost);
      canvas.addEventListener("webglcontextrestored", this.onContextRestored);
      canvas.addEventListener("pointerdown", this.onPointerDown);
      canvas.addEventListener("pointermove", this.onPointerMove);
      canvas.addEventListener("pointerup", this.onPointerEnd);
      canvas.addEventListener("pointercancel", this.onPointerEnd);
      canvas.addEventListener("wheel", this.onWheel, { passive: false });
      container.append(canvas);

      this.buildMaterials(renderer);
      const composer = new EffectComposer(renderer);
      composer.setPixelRatio(this.pixelRatio);
      composer.addPass(new RenderPass(this.scene, this.camera));
      const bloom = new UnrealBloomPass(new Vector2(256, 256), 0.55, 0.5, 0.3);
      composer.addPass(bloom);
      composer.addPass(new ShaderPass(FINAL_SHADER));
      this.composer = composer;
      this.bloom = bloom;

      this.applyModel(model, palette, true);
      this.resize();
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(container);
      this.schedule();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  update(model: PositionedMapModel, palette: MapPalette): void {
    if (!this.renderer || this.disposed) return;
    this.applyModel(model, palette, false);
    this.schedule();
  }

  setSelection(id: string | null): void {
    if (this.selection === id) return;
    this.selection = id;
    this.updateEmphasis();
    this.dataDirty = true;
    this.schedule();
  }

  setHover(id: string | null): void {
    if (this.hover === id) return;
    this.hover = id;
    this.updateEmphasis();
    this.dataDirty = true;
    this.schedule();
  }

  setFilter(visible: ReadonlySet<string>): void {
    this.filter = visible;
    this.countVisible();
    this.dataDirty = true;
    this.schedule();
  }

  setFitInsets(insets: MapFitInsets): void {
    this.insets = insets;
    this.resize(true);
    this.schedule();
  }

  pick(x: number, y: number): string | null {
    if (!this.renderer || this.width === 0) return null;
    this.camera.updateMatrixWorld();
    let best: string | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < this.ids.length; i += 1) {
      const projected = this.screenOf(i);
      if (!projected) continue;
      const radius = this.visibleRadiusPx(i, projected.depth);
      const hit = Math.max(radius, MIN_HIT_PX);
      const distance = Math.hypot(projected.x - x, projected.y - y);
      if (distance > hit) continue;
      const score = distance - radius;
      if (score < bestScore) { bestScore = score; best = this.ids[i]!; }
    }
    return best;
  }

  project(id: string): { readonly x: number; readonly y: number; readonly visible: boolean } | null {
    const i = this.index.get(id);
    if (i === undefined || !this.renderer) return null;
    this.camera.updateMatrixWorld();
    const v = this.tmp.set(this.px[i]!, this.py[i]!, this.pz[i]!).applyMatrix4(this.camera.matrixWorldInverse);
    const depth = -v.z;
    v.applyMatrix4(this.camera.projectionMatrix);
    const x = (v.x + 1) / 2 * this.width;
    const y = (1 - v.y) / 2 * this.height;
    const inside = depth > this.camera.near && x >= 0 && x <= this.width && y >= 0 && y <= this.height;
    return { x, y, visible: inside && this.isVisible(id) };
  }

  fit(): void {
    if (!this.renderer) return;
    this.tween = { t0: performance.now(), dur: FIT_TWEEN_MS, yaw0: this.yaw, pitch0: this.pitch, zoom0: this.zoom };
    // 첫 그리기 전에도 project가 맞는 답을 내놓게 카메라를 곧바로 둔다.
    this.placeCamera();
    this.schedule();
  }

  onViewChange(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => { this.viewListeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.viewListeners.clear();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    const canvas = this.canvas;
    if (canvas) {
      canvas.removeEventListener("webglcontextlost", this.onContextLost);
      canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
      canvas.removeEventListener("pointerdown", this.onPointerDown);
      canvas.removeEventListener("pointermove", this.onPointerMove);
      canvas.removeEventListener("pointerup", this.onPointerEnd);
      canvas.removeEventListener("pointercancel", this.onPointerEnd);
      canvas.removeEventListener("wheel", this.onWheel);
    }
    this.drag = null;
    this.pointGeo.dispose();
    this.lineGeo.dispose();
    this.pointMat?.dispose();
    this.lineMat?.dispose();
    this.bloom?.dispose();
    this.composer?.dispose();
    const renderer = this.renderer;
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
    }
    canvas?.remove();
    this.renderer = null;
    this.composer = null;
    this.bloom = null;
    this.canvas = null;
    this.container = null;
    this.model = null;
    this.filter = null;
  }

  // ── 모델·팔레트 ───────────────────────────────────────────────────────

  private buildMaterials(renderer: WebGLRenderer): void {
    const maxPoint = (renderer.getContext().getParameter(renderer.getContext().ALIASED_POINT_SIZE_RANGE) as Float32Array)[1] ?? 64;
    this.pointMat = new ShaderMaterial({
      uniforms: {
        uScale: { value: 1 }, uFocus: { value: 6 }, uRange: { value: 2 }, uGain: { value: 1 },
        uMaxPx: { value: Math.min(MAX_SPRITE_CSS * this.pixelRatio, maxPoint) }, uLight: this.lightUniform,
      },
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.lineMat = new ShaderMaterial({
      uniforms: { uLight: this.lightUniform, uRes: this.resUniform },
      vertexShader: LINE_VERTEX,
      fragmentShader: LINE_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, side: DoubleSide,
    });
    this.applyBlending();
  }

  /** 어두운 테마는 스크린 혼합(가산처럼 빛나되 1에서 포화), 밝은 테마는 일반 혼합 + Bloom 없음. */
  private applyBlending(): void {
    for (const material of [this.pointMat, this.lineMat]) {
      if (!material) continue;
      if (this.light) {
        material.blending = NormalBlending;
      } else {
        material.blending = CustomBlending;
        material.blendEquation = AddEquation;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcColorFactor;
        material.blendSrcAlpha = OneFactor;
        material.blendDstAlpha = OneMinusSrcAlphaFactor;
      }
      material.needsUpdate = true;
    }
    this.lightUniform.value = this.light ? 1 : 0;
  }

  private applyModel(model: PositionedMapModel, palette: MapPalette, first: boolean): void {
    const previous = this.model;
    this.model = model;
    this.rgb = mapPaletteToRgb(palette);
    const light = relativeLuminance(this.rgb.ink) < 0.45;
    if (light !== this.light || first) {
      this.light = light;
      this.applyBlending();
    }
    if (!previous || previous.graph !== model.graph || previous.layout !== model.layout) this.rebuild(model);
    this.dataDirty = true;
  }

  private rebuild(model: PositionedMapModel): void {
    const { graph, layout } = model;
    const nodes = graph.nodes.filter((node) => layout.positions.has(node.id));
    this.nodes = nodes;
    this.ids = nodes.map((node) => node.id);
    this.index = new Map(this.ids.map((id, i) => [id, i] as const));
    const n = nodes.length;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    nodes.forEach((node, i) => {
      const p = layout.positions.get(node.id)!;
      this.px[i] = p.x;
      this.py[i] = -p.y; // 화면 y는 아래로 자란다.
      this.pz[i] = p.z;
    });
    this.edgeIdx = [];
    for (const edge of graph.edges) {
      const a = this.index.get(edge.from);
      const b = this.index.get(edge.to);
      if (a !== undefined && b !== undefined) this.edgeIdx.push({ a, b, kind: edge.kind });
    }
    const { minX, maxX, minY, maxY } = layout.bounds;
    this.center.set((minX + maxX) / 2, -(minY + maxY) / 2, 0);

    const dynamic = (array: Float32Array, size: number) => new BufferAttribute(array, size).setUsage(DynamicDrawUsage);
    const pointGeo = new BufferGeometry();
    const position = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) { position[i * 3] = this.px[i]!; position[i * 3 + 1] = this.py[i]!; position[i * 3 + 2] = this.pz[i]!; }
    pointGeo.setAttribute("position", new BufferAttribute(position, 3));
    pointGeo.setAttribute("aColor", dynamic(new Float32Array(n * 3), 3));
    pointGeo.setAttribute("aSize", dynamic(new Float32Array(n), 1));
    pointGeo.setAttribute("aAlpha", dynamic(new Float32Array(n), 1));
    // 연결선 — 선분마다 네 꼭짓점 리본(끝마다 좌·우). aOther는 반대쪽 끝, aSide=(좌우, 방향 부호).
    const lineGeo = new BufferGeometry();
    const m = this.edgeIdx.length;
    const linePos = new Float32Array(m * 12);
    const lineOther = new Float32Array(m * 12);
    const lineSide = new Float32Array(m * 8);
    const lineIndex = new Uint32Array(m * 6);
    this.edgeIdx.forEach(({ a, b }, e) => {
      const pa = [this.px[a]!, this.py[a]!, this.pz[a]!];
      const pb = [this.px[b]!, this.py[b]!, this.pz[b]!];
      linePos.set([...pa, ...pa, ...pb, ...pb], e * 12);
      lineOther.set([...pb, ...pb, ...pa, ...pa], e * 12);
      lineSide.set([-1, 1, 1, 1, -1, -1, 1, -1], e * 8);
      const v = e * 4;
      lineIndex.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], e * 6);
    });
    lineGeo.setAttribute("position", new BufferAttribute(linePos, 3));
    lineGeo.setAttribute("aOther", new BufferAttribute(lineOther, 3));
    lineGeo.setAttribute("aSide", new BufferAttribute(lineSide, 2));
    lineGeo.setIndex(new BufferAttribute(lineIndex, 1));
    lineGeo.setAttribute("aRgba", dynamic(new Float32Array(m * 16), 4));
    lineGeo.setAttribute("aWidth", dynamic(new Float32Array(m * 4), 1));

    if (this.points) this.scene.remove(this.points);
    if (this.lines) this.scene.remove(this.lines);
    this.pointGeo.dispose();
    this.lineGeo.dispose();
    this.pointGeo = pointGeo;
    this.lineGeo = lineGeo;
    this.lines = new Mesh(lineGeo, this.lineMat!);
    this.points = new Points(pointGeo, this.pointMat!);
    this.lines.frustumCulled = false;
    this.points.frustumCulled = false;
    this.lines.renderOrder = 0;
    this.points.renderOrder = 1;
    this.scene.add(this.lines, this.points);

    this.countVisible();
    this.updateEmphasis();
    // 노드 구성이 바뀌었을 때만 정면으로 되돌린다 — 테마 전환 등 같은 지도는 카메라를 지킨다.
    const signature = this.ids.join("\n");
    if (signature !== this.signature) {
      this.signature = signature;
      this.yaw = 0; this.pitch = 0; this.zoom = 1; this.tween = null;
    }
    this.computeFit();
  }

  /** 고른 점(1)·그 이웃(0.8), 호버한 점(0.65)·그 이웃(0.45) — 큰 쪽을 쓴다. */
  private updateEmphasis(): void {
    const n = this.nodes.length;
    if (this.emph.length !== n) this.emph = new Float32Array(n);
    this.emph.fill(0);
    const adjacent = this.model?.graph.adjacent;
    const mark = (id: string | null, self: number, near: number) => {
      if (id === null) return;
      const i = this.index.get(id);
      if (i === undefined) return;
      this.emph[i] = Math.max(this.emph[i]!, self);
      for (const other of adjacent?.get(id) ?? []) {
        const j = this.index.get(other);
        if (j !== undefined) this.emph[j] = Math.max(this.emph[j]!, near);
      }
    };
    mark(this.hover, 0.65, 0.45);
    mark(this.selection, 1, 0.8);
    this.focused = this.hover !== null && this.index.has(this.hover) || this.selection !== null && this.index.has(this.selection);
  }

  private isVisible(id: string): boolean {
    return this.filter === null || this.filter.has(id) || id === "core";
  }

  private countVisible(): void {
    this.visibleCount = this.filter === null ? this.ids.length : this.ids.reduce((sum, id) => sum + (this.isVisible(id) ? 1 : 0), 0);
  }

  // ── 크기·카메라 ───────────────────────────────────────────────────────

  private resize(force = false): void {
    const container = this.container;
    const renderer = this.renderer;
    if (!container || !renderer) return;
    const w = Math.max(1, Math.round(container.clientWidth));
    const h = Math.max(1, Math.round(container.clientHeight));
    if (!force && w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.resUniform.value.set(w, h);
    renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.computeFit();
    this.dataDirty = true;
    this.schedule();
  }

  /** 정면에서 점·발광 가장자리가 안쪽 여백 안에 들어오는 가장 가까운 거리와 화면 이동(view offset). */
  private computeFit(): void {
    const { width, height } = this;
    if (width === 0 || height === 0 || this.nodes.length === 0) return;
    // 좁은 용기에서 여백이 지도를 삼키지 않게 한 변당 20%까지만 쓴다.
    const capX = (value: number) => Math.min(value, width * 0.2);
    const capY = (value: number) => Math.min(value, height * 0.2);
    const insets = {
      top: capY(this.insets.top), bottom: capY(this.insets.bottom),
      left: capX(this.insets.left), right: capX(this.insets.right),
    };
    const availW = Math.max(40, width - insets.left - insets.right);
    const availH = Math.max(40, height - insets.top - insets.bottom);
    const f = (height / 2) / Math.tan((FOV_DEG * Math.PI) / 360);
    let dist = 1;
    for (let i = 0; i < this.nodes.length; i += 1) {
      const rim = (this.dotDiameter(i, false) * HALO * 0.5 * 0.6);
      const dx = Math.abs(this.px[i]! - this.center.x) + rim;
      const dy = Math.abs(this.py[i]! - this.center.y) + rim;
      dist = Math.max(dist, this.pz[i]! + (dx * f) / (availW / 2), this.pz[i]! + (dy * f) / (availH / 2));
    }
    this.fitDist = dist;
    const shiftX = (insets.left - insets.right) / 2;
    const shiftY = (insets.top - insets.bottom) / 2;
    if (Math.abs(shiftX) < 0.5 && Math.abs(shiftY) < 0.5) {
      this.camera.clearViewOffset();
    } else {
      this.camera.setViewOffset(width, height, -shiftX, -shiftY, width, height);
    }
    this.camera.updateProjectionMatrix();
  }

  private placeCamera(): void {
    const dist = this.fitDist * this.zoom;
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.center.x + dist * Math.sin(this.yaw) * cp,
      this.center.y + dist * Math.sin(this.pitch),
      dist * Math.cos(this.yaw) * cp,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.center);
    this.camera.updateMatrixWorld();
  }

  // ── 점 크기·고르기 ───────────────────────────────────────────────────

  private crowd(): number {
    return clamp((this.visibleCount - CROWD_FROM) / (CROWD_TO - CROWD_FROM), 0, 1);
  }

  /** 또렷한 점의 지름(세계 단위) — 고르기 반경과 셰이더 크기가 같은 값을 읽는다. */
  private dotDiameter(i: number, emphasize = true): number {
    const node = this.nodes[i]!;
    let scale = mapNodeSize(node.kind) * DOT_UNIT * lerp(1, 0.8, this.crowd());
    if (node.fresh) scale *= 1.15;
    if (emphasize) {
      if (node.id === this.hover || node.id === this.selection) scale *= 1.4;
      else scale *= 1 + (this.emph[i] ?? 0) * 0.25;
    }
    return scale;
  }

  private screenOf(i: number): { x: number; y: number; depth: number } | null {
    if (!this.isVisible(this.ids[i]!)) return null;
    const v = this.tmp.set(this.px[i]!, this.py[i]!, this.pz[i]!).applyMatrix4(this.camera.matrixWorldInverse);
    const depth = -v.z;
    if (depth <= this.camera.near) return null;
    v.applyMatrix4(this.camera.projectionMatrix);
    return { x: (v.x + 1) / 2 * this.width, y: (1 - v.y) / 2 * this.height, depth };
  }

  /** 보이는 점 반경(CSS px) — 스프라이트 크기 상한·초점 흐림까지 셰이더와 같은 식이다. */
  private visibleRadiusPx(i: number, depth: number): number {
    const f = (this.height / 2) / Math.tan((FOV_DEG * Math.PI) / 360);
    const dist = this.fitDist * this.zoom;
    const coc = clamp(Math.abs(depth - dist) / Math.max(0.2, dist * DOF_RANGE), 0, 1);
    const sprite = Math.min(this.dotDiameter(i) * HALO * f / depth * (1 + coc * DOF_GROW), MAX_SPRITE_CSS);
    return (sprite / 2) * lerp(0.36, 0.9, coc);
  }

  // ── 그리기 ─────────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.raf || this.disposed || !this.renderer) return;
    this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  private frame(now: number): void {
    this.raf = 0;
    const renderer = this.renderer;
    if (!renderer || this.disposed || !this.rgb) return;

    const tween = this.tween;
    if (tween) {
      const t = clamp((now - tween.t0) / tween.dur, 0, 1);
      const e = easeInOut(t);
      this.yaw = lerp(tween.yaw0, 0, e);
      this.pitch = lerp(tween.pitch0, 0, e);
      this.zoom = lerp(tween.zoom0, 1, e);
      if (t >= 1) this.tween = null;
    }

    if (this.dataDirty) { this.writeBuffers(); this.dataDirty = false; }
    this.placeCamera();
    this.writeUniforms();
    if (!this.light && this.composer) this.composer.render();
    else renderer.render(this.scene, this.camera);
    if (this.tween) this.schedule();
    for (const listener of this.viewListeners) {
      try { listener(); } catch { /* DOM 동기 실패는 다음 그림으로 미룬다 */ }
    }
  }

  private writeUniforms(): void {
    const material = this.pointMat;
    if (!material) return;
    const dist = this.fitDist * this.zoom;
    const f = (this.height / 2) / Math.tan((FOV_DEG * Math.PI) / 360);
    material.uniforms.uFocus!.value = dist;
    material.uniforms.uRange!.value = Math.max(0.2, dist * DOF_RANGE);
    material.uniforms.uScale!.value = f * this.pixelRatio;
    const crowd = this.crowd();
    material.uniforms.uGain!.value = this.light ? 0.9 : lerp(1, 0.8, crowd);
    const bloom = this.bloom;
    if (bloom) {
      // 빽빽할수록 번짐을 줄이고 밝은 부분만 번지게 한다 — 겹친 발광이 중앙에서 하얗게 뭉치지 않도록.
      bloom.strength = lerp(0.55, 0.2, crowd);
      bloom.threshold = lerp(0.3, 0.6, crowd);
      bloom.radius = lerp(0.5, 0.35, crowd);
    }
  }

  private nodeRgb(i: number): Rgb {
    const rgb = this.rgb!;
    const node = this.nodes[i]!;
    const base = rgb[paletteKeyOf(node)];
    if (node.fresh) return mix(base, rgb.fresh, 0.4);
    if (node.stale) return mix(base, rgb.stale, 0.35);
    return base;
  }

  private writeBuffers(): void {
    const rgb = this.rgb;
    if (!rgb) return;
    const crowd = this.crowd();
    const alphaScale = lerp(1, 0.7, crowd);
    const focused = this.focused;
    const ink = rgb.ink;

    const color = this.pointGeo.getAttribute("aColor") as BufferAttribute;
    const size = this.pointGeo.getAttribute("aSize") as BufferAttribute;
    const alpha = this.pointGeo.getAttribute("aAlpha") as BufferAttribute;
    const colors: Rgb[] = [];
    const shown: boolean[] = [];
    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i]!;
      const visible = this.isVisible(node.id);
      shown.push(visible);
      const level = this.emph[i] ?? 0;
      const base = this.nodeRgb(i);
      colors.push(base);
      // 강조된 점은 잉크 쪽으로 살짝 밝힌다 — 연결선 색과 함께 방사형으로 읽힌다.
      const c = level > 0 ? mix(base, ink, level * 0.3) : base;
      color.setXYZ(i, c[0] / 255, c[1] / 255, c[2] / 255);
      size.setX(i, visible ? this.dotDiameter(i) : 0);
      let a = (node.kind === "core" ? 1 : 0.9) * alphaScale;
      if (node.stale) a *= 0.6;
      if (node.kind === "topic") a *= 0.7;
      // 강조가 있으면 이웃이 아닌 점은 물러난다. 이웃은 밀도 보정 없이 또렷하게 둔다.
      if (focused) a = level > 0 ? Math.max(a, 0.9 * Math.min(1, level * 1.25)) : a * 0.16;
      alpha.setX(i, visible ? a : 0);
    }
    color.needsUpdate = true;
    size.needsUpdate = true;
    alpha.needsUpdate = true;

    const edgeColor = this.lineGeo.getAttribute("aRgba") as BufferAttribute;
    const edgeWidth = this.lineGeo.getAttribute("aWidth") as BufferAttribute;
    const inkDim = rgb.inkDim;
    const selected = this.selection !== null ? this.index.get(this.selection) : undefined;
    const hovered = this.hover !== null ? this.index.get(this.hover) : undefined;
    this.edgeIdx.forEach(({ a, b, kind }, e) => {
      const live = shown[a]! && shown[b]!;
      let alphaEdge = live ? EDGE_ALPHA[kind] * lerp(1, 0.6, crowd) : 0;
      // 고른 점에 닿은 선은 1, 호버한 점에 닿은 선은 0.6 — 나머지는 가라앉는다.
      let level = 0;
      if (live) {
        if (selected !== undefined && (a === selected || b === selected)) level = 1;
        else if (hovered !== undefined && (a === hovered || b === hovered)) level = 0.6;
        if (level > 0) alphaEdge = lerp(alphaEdge, 0.95, level);
        else if (focused) alphaEdge *= 0.08;
      }
      const ca = level > 0 ? mix(colors[a]!, ink, level * 0.35) : kind === "source" ? inkDim : kind === "link" ? ink : colors[a]!;
      const cb = level > 0 ? mix(colors[b]!, ink, level * 0.35) : kind === "source" ? inkDim : kind === "link" ? ink : colors[b]!;
      const width = EDGE_WIDTH + level * 1.9;
      for (let k = 0; k < 4; k += 1) {
        const c = k < 2 ? ca : cb;
        edgeColor.setXYZW(e * 4 + k, c[0] / 255, c[1] / 255, c[2] / 255, alphaEdge);
        edgeWidth.setX(e * 4 + k, width);
      }
    });
    edgeColor.needsUpdate = true;
    edgeWidth.needsUpdate = true;
  }
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function createMapRenderer(): MapWebglRenderer {
  return new MapWebglRendererImpl();
}
