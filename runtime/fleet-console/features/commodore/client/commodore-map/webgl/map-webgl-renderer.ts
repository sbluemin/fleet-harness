import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  LineSegments,
  NormalBlending,
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
import type { MapNode } from "../map-graph.js";
import { mapPaletteToRgb, type MapPalette } from "../map-palette.js";
import type { MapRenderer, PositionedMapModel } from "../map-renderers.js";

/**
 * three.js 렌더러(안 D) — 이 파일과 three는 지도를 열 때만 받는 지연 청크다.
 * 겉모습은 시안 안 D(`makeD`)의 값을 그대로 따른다: 점마다 고정 z, 초점=카메라 거리의 빛망울(bokeh),
 * 점 셰이더 1개·1px 선 1개(가산 혼합)·UnrealBloom(0.55, 0.35, 0.3)·sRGB 출력.
 * 좌표는 시안 단위(배치 반지름 ≈ 380)로 옮겨 시안의 반경·z 폭·초점 범위 상수를 그대로 쓴다.
 * 카메라는 정면이 기본이고 자동 회전은 없다(결정 ff40284e) — 끌 때만 돌고, 손을 떼면 그 각도로 머문다.
 * WebGL2 컨텍스트 1개. CSP 때문에 blob 워커·WASM·eval은 쓰지 않는다.
 */

/** 맞춤 보기 여백(CSS px) — 라벨·패널이 덮는 폭. */
export interface MapFitInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface MapWebglRenderer extends MapRenderer {
  /** 맞춤 보기 여백 갈아끼우기. 기본값은 아래 `DEFAULT_INSETS`. */
  setFitInsets(insets: MapFitInsets): void;
}

const DEFAULT_INSETS: MapFitInsets = { top: 36, right: 36, bottom: 36, left: 36 };

/** 배치(반지름 ≈1.8) → 시안 단위(반지름 ≈380). */
const WORLD_SCALE = 200;
const FOV_DEG = 42;
const FIT_MARGIN = 1.04;
/** 시안 `uScale` 계수와 스프라이트 상한(CSS px 기준 110, 장치 px로는 ×dpr). */
const SPRITE_K = 4.6;
const MAX_SPRITE_CSS = 110;
const COC_GROW = 1.3;
const FOCUS_RANGE_MIN = 120;
const FOCUS_RANGE_RATIO = 0.24;
const MIN_HIT_PX = 4;
const MAX_PIXEL_RATIO = 1.5;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 2.5;
/** 끌기 감도(rad/px)와 회전 범위 — 정면에서 크게 돌리면 점이 겹쳐 하얗게 뭉친다. */
const DRAG_RAD_PER_PX = 0.0016;
const ANGLE_LIMIT = (35 * Math.PI) / 180;
const DRAG_THRESHOLD_PX = 3;
const FIT_TWEEN_MS = 450;
/** 핵 맥동은 느려 30fps로 충분하다 — 움직임이 없을 때 그리는 간격. */
const PULSE_FRAME_MS = 33;
/** 밀도 보정이 서는 구간 — 시안 값은 21개 쪽, 200개에서만 살짝 낮춘다. */
const CROWD_FROM = 40;
const CROWD_TO = 200;

const POINT_VERTEX = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aShape;
uniform float uScale;
uniform float uFocus;
uniform float uRange;
uniform float uMaxPx;
varying vec3 vColor;
varying float vAlpha;
varying float vCoc;
varying float vShape;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 1.0);
  float coc = clamp(abs(depth - uFocus) / uRange, 0.0, 1.0);
  vCoc = coc;
  vShape = aShape;
  vColor = aColor;
  vAlpha = aAlpha * (1.0 - coc * 0.55) / (1.0 + coc * 2.2);
  gl_PointSize = min(aSize * uScale / depth * (1.0 + coc * ${COC_GROW.toFixed(1)}), uMaxPx);
  gl_Position = projectionMatrix * mv;
}`;

const POINT_FRAGMENT = /* glsl */ `
uniform float uGain;
varying vec3 vColor;
varying float vAlpha;
varying float vCoc;
varying float vShape;
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0);
  if (d > 1.0) discard;
  float disc = smoothstep(0.42, 0.3, d);
  // 묶음 노드(vShape=1)는 속이 빈 고리 + 작은 중심점 — 일반 정보 점과 한눈에 갈린다.
  float ring = smoothstep(0.42, 0.37, d) * smoothstep(0.2, 0.27, d) + smoothstep(0.09, 0.05, d) * 0.7;
  float sharp = mix(disc, ring, vShape) + exp(-d * d * 7.0) * 0.45 * smoothstep(1.0, 0.6, d) * mix(1.0, 0.45, vShape);
  float bokeh = smoothstep(1.0, 0.84, d) * (0.42 + 0.58 * smoothstep(0.5, 0.95, d));
  gl_FragColor = vec4(vColor * uGain, mix(sharp, bokeh, vCoc) * vAlpha);
}`;

const LINE_VERTEX = /* glsl */ `
attribute vec4 aRgba;
varying vec4 vC;
void main() {
  vC = aRgba;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const LINE_FRAGMENT = /* glsl */ `
varying vec4 vC;
void main() { gl_FragColor = vC; }`;

/**
 * 마지막 패스 — 시안의 OutputPass(선형→sRGB)와 같은 변환을 하고, 투명 캔버스 위 합성을 위해
 * 알파를 밝기(최대 채널)로 둔다(곱셈 알파). 어두운 발광 꼬리가 8비트에서 동심원 띠로 끊기지 않게
 * 화면 위치 기반 삼각 분포 잡음(±1/255)을 더한다.
 */
const FINAL_SHADER = {
  uniforms: { tDiffuse: { value: null as unknown } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
    vec3 encode(vec3 c) {
      c = clamp(c, 0.0, 1.0);
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }
    void main() {
      vec3 c = max(texture2D(tDiffuse, vUv).rgb, vec3(0.0));
      float m = max(c.r, max(c.g, c.b));
      if (m <= 0.0) { gl_FragColor = vec4(0.0); return; }
      vec3 e = encode(c);
      float a = max(e.r, max(e.g, e.b));
      float noise = (ign(gl_FragCoord.xy) + ign(gl_FragCoord.xy + vec2(5.588238, 5.588238)) - 1.0) / 255.0;
      gl_FragColor = vec4(max(e + noise, vec3(0.0)), max(a + noise, 0.0));
    }`,
};

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

type Rgb = readonly [number, number, number];
type PaletteRgb = ReturnType<typeof mapPaletteToRgb>;

/** 시안 `zOf` — 노드 id 해시로 정해지는 고정 깊이. 정면에서는 구조가 읽히고 빛망울로 깊이가 보인다. */
const Z_SPAN: Partial<Record<MapNode["kind"], number>> = {
  core: 0, "intel-hub": 50, branch: 50, description: 40, topic: 110,
  memory: 300, intel: 180, "intel-overflow": 180, objective: 420,
};
function depthOf(node: MapNode): number {
  let h = 2166136261;
  for (let i = 0; i < node.id.length; i += 1) h = Math.imul(h ^ node.id.charCodeAt(i), 16777619);
  const u = ((h >>> 0) % 10007) / 10007 - 0.5;
  return u * (Z_SPAN[node.kind] ?? 140);
}

/** 시안 `radius` — 연결이 많을수록 큰 점. */
function radiusOf(node: MapNode, degree: number): number {
  switch (node.kind) {
    case "core": return 22;
    case "branch": case "intel-hub": case "description": return 10;
    case "topic": return 4.5;
    case "objective": case "source": return 5 + Math.min(5, degree * 0.6);
    case "intel": return 4.5;
    case "intel-overflow": return 4.5 * 1.9;
    case "memory": return 3.6 + Math.min(5, (degree - 1) * 0.9);
  }
}

/** 팔레트 키 — 신호 토큰(fresh·stale)은 범주색에 쓰지 않는다. */
function paletteKeyOf(node: MapNode): keyof MapPalette {
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
  private readonly camera = new PerspectiveCamera(FOV_DEG, 1, 1, 20000);
  private pointGeo = new BufferGeometry();
  private lineGeo = new BufferGeometry();
  private pointMat: ShaderMaterial | null = null;
  private lineMat: ShaderMaterial | null = null;
  private points: Points | null = null;
  private lines: LineSegments | null = null;

  private model: PositionedMapModel | null = null;
  private rgb: PaletteRgb | null = null;
  private light = false;
  private signature = "";
  private ids: string[] = [];
  private index = new Map<string, number>();
  private nodes: MapNode[] = [];
  private wx = new Float32Array(0);
  private wy = new Float32Array(0);
  private wz = new Float32Array(0);
  private radius = new Float32Array(0);
  /** 그려지는 크기(시안 단위 반경 × 호버·선택 배율) — 셰이더와 고르기가 같은 값을 읽는다. */
  private size = new Float32Array(0);
  private degree = new Int32Array(0);
  private edgeIdx: { a: number; b: number; base: number; kind: "tree" | "link" | "objective" | "source" }[] = [];
  private coreIndex = -1;
  private center = new Vector3();
  private extent = 400;

  private filter: ReadonlySet<string> | null = null;
  private selection: string | null = null;
  private hover: string | null = null;
  /** 호버·선택한 점과 그 이웃 — 시안 `focusSet`. */
  private focus: Uint8Array | null = null;
  private focusId: string | null = null;

  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private insets: MapFitInsets = DEFAULT_INSETS;
  private fitDist = 1200;
  private zoom = 1;
  private yaw = 0;
  private pitch = 0;
  private panX = 0;
  private panY = 0;
  private tween: { t0: number; dur: number; yaw0: number; pitch0: number; zoom0: number; panX0: number; panY0: number } | null = null;
  private drag: { id: number; x: number; y: number; active: boolean; pan: boolean } | null = null;

  private raf = 0;
  private dataDirty = true;
  private viewDirty = true;
  private lastDraw = 0;
  private pulse = true;
  private disposed = false;
  private readonly tmp = new Vector3();
  private readonly viewListeners = new Set<() => void>();
  private lastView = "";

  private readonly onResize = () => this.resize();
  private readonly onContextLost = (event: Event) => { event.preventDefault(); };
  private readonly onContextRestored = () => { this.dataDirty = true; this.viewDirty = true; this.schedule(); };
  private readonly onContextMenu = (event: Event) => { event.preventDefault(); };
  private readonly onVisibility = () => {
    if (document.hidden) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else {
      this.viewDirty = true;
      this.schedule();
    }
  };
  private readonly onPointerDown = (event: PointerEvent) => {
    if ((event.button !== 0 && event.button !== 2) || this.drag) return;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, active: false, pan: event.button === 2 || event.shiftKey };
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
    if (drag.pan) {
      // 끈 만큼 내용이 따라오게 — 초점 거리에서 1px이 가리키는 세계 길이.
      const perPx = (this.fitDist * this.zoom) / this.focalPx();
      const limit = this.extent;
      this.panX = clamp(this.panX - dx * perPx, -limit, limit);
      this.panY = clamp(this.panY + dy * perPx, -limit, limit);
    } else {
      this.yaw = clamp(this.yaw - dx * DRAG_RAD_PER_PX, -ANGLE_LIMIT, ANGLE_LIMIT);
      this.pitch = clamp(this.pitch + dy * DRAG_RAD_PER_PX, -ANGLE_LIMIT, ANGLE_LIMIT);
    }
    this.viewDirty = true;
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
    this.viewDirty = true;
    this.schedule();
  };

  mount(container: HTMLElement, model: PositionedMapModel, palette: MapPalette): void {
    if (this.container) throw new Error("map-webgl: already mounted");
    const canvas = document.createElement("canvas");
    // 컨텍스트는 여기서 한 번만 만든다 — 실패하면 throw해 상위가 Canvas 렌더러로 넘어간다.
    const gl = canvas.getContext("webgl2", {
      alpha: true, antialias: true, depth: false, stencil: false, powerPreference: "high-performance",
    });
    if (!gl) throw new Error("map-webgl: webgl2 unavailable");
    try {
      const renderer = new WebGLRenderer({ canvas, context: gl, alpha: true, antialias: true });
      this.renderer = renderer;
      this.canvas = canvas;
      this.container = container;
      this.pixelRatio = Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, MAX_PIXEL_RATIO);
      this.pulse = !(typeof window !== "undefined" && typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      renderer.setPixelRatio(this.pixelRatio);
      renderer.setClearColor(0x000000, 0);

      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;";
      canvas.addEventListener("webglcontextlost", this.onContextLost);
      canvas.addEventListener("webglcontextrestored", this.onContextRestored);
      canvas.addEventListener("contextmenu", this.onContextMenu);
      canvas.addEventListener("pointerdown", this.onPointerDown);
      canvas.addEventListener("pointermove", this.onPointerMove);
      canvas.addEventListener("pointerup", this.onPointerEnd);
      canvas.addEventListener("pointercancel", this.onPointerEnd);
      canvas.addEventListener("wheel", this.onWheel, { passive: false });
      document.addEventListener("visibilitychange", this.onVisibility);
      container.append(canvas);

      this.buildMaterials(renderer);
      const composer = new EffectComposer(renderer);
      composer.setPixelRatio(this.pixelRatio);
      composer.addPass(new RenderPass(this.scene, this.camera));
      const bloom = new UnrealBloomPass(new Vector2(256, 256), 0.55, 0.35, 0.3);
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
    this.updateFocus();
    this.dataDirty = true;
    this.schedule();
  }

  setHover(id: string | null): void {
    if (this.hover === id) return;
    this.hover = id;
    this.updateFocus();
    this.dataDirty = true;
    this.schedule();
  }

  setFilter(visible: ReadonlySet<string>): void {
    this.filter = visible;
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
      // 가장 가까운 중심 — 큰 빛망울이 그 안의 작은 점을 가리지 않게 한다. 같으면 작은 쪽.
      const score = distance + radius * 0.001;
      if (score < bestScore) { bestScore = score; best = this.ids[i]!; }
    }
    return best;
  }

  project(id: string): { readonly x: number; readonly y: number; readonly visible: boolean } | null {
    const i = this.index.get(id);
    if (i === undefined || !this.renderer) return null;
    this.camera.updateMatrixWorld();
    const v = this.tmp.set(this.wx[i]!, this.wy[i]!, this.wz[i]!).applyMatrix4(this.camera.matrixWorldInverse);
    const depth = -v.z;
    v.applyMatrix4(this.camera.projectionMatrix);
    const x = (v.x + 1) / 2 * this.width;
    const y = (1 - v.y) / 2 * this.height;
    const inside = depth > this.camera.near && x >= 0 && x <= this.width && y >= 0 && y <= this.height;
    return { x, y, visible: inside && this.isVisible(id) };
  }

  fit(): void {
    if (!this.renderer) return;
    this.tween = {
      t0: performance.now(), dur: FIT_TWEEN_MS,
      yaw0: this.yaw, pitch0: this.pitch, zoom0: this.zoom, panX0: this.panX, panY0: this.panY,
    };
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
    document.removeEventListener("visibilitychange", this.onVisibility);
    const canvas = this.canvas;
    if (canvas) {
      canvas.removeEventListener("webglcontextlost", this.onContextLost);
      canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
      canvas.removeEventListener("contextmenu", this.onContextMenu);
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
        uScale: { value: 1 }, uFocus: { value: 1200 }, uRange: { value: 260 }, uGain: { value: 0.95 },
        uMaxPx: { value: Math.min(MAX_SPRITE_CSS * this.pixelRatio, maxPoint) },
      },
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, blending: AdditiveBlending,
    });
    this.lineMat = new ShaderMaterial({
      vertexShader: LINE_VERTEX,
      fragmentShader: LINE_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, blending: AdditiveBlending,
    });
  }

  /** 어두운 테마는 가산 혼합 + Bloom, 밝은 테마는 일반 혼합 · Bloom 없음(시안과 같다). */
  private applyBlending(): void {
    const blending = this.light ? NormalBlending : AdditiveBlending;
    for (const material of [this.pointMat, this.lineMat]) {
      if (!material) continue;
      material.blending = blending;
      material.needsUpdate = true;
    }
    if (this.pointMat) this.pointMat.uniforms.uGain!.value = this.light ? 0.92 : 0.95;
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
    this.wx = new Float32Array(n);
    this.wy = new Float32Array(n);
    this.wz = new Float32Array(n);
    this.radius = new Float32Array(n);
    this.size = new Float32Array(n);
    this.degree = new Int32Array(n);
    this.coreIndex = nodes.findIndex((node) => node.kind === "core");
    nodes.forEach((node, i) => {
      const p = layout.positions.get(node.id)!;
      this.wx[i] = p.x * WORLD_SCALE;
      this.wy[i] = -p.y * WORLD_SCALE; // 화면 y는 아래로 자란다.
      this.wz[i] = depthOf(node);
    });
    this.edgeIdx = [];
    for (const edge of graph.edges) {
      const a = this.index.get(edge.from);
      const b = this.index.get(edge.to);
      if (a === undefined || b === undefined) continue;
      this.degree[a]! += 1;
      this.degree[b]! += 1;
      // 시안 선 알파: trunk .55 · branch .4 · twig/intel .26 · link .6 · 목표·출처 .11
      let base = 0.26;
      if (edge.kind === "link") base = 0.6;
      else if (edge.kind === "objective" || edge.kind === "source") base = 0.11;
      else if (nodes[a]!.kind === "core") base = 0.55;
      else if (nodes[b]!.kind === "topic") base = 0.4;
      this.edgeIdx.push({ a, b, base, kind: edge.kind });
    }
    nodes.forEach((node, i) => { this.radius[i] = radiusOf(node, this.degree[i]!); });
    const { minX, maxX, minY, maxY } = layout.bounds;
    this.center.set(((minX + maxX) / 2) * WORLD_SCALE, -((minY + maxY) / 2) * WORLD_SCALE, 0);

    const dynamic = (array: Float32Array, size: number) => new BufferAttribute(array, size).setUsage(DynamicDrawUsage);
    const pointGeo = new BufferGeometry();
    const position = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) { position[i * 3] = this.wx[i]!; position[i * 3 + 1] = this.wy[i]!; position[i * 3 + 2] = this.wz[i]!; }
    pointGeo.setAttribute("position", new BufferAttribute(position, 3));
    pointGeo.setAttribute("aColor", dynamic(new Float32Array(n * 3), 3));
    pointGeo.setAttribute("aSize", dynamic(new Float32Array(n), 1));
    pointGeo.setAttribute("aAlpha", dynamic(new Float32Array(n), 1));
    const shape = new Float32Array(n);
    nodes.forEach((node, i) => { shape[i] = node.kind === "intel-overflow" ? 1 : 0; });
    pointGeo.setAttribute("aShape", new BufferAttribute(shape, 1));
    const lineGeo = new BufferGeometry();
    const m = this.edgeIdx.length;
    const linePos = new Float32Array(m * 6);
    this.edgeIdx.forEach(({ a, b }, e) => {
      linePos.set([this.wx[a]!, this.wy[a]!, this.wz[a]!, this.wx[b]!, this.wy[b]!, this.wz[b]!], e * 6);
    });
    lineGeo.setAttribute("position", new BufferAttribute(linePos, 3));
    lineGeo.setAttribute("aRgba", dynamic(new Float32Array(m * 8), 4));

    if (this.points) this.scene.remove(this.points);
    if (this.lines) this.scene.remove(this.lines);
    this.pointGeo.dispose();
    this.lineGeo.dispose();
    this.pointGeo = pointGeo;
    this.lineGeo = lineGeo;
    this.lines = new LineSegments(lineGeo, this.lineMat!);
    this.points = new Points(pointGeo, this.pointMat!);
    this.lines.frustumCulled = false;
    this.points.frustumCulled = false;
    this.lines.renderOrder = 0;
    this.points.renderOrder = 1;
    this.scene.add(this.lines, this.points);

    this.updateFocus();
    // 노드 구성이 바뀌었을 때만 정면으로 되돌린다 — 테마 전환 등 같은 지도는 카메라를 지킨다.
    const signature = this.ids.join("\n");
    if (signature !== this.signature) {
      this.signature = signature;
      this.yaw = 0; this.pitch = 0; this.zoom = 1; this.panX = 0; this.panY = 0; this.tween = null;
    }
    this.computeFit();
  }

  /** 시안 `computeFocus` — 호버(없으면 선택)한 점과 이웃. */
  private updateFocus(): void {
    const id = this.hover ?? this.selection;
    const i = id !== null ? this.index.get(id) : undefined;
    if (i === undefined || id === null) { this.focus = null; this.focusId = null; return; }
    this.focusId = id;
    const flags = new Uint8Array(this.nodes.length);
    flags[i] = 1;
    for (const other of this.model?.graph.adjacent.get(id) ?? []) {
      const j = this.index.get(other);
      if (j !== undefined) flags[j] = 1;
    }
    this.focus = flags;
  }

  private isVisible(id: string): boolean {
    return this.filter === null || this.filter.has(id) || id === "core";
  }

  // ── 크기·카메라 ───────────────────────────────────────────────────────

  private focalPx(): number {
    return (this.height / 2) / Math.tan((FOV_DEG * Math.PI) / 360);
  }

  private resize(force = false): void {
    const container = this.container;
    const renderer = this.renderer;
    if (!container || !renderer) return;
    const w = Math.max(1, Math.round(container.clientWidth));
    const h = Math.max(1, Math.round(container.clientHeight));
    if (!force && w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.computeFit();
    this.dataDirty = true;
    this.viewDirty = true;
    this.schedule();
  }

  /**
   * 맞춤 보기 — 정면에서 보이는 점 반경 최대의 1.04배가 여백 안쪽을 채우는 가장 가까운 거리.
   * 여백이 비대칭이면 view offset으로 중심을 옮긴다.
   */
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
    const f = this.focalPx();
    let dist = 1;
    let extent = 1;
    for (let i = 0; i < this.nodes.length; i += 1) {
      const rim = this.radius[i]!;
      const dx = (Math.abs(this.wx[i]! - this.center.x) + rim) * FIT_MARGIN;
      const dy = (Math.abs(this.wy[i]! - this.center.y) + rim) * FIT_MARGIN;
      extent = Math.max(extent, dx, dy);
      dist = Math.max(dist, this.wz[i]! + (dx * f) / (availW / 2), this.wz[i]! + (dy * f) / (availH / 2));
    }
    this.fitDist = dist;
    this.extent = extent;
    const shiftX = (insets.left - insets.right) / 2;
    const shiftY = (insets.top - insets.bottom) / 2;
    if (Math.abs(shiftX) < 0.5 && Math.abs(shiftY) < 0.5) {
      this.camera.clearViewOffset();
    } else {
      this.camera.setViewOffset(width, height, -shiftX, -shiftY, width, height);
    }
    this.camera.updateProjectionMatrix();
    this.placeCamera();
  }

  private placeCamera(): void {
    const dist = this.fitDist * this.zoom;
    const cp = Math.cos(this.pitch);
    const tx = this.center.x + this.panX;
    const ty = this.center.y + this.panY;
    this.camera.position.set(
      tx + dist * Math.sin(this.yaw) * cp,
      ty + dist * Math.sin(this.pitch),
      dist * Math.cos(this.yaw) * cp,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(tx, ty, 0);
    this.camera.updateMatrixWorld();
  }

  // ── 점 크기·고르기 ───────────────────────────────────────────────────

  private screenOf(i: number): { x: number; y: number; depth: number } | null {
    if (!this.isVisible(this.ids[i]!)) return null;
    const v = this.tmp.set(this.wx[i]!, this.wy[i]!, this.wz[i]!).applyMatrix4(this.camera.matrixWorldInverse);
    const depth = -v.z;
    if (depth <= this.camera.near) return null;
    v.applyMatrix4(this.camera.projectionMatrix);
    return { x: (v.x + 1) / 2 * this.width, y: (1 - v.y) / 2 * this.height, depth };
  }

  private focusRange(): number {
    return Math.max(FOCUS_RANGE_MIN, this.fitDist * this.zoom * FOCUS_RANGE_RATIO);
  }

  /** 보이는 점 반경(CSS px) — 스프라이트 상한·초점 흐림까지 셰이더와 같은 식이다. */
  private visibleRadiusPx(i: number, depth: number): number {
    const coc = clamp(Math.abs(depth - this.fitDist * this.zoom) / this.focusRange(), 0, 1);
    const sprite = Math.min(this.size[i]! * SPRITE_K * this.focalPx() / depth * (1 + coc * COC_GROW), MAX_SPRITE_CSS);
    return (sprite / 2) * lerp(0.36, 0.9, coc);
  }

  /** 시안 반경 × (주제 0.8) × (호버·선택 1.4) — 핵 맥동은 그릴 때 따로 곱한다. */
  private baseSize(i: number): number {
    const node = this.nodes[i]!;
    let s = this.radius[i]! * (node.kind === "topic" ? 0.8 : 1);
    if (node.id === this.hover || node.id === this.selection) s *= 1.4;
    return s;
  }

  // ── 그리기 ─────────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.raf || this.disposed || !this.renderer || (typeof document !== "undefined" && document.hidden)) return;
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
      this.panX = lerp(tween.panX0, 0, e);
      this.panY = lerp(tween.panY0, 0, e);
      if (t >= 1) this.tween = null;
      this.viewDirty = true;
    }

    // 맥동만 있을 때는 30fps로 줄인다 — 끌기·트윈·데이터 변화는 즉시 그린다.
    const changed = this.dataDirty || this.viewDirty;
    if (changed || (this.pulse && now - this.lastDraw >= PULSE_FRAME_MS)) {
      this.lastDraw = now;
      if (this.dataDirty) { this.writeBuffers(); this.dataDirty = false; }
      this.writePulse(now);
      this.viewDirty = false;
      this.placeCamera();
      this.writeUniforms();
      if (!this.light && this.composer) this.composer.render();
      else renderer.render(this.scene, this.camera);
      this.notifyView();
    }
    if (this.pulse || this.tween) this.schedule();
  }

  /** 카메라·크기가 바뀐 그림에서만 DOM 층에 알린다(맥동 그림에서는 알리지 않는다). */
  private notifyView(): void {
    const signature = [this.yaw, this.pitch, this.zoom, this.panX, this.panY, this.width, this.height, this.fitDist]
      .map((v) => v.toFixed(4)).join(",");
    if (signature === this.lastView) return;
    this.lastView = signature;
    for (const listener of this.viewListeners) {
      try { listener(); } catch { /* DOM 동기 실패는 다음 그림으로 미룬다 */ }
    }
  }

  private writeUniforms(): void {
    const material = this.pointMat;
    if (!material) return;
    const crowd = clamp((this.nodes.length - CROWD_FROM) / (CROWD_TO - CROWD_FROM), 0, 1);
    material.uniforms.uFocus!.value = this.fitDist * this.zoom;
    material.uniforms.uRange!.value = this.focusRange();
    material.uniforms.uScale!.value = SPRITE_K * this.focalPx() * this.pixelRatio;
    const bloom = this.bloom;
    if (bloom) {
      // 시안 값(0.55, 0.35, 0.3) — 노드가 많을 때만 겹친 발광이 하얗게 뭉치지 않게 조금 낮춘다.
      bloom.strength = lerp(0.55, 0.4, crowd);
      bloom.threshold = lerp(0.3, 0.45, crowd);
    }
  }

  /** 핵 맥동 — 시안 `somaPulse`: 1 + 0.35 · (0.25 + 0.25 sin(t/900)). */
  private writePulse(now: number): void {
    const size = this.pointGeo.getAttribute("aSize") as BufferAttribute | undefined;
    if (!size || this.coreIndex < 0) return;
    const pulse = this.pulse ? 0.25 + 0.25 * Math.sin(now / 900) : 0;
    size.setX(this.coreIndex, this.isVisible("core") ? this.size[this.coreIndex]! * (1 + pulse * 0.35) : 0);
    size.needsUpdate = true;
  }

  private nodeRgb(i: number): Rgb {
    const rgb = this.rgb!;
    return rgb[paletteKeyOf(this.nodes[i]!)];
  }

  private writeBuffers(): void {
    const rgb = this.rgb;
    if (!rgb) return;
    const crowd = clamp((this.nodes.length - CROWD_FROM) / (CROWD_TO - CROWD_FROM), 0, 1);
    const alphaScale = lerp(1, 0.8, crowd);
    const focus = this.focus;
    const linkRgb = rgb.link;
    const objectiveRgb = rgb.objective;

    const color = this.pointGeo.getAttribute("aColor") as BufferAttribute;
    const size = this.pointGeo.getAttribute("aSize") as BufferAttribute;
    const alpha = this.pointGeo.getAttribute("aAlpha") as BufferAttribute;
    const colors: Rgb[] = [];
    const shown: boolean[] = [];
    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i]!;
      const visible = this.isVisible(node.id);
      shown.push(visible);
      const c = this.nodeRgb(i);
      colors.push(c);
      color.setXYZ(i, c[0] / 255, c[1] / 255, c[2] / 255);
      this.size[i] = this.baseSize(i);
      size.setX(i, visible ? this.size[i]! : 0);
      // 시안: 알파 0.9 · 주제 ×0.6 · 다시 확인할 때 ×0.5 · 초점 밖 ×0.13
      let a = 0.9 * alphaScale;
      if (node.kind === "topic") a *= 0.6;
      if (node.stale) a *= 0.5;
      if (focus && focus[i] !== 1) a *= 0.13;
      alpha.setX(i, visible ? a : 0);
    }
    color.needsUpdate = true;
    size.needsUpdate = true;
    alpha.needsUpdate = true;

    const edgeColor = this.lineGeo.getAttribute("aRgba") as BufferAttribute;
    const focusIndex = this.focusId !== null ? this.index.get(this.focusId) : undefined;
    this.edgeIdx.forEach(({ a, b, base, kind }, e) => {
      const live = shown[a]! && shown[b]!;
      let alphaEdge = live ? base * alphaScale : 0;
      const touches = focusIndex !== undefined && (a === focusIndex || b === focusIndex);
      if (live && focusIndex !== undefined) alphaEdge = touches ? Math.min(1, alphaEdge * 2.6 + 0.25) : alphaEdge * 0.12;
      // 색: 자식 노드 색. 연결(link)은 text-2, 목표·출처는 text-3 — 닿은 점이 고른 점이면 연결 색으로 밝힌다.
      let c: Rgb = colors[b]!;
      if (kind === "link") c = linkRgb;
      else if (kind === "objective" || kind === "source") c = touches ? linkRgb : objectiveRgb;
      edgeColor.setXYZW(e * 2, c[0] / 255, c[1] / 255, c[2] / 255, alphaEdge);
      edgeColor.setXYZW(e * 2 + 1, c[0] / 255, c[1] / 255, c[2] / 255, alphaEdge);
    });
    edgeColor.needsUpdate = true;
  }
}

export function createMapRenderer(): MapWebglRenderer {
  return new MapWebglRendererImpl();
}
