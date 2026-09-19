import DOMPurify from "dompurify";

import { decodeMermaidSource } from "@fleet-console/markdown/core";

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

interface MermaidModule {
  default?: MermaidApi;
}

interface OklchColor {
  L: number;
  C: number;
  h: number;
  alpha: number;
}

interface InertState {
  element: HTMLElement;
  ariaHidden: string | null;
  inert: boolean;
}

interface ActiveLightbox {
  dialog: HTMLElement;
  trigger: HTMLElement;
  inertStates: InertState[];
  onClick: (event: Event) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  cleanupPanZoom: () => void;
  onCancel?: (event: Event) => void;
}

interface SvgSize {
  width: number;
  height: number;
}

/** 다이어그램 UI 라벨. 미지정 시 영어 기본값을 쓴다(하위호환). */
export interface DiagramHydratorLabels {
  readonly renderFailed?: (message: string) => string;
  readonly openExpandedAria?: string;
  readonly lightboxTitle?: string;
  readonly close?: string;
  readonly closeExpandedAria?: string;
  readonly zoomControlsAria?: string;
  readonly zoomOutAria?: string;
  readonly zoomInAria?: string;
  readonly fit?: string;
  readonly fitAria?: string;
  readonly reset?: string;
  readonly resetAria?: string;
}

type ResolvedDiagramLabels = {
  readonly renderFailed: (message: string) => string;
  readonly openExpandedAria: string;
  readonly lightboxTitle: string;
  readonly close: string;
  readonly closeExpandedAria: string;
  readonly zoomControlsAria: string;
  readonly zoomOutAria: string;
  readonly zoomInAria: string;
  readonly fit: string;
  readonly fitAria: string;
  readonly reset: string;
  readonly resetAria: string;
};

const DEFAULT_DIAGRAM_LABELS: ResolvedDiagramLabels = {
  renderFailed: (message) => `Diagram render failed: ${message}`,
  openExpandedAria: "Open diagram in expanded view",
  lightboxTitle: "MANIFEST · DIAGRAM",
  close: "Close",
  closeExpandedAria: "Close expanded diagram",
  zoomControlsAria: "Diagram zoom controls",
  zoomOutAria: "Zoom out",
  zoomInAria: "Zoom in",
  fit: "Fit",
  fitAria: "Fit diagram to viewport",
  reset: "Reset",
  resetAria: "Reset diagram zoom",
};

let diagramLabels: ResolvedDiagramLabels = DEFAULT_DIAGRAM_LABELS;

const PENDING_SELECTOR = ".diagram-block[data-mermaid-source]:not([data-diagram-state='rendered']):not([data-diagram-state='error'])";
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
// SVG sanitize config is isolated to this module — global markdown sanitizeConfig
// in renderer.ts is unchanged. FORBID_ATTR uses strings only because DOMPurify's
// runtime ignores non-string entries; on* event handlers are stripped by the SVG
// profile's default allowlist plus the EVENT_HANDLER_PATTERN guard installed
// for the duration of sanitizeSvg().
const EVENT_HANDLER_PATTERN = /^on/i;
const SVG_SANITIZE_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: false },
  FORBID_TAGS: ["foreignObject", "script"],
  FORBID_ATTR: ["href", "xlink:href"],
};
const INTERACTION_HANDLER_FLAG = "diagramInteractionBound";
const OKLCH_PATTERN = /^oklch\s*\(\s*([^)]+)\s*\)$/i;
const ANGLE_PATTERN = /^(-?\d+(?:\.\d+)?)(deg)?$/i;
const ZOOM_STEPS = [25, 50, 75, 100, 125, 150, 200] as const;
const PIE_THEME_SLOT_NAMES = [
  "pie1",
  "pie2",
  "pie3",
  "pie4",
  "pie5",
  "pie6",
  "pie7",
  "pie8",
  "pie9",
  "pie10",
  "pie11",
  "pie12",
] as const;

let mermaidLoader: Promise<MermaidApi> | null = null;
// root별로 hydrator를 1회만 설치한다. navigator 컨테이너와 reader 컨테이너는 rail 재개편으로
// 분리된 별도 DOM 트리이므로, 단일 전역 플래그로는 먼저 마운트된 navigator root가 플래그를
// 소진해 정작 diagram을 가진 reader root에 MutationObserver가 붙지 못한다(=mermaid가 pending에 정지).
const hydratedRoots = new WeakSet<ParentNode>();
let renderCounter = 0;
let lightboxCounter = 0;
let activeLightbox: ActiveLightbox | null = null;

export function cssColorToHex(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const oklch = parseOklch(trimmed);
  if (!oklch) return trimmed;
  return oklchToHex(oklch);
}

export function installDiagramHydrator(root: ParentNode, labels?: DiagramHydratorLabels): void {
  // 로케일 전환 시 동일 root 재설치에도 라벨만 갱신할 수 있게, WeakSet 가드보다 먼저 반영한다.
  if (labels) diagramLabels = { ...DEFAULT_DIAGRAM_LABELS, ...labels };
  if (hydratedRoots.has(root)) return;
  hydratedRoots.add(root);
  scan(root);
  const target = root instanceof Node ? root : document.body;
  const observer = new MutationObserver((mutations) => {
    let needsScan = false;
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      if (activeLightbox && !activeLightbox.trigger.isConnected) closeActiveLightbox(false);
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.(".diagram-block[data-mermaid-source]") || node.querySelector?.(".diagram-block[data-mermaid-source]")) {
          needsScan = true;
          break;
        }
      }
      if (needsScan) break;
    }
    if (needsScan) scan(root);
  });
  observer.observe(target, { childList: true, subtree: true });
}

function scan(root: ParentNode): void {
  const placeholders = root.querySelectorAll<HTMLElement>(PENDING_SELECTOR);
  for (const placeholder of placeholders) {
    if (placeholder.dataset.diagramHydrating === "true") continue;
    placeholder.dataset.diagramHydrating = "true";
    placeholder.dataset.diagramState = "pending";
    void hydrate(placeholder);
  }
}

async function hydrate(placeholder: HTMLElement): Promise<void> {
  const encoded = placeholder.getAttribute("data-mermaid-source") ?? "";
  let source = "";
  try {
    source = decodeMermaidSource(encoded);
  } catch {
    setError(placeholder, "Invalid diagram source");
    return;
  }
  if (!source.trim()) {
    setError(placeholder, "Empty diagram source");
    return;
  }
  try {
    const mermaid = await loadMermaid();
    const id = `mermaid-diagram-${++renderCounter}`;
    const { svg } = await mermaid.render(id, source);
    placeholder.innerHTML = sanitizeSvg(svg);
    reapplySpaLinks(placeholder, svg);
    recalculateSvgViewBox(placeholder);
    bindDiagramInteraction(placeholder);
    placeholder.dataset.diagramState = "rendered";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setError(placeholder, message);
  }
}

function setError(placeholder: HTMLElement, message: string): void {
  placeholder.dataset.diagramState = "error";
  placeholder.textContent = diagramLabels.renderFailed(message);
}

function sanitizeSvg(svg: string): string {
  const stripEventHandlers = (_node: Element, data: { attrName: string; keepAttr: boolean }) => {
    if (EVENT_HANDLER_PATTERN.test(data.attrName)) data.keepAttr = false;
  };
  DOMPurify.addHook("uponSanitizeAttribute", stripEventHandlers);
  try {
    return DOMPurify.sanitize(svg, SVG_SANITIZE_CONFIG) as unknown as string;
  } finally {
    DOMPurify.removeHook("uponSanitizeAttribute", stripEventHandlers);
  }
}

async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = (async () => {
      const mod = (await import("mermaid")) as MermaidModule;
      const api = mod.default ?? (mod as unknown as MermaidApi);
      api.initialize({
        securityLevel: "strict",
        htmlLabels: false,
        suppressErrorRendering: true,
        startOnLoad: false,
        theme: "base",
        look: "handDrawn",
        themeVariables: extractThemeVariables(),
        themeCSS: buildThemeCss(),
        flowchart: { htmlLabels: false, useMaxWidth: false },
      });
      return api;
    })();
  }
  return mermaidLoader;
}

function extractThemeVariables(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return cssColorToHex(value || fallback);
  };
  const readToken = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
  const brass = read("--brass", "#c69a4a");
  const brassBright = read("--brass-bright", "#e6b86a");
  const brassDeep = read("--brass-deep", "#a0782a");
  const aurora = read("--aurora", "#8bd7e6");
  const auroraDeep = read("--aurora-deep", "#1f8aa8");
  const coral = read("--coral", "#ef7c63");
  const inkDeep = read("--ink-deep", "#1d2734");
  const inkFog = read("--ink-fog", "#a6afbb");
  const inkPearl = read("--ink-pearl", "#e6e9ef");
  const inkSpectral = read("--ink-spectral", "#bcc4d0");
  const piePalette = [
    brassBright,
    brass,
    aurora,
    coral,
    cssColorToHex("oklch(70% 0.11 68)"),
    auroraDeep,
    cssColorToHex("oklch(76% 0.09 205)"),
    brassDeep,
    cssColorToHex("oklch(68% 0.14 30)"),
    inkFog,
    cssColorToHex("oklch(62% 0.08 228)"),
    cssColorToHex("oklch(52% 0.05 248)"),
  ];
  const pieVariables = Object.fromEntries(PIE_THEME_SLOT_NAMES.map((slot, index) => [slot, piePalette[index] ?? inkDeep]));
  return {
    background: "transparent",
    primaryColor: "transparent",
    primaryTextColor: inkPearl,
    primaryBorderColor: brass,
    secondaryColor: "transparent",
    secondaryTextColor: inkPearl,
    secondaryBorderColor: brassBright,
    tertiaryColor: "transparent",
    tertiaryTextColor: inkSpectral,
    tertiaryBorderColor: brass,
    lineColor: auroraDeep,
    edgeLabelBackground: "transparent",
    titleColor: brassBright,
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace",
    mainBkg: "transparent",
    nodeBorder: brass,
    clusterBkg: "transparent",
    clusterBorder: brass,
    pieTitleTextColor: brassBright,
    pieTitleTextSize: readToken("--font-size-title-lg", "19px"),
    pieSectionTextColor: inkPearl,
    pieSectionTextSize: readToken("--font-size-md", "13px"),
    pieLegendTextColor: inkPearl,
    pieLegendTextSize: readToken("--font-size-lg", "14px"),
    pieStrokeColor: brassDeep,
    pieStrokeWidth: "1.35px",
    pieOuterStrokeColor: brassBright,
    pieOuterStrokeWidth: "2.5px",
    pieOpacity: "0.96",
    ...pieVariables,
  };
}

function buildThemeCss(): string {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return cssColorToHex(value || fallback);
  };
  const brassDeep = read("--brass-deep", "#a0782a");
  const brassBright = read("--brass-bright", "#e6b86a");
  const auroraDeep = read("--aurora-deep", "#1f8aa8");
  const inkAbyss = read("--ink-abyss", "#131920");
  const inkAbyssSoft = cssColorToHex("oklch(15% 0.04 250 / 34%)");
  const surfaceGlass = read("--surface-glass", "#1d2734");
  const inkPearl = read("--ink-pearl", "#e6e9ef");
  return `
    .node rect, .node polygon, .node circle, .node ellipse, .actor, .classGroup rect {
      stroke: ${brassDeep};
      fill: ${surfaceGlass};
    }
    .edgePath path, .messageLine0, .messageLine1, .relation {
      stroke: ${auroraDeep};
    }
    .nodeLabel, .edgeLabel, .actor text, .messageText {
      fill: ${inkPearl};
      font-family: "Manrope Variable", "Manrope", ui-sans-serif, sans-serif;
    }
    .pieCircle {
      stroke: ${brassDeep};
      stroke-width: 1.35px;
      opacity: 0.96;
      filter: drop-shadow(0 0 1.5px ${inkAbyssSoft});
    }
    .pieOuterCircle {
      stroke: ${brassBright};
      opacity: 0.7;
    }
    .slice, .legend text, .pieTitleText {
      fill: ${inkPearl};
      paint-order: stroke;
      stroke: ${inkAbyss};
      stroke-width: 3px;
      stroke-linejoin: round;
      font-family: "Manrope Variable", "Manrope", ui-sans-serif, sans-serif;
    }
    .slice {
      font-weight: 600;
      letter-spacing: 0.04em;
      font-style: italic;
    }
    .pieTitleText {
      font-weight: 600;
      letter-spacing: 0.12em;
      font-style: italic;
    }
    .legend text {
      font-weight: 500;
      letter-spacing: 0.03em;
    }
    .legend rect {
      rx: 999px;
      ry: 999px;
      opacity: 0.9;
      stroke: ${inkAbyss};
      stroke-width: 1.5px;
      paint-order: stroke;
      filter: saturate(0.78) brightness(0.92) drop-shadow(0 0 0.55px ${brassBright});
    }
  `;
}

function reapplySpaLinks(placeholder: HTMLElement, rawSvg: string): void {
  const inertDoc = new DOMParser().parseFromString(rawSvg, "image/svg+xml");
  const rawAnchors = Array.from(inertDoc.querySelectorAll("a"));
  const sanitizedAnchors = Array.from(placeholder.querySelectorAll("a"));
  const limit = Math.min(rawAnchors.length, sanitizedAnchors.length);
  for (let index = 0; index < limit; index++) {
    const raw = rawAnchors[index];
    const sanitized = sanitizedAnchors[index];
    if (!raw || !sanitized) continue;
    const candidate = raw.getAttribute("href") ?? raw.getAttribute("xlink:href") ?? "";
    const safe = normalizeSpaPath(candidate);
    if (!safe) continue;
    sanitized.setAttribute("href", safe);
  }
}

function recalculateSvgViewBox(placeholder: HTMLElement): void {
  const svg = placeholder.querySelector<SVGSVGElement>("svg");
  if (!svg) return;
  let bbox: DOMRect;
  try {
    bbox = svg.getBBox() as DOMRect;
  } catch {
    return;
  }
  const { x, y, width, height } = bbox;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return;
  if (x < 0 || y < 0) return;
  if (width <= 0 || height <= 0) return;
  svg.setAttribute(
    "viewBox",
    `${formatSvgLength(x)} ${formatSvgLength(y)} ${formatSvgLength(width)} ${formatSvgLength(height)}`,
  );
}

function bindDiagramInteraction(placeholder: HTMLElement): void {
  placeholder.tabIndex = 0;
  placeholder.setAttribute("aria-label", diagramLabels.openExpandedAria);
  updateDiagramRole(placeholder);
  if (placeholder.dataset[INTERACTION_HANDLER_FLAG] === "true") return;
  placeholder.dataset[INTERACTION_HANDLER_FLAG] = "true";
  placeholder.addEventListener("click", handleDiagramOpenClick);
  placeholder.addEventListener("keydown", handleDiagramOpenKeydown);
}

function handleDiagramOpenClick(event: MouseEvent): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  if (isNavigationAnchorActivation(event.target)) return;
  const block = event.currentTarget;
  if (!(block instanceof HTMLElement)) return;
  event.preventDefault();
  openDiagramLightbox(block);
}

function handleDiagramOpenKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (isNavigationAnchorActivation(event.target)) return;
  const block = event.currentTarget;
  if (!(block instanceof HTMLElement)) return;
  event.preventDefault();
  openDiagramLightbox(block);
}

function openDiagramLightbox(trigger: HTMLElement): void {
  const sourceSvg = trigger.querySelector("svg");
  if (!sourceSvg) return;
  closeActiveLightbox(false);

  const supportsNativeDialog = typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal === "function";
  const dialog = document.createElement(supportsNativeDialog ? "dialog" : "div");
  const lightboxId = ++lightboxCounter;
  const titleId = `diagram-lightbox-title-${lightboxId}`;
  dialog.className = "diagram-lightbox";
  dialog.setAttribute("aria-labelledby", titleId);
  if (!supportsNativeDialog) {
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.tabIndex = -1;
  }

  const frame = document.createElement("div");
  frame.className = "diagram-lightbox__frame";

  const header = document.createElement("div");
  header.className = "diagram-lightbox__header";

  const title = document.createElement("h2");
  title.id = titleId;
  title.textContent = diagramLabels.lightboxTitle;

  const closeButton = document.createElement("button");
  closeButton.className = "diagram-lightbox__close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", diagramLabels.closeExpandedAria);
  closeButton.textContent = diagramLabels.close;

  const controls = document.createElement("div");
  controls.className = "diagram-lightbox__controls";
  controls.setAttribute("aria-label", diagramLabels.zoomControlsAria);
  const zoomOutButton = createZoomButton("−", diagramLabels.zoomOutAria, "out");
  const zoomReadout = document.createElement("span");
  zoomReadout.className = "diagram-lightbox__zoom-readout";
  zoomReadout.setAttribute("aria-live", "polite");
  const zoomInButton = createZoomButton("+", diagramLabels.zoomInAria, "in");
  const fitButton = createZoomButton(diagramLabels.fit, diagramLabels.fitAria, "fit");
  const resetButton = createZoomButton(diagramLabels.reset, diagramLabels.resetAria, "reset");
  controls.append(zoomOutButton, zoomReadout, zoomInButton, fitButton, resetButton);

  const viewport = document.createElement("div");
  viewport.className = "diagram-lightbox__viewport";
  const inlineBaseSize = readInlineSvgSize(sourceSvg);
  const clonedSvg = sourceSvg.cloneNode(true) as SVGElement;
  clonedSvg.removeAttribute("style");
  retargetClonedSvgStyleId(clonedSvg, `diagram-lightbox-svg-${lightboxId}`);
  viewport.append(clonedSvg);

  header.append(title, controls, closeButton);
  frame.append(header, viewport);
  dialog.append(frame);
  document.body.append(dialog);
  const panZoom = new PanZoomController(viewport, clonedSvg, zoomReadout, inlineBaseSize);
  zoomOutButton.addEventListener("click", () => panZoom.zoomOut());
  zoomInButton.addEventListener("click", () => panZoom.zoomIn());
  fitButton.addEventListener("click", () => panZoom.fit());
  resetButton.addEventListener("click", () => panZoom.reset());

  const inertStates = applyBackgroundInert(dialog);
  const onClick = (event: Event) => {
    if (event.target === dialog || event.target === closeButton) closeActiveLightbox(true);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeActiveLightbox(true);
      return;
    }
    if (panZoom.handleKeyboard(event)) return;
    if (event.key === "Tab") trapLightboxFocus(event, dialog);
  };
  const active: ActiveLightbox = { dialog, trigger, inertStates, onClick, onKeyDown, cleanupPanZoom: () => panZoom.destroy() };
  if (supportsNativeDialog) {
    active.onCancel = (event: Event) => {
      event.preventDefault();
      closeActiveLightbox(true);
    };
    dialog.addEventListener("cancel", active.onCancel);
    (dialog as HTMLDialogElement).showModal();
  }
  dialog.addEventListener("click", onClick);
  document.addEventListener("keydown", onKeyDown, true);
  activeLightbox = active;
  panZoom.fit();
  closeButton.focus();
}

function createZoomButton(label: string, ariaLabel: string, action: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "diagram-lightbox__zoom-button";
  button.type = "button";
  button.dataset.zoomAction = action;
  button.setAttribute("aria-label", ariaLabel);
  button.textContent = label;
  return button;
}

class PanZoomController {
  private readonly baseSize: SvgSize;
  private zoomIndex = ZOOM_STEPS.indexOf(100);
  private dragStart: { x: number; y: number; scrollLeft: number; scrollTop: number; pointerId: number } | null = null;
  private pinchStart: { distance: number; zoomIndex: number } | null = null;
  private readonly pointers = new Map<number, PointerEvent>();

  constructor(
    private readonly viewport: HTMLElement,
    private readonly svg: SVGElement,
    private readonly readout: HTMLElement,
    baseSize: SvgSize,
  ) {
    this.baseSize = baseSize;
    this.applyZoom(this.zoomIndex);
    viewport.addEventListener("pointerdown", this.onPointerDown);
    viewport.addEventListener("pointermove", this.onPointerMove);
    viewport.addEventListener("pointerup", this.onPointerEnd);
    viewport.addEventListener("pointercancel", this.onPointerEnd);
    viewport.addEventListener("wheel", this.onWheel, { passive: false });
    viewport.addEventListener("dblclick", this.onDoubleClick);
    window.addEventListener("resize", this.onResize);
  }

  destroy(): void {
    this.viewport.removeEventListener("pointerdown", this.onPointerDown);
    this.viewport.removeEventListener("pointermove", this.onPointerMove);
    this.viewport.removeEventListener("pointerup", this.onPointerEnd);
    this.viewport.removeEventListener("pointercancel", this.onPointerEnd);
    this.viewport.removeEventListener("wheel", this.onWheel);
    this.viewport.removeEventListener("dblclick", this.onDoubleClick);
    window.removeEventListener("resize", this.onResize);
    this.pointers.clear();
  }

  zoomIn(): void {
    this.zoomAroundViewportCenter(Math.min(this.zoomIndex + 1, ZOOM_STEPS.length - 1));
  }

  zoomOut(): void {
    this.zoomAroundViewportCenter(Math.max(this.zoomIndex - 1, 0));
  }

  reset(): void {
    this.zoomAroundViewportCenter(ZOOM_STEPS.indexOf(100));
  }

  fit(): void {
    const viewportWidth = this.viewport.clientWidth || this.viewport.getBoundingClientRect().width || this.baseSize.width;
    const viewportHeight = this.viewport.clientHeight || this.viewport.getBoundingClientRect().height || this.baseSize.height;
    const fitRatio = Math.min(viewportWidth / this.baseSize.width, viewportHeight / this.baseSize.height);
    const fitPercent = Math.floor(fitRatio * 100);
    const firstTooLargeIndex = ZOOM_STEPS.findIndex((step) => step > fitPercent);
    const fitIndex = firstTooLargeIndex === -1 ? ZOOM_STEPS.length - 1 : Math.max(0, firstTooLargeIndex - 1);
    this.applyZoom(fitIndex);
    this.viewport.scrollLeft = Math.max(0, (this.svgWidth - viewportWidth) / 2);
    this.viewport.scrollTop = Math.max(0, (this.svgHeight - viewportHeight) / 2);
  }

  handleKeyboard(event: KeyboardEvent): boolean {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      this.zoomIn();
      return true;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      this.zoomOut();
      return true;
    }
    if (event.key === "0") {
      event.preventDefault();
      this.reset();
      return true;
    }
    if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.fit();
      return true;
    }
    return false;
  }

  private get svgWidth(): number {
    return this.baseSize.width * (zoomStepAt(this.zoomIndex) / 100);
  }

  private get svgHeight(): number {
    return this.baseSize.height * (zoomStepAt(this.zoomIndex) / 100);
  }

  private applyZoom(nextIndex: number): void {
    this.zoomIndex = nextIndex;
    const step = zoomStepAt(this.zoomIndex);
    const scale = step / 100;
    this.svg.setAttribute("width", formatSvgLength(this.baseSize.width * scale));
    this.svg.setAttribute("height", formatSvgLength(this.baseSize.height * scale));
    this.readout.textContent = `${step}%`;
  }

  private zoomAroundViewportCenter(nextIndex: number): void {
    const rect = this.viewport.getBoundingClientRect();
    this.zoomAroundPoint(nextIndex, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  private zoomAroundPoint(nextIndex: number, clientX: number, clientY: number): void {
    if (nextIndex === this.zoomIndex) return;
    const oldWidth = this.svgWidth;
    const oldHeight = this.svgHeight;
    const rect = this.viewport.getBoundingClientRect();
    const anchorX = this.viewport.scrollLeft + clientX - rect.left;
    const anchorY = this.viewport.scrollTop + clientY - rect.top;
    this.applyZoom(nextIndex);
    this.viewport.scrollLeft = (anchorX / oldWidth) * this.svgWidth - (clientX - rect.left);
    this.viewport.scrollTop = (anchorY / oldHeight) * this.svgHeight - (clientY - rect.top);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || isNavigationAnchorActivation(event.target)) return;
    const pointerId = event.pointerId ?? 1;
    this.pointers.set(pointerId, event);
    if (this.pointers.size === 2) {
      this.pinchStart = { distance: this.pointerDistance(), zoomIndex: this.zoomIndex };
      return;
    }
    this.dragStart = { x: event.clientX, y: event.clientY, scrollLeft: this.viewport.scrollLeft, scrollTop: this.viewport.scrollTop, pointerId };
    this.viewport.setPointerCapture?.(pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const pointerId = event.pointerId ?? 1;
    if (this.pointers.has(pointerId)) this.pointers.set(pointerId, event);
    if (this.pinchStart && this.pointers.size >= 2) {
      const ratio = this.pointerDistance() / this.pinchStart.distance;
      const target = zoomStepAt(this.pinchStart.zoomIndex) * ratio;
      this.applyZoom(nearestZoomIndex(target));
      return;
    }
    if (!this.dragStart || this.dragStart.pointerId !== pointerId) return;
    event.preventDefault();
    this.viewport.scrollLeft = this.dragStart.scrollLeft - (event.clientX - this.dragStart.x);
    this.viewport.scrollTop = this.dragStart.scrollTop - (event.clientY - this.dragStart.y);
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    const pointerId = event.pointerId ?? 1;
    this.pointers.delete(pointerId);
    this.viewport.releasePointerCapture?.(pointerId);
    if (this.dragStart?.pointerId === pointerId) this.dragStart = null;
    if (this.pointers.size < 2) this.pinchStart = null;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const nextIndex = event.deltaY < 0 ? Math.min(this.zoomIndex + 1, ZOOM_STEPS.length - 1) : Math.max(this.zoomIndex - 1, 0);
    this.zoomAroundPoint(nextIndex, event.clientX, event.clientY);
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (isNavigationAnchorActivation(event.target)) return;
    event.preventDefault();
    this.zoomAroundPoint(this.zoomIndex === ZOOM_STEPS.indexOf(200) ? ZOOM_STEPS.indexOf(100) : ZOOM_STEPS.indexOf(200), event.clientX, event.clientY);
  };

  private readonly onResize = (): void => {
    this.fit();
  };

  private pointerDistance(): number {
    const [first, second] = Array.from(this.pointers.values());
    if (!first || !second) return 1;
    return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
  }
}

function readSvgSize(svg: SVGElement): SvgSize {
  const width = parseSvgLength(svg.getAttribute("width"));
  const height = parseSvgLength(svg.getAttribute("height"));
  if (width && height) return { width, height };
  const viewBox = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number) ?? [];
  const viewBoxWidthValue = viewBox[2];
  const viewBoxHeightValue = viewBox[3];
  const viewBoxWidth = viewBoxWidthValue !== undefined && Number.isFinite(viewBoxWidthValue) && viewBoxWidthValue > 0 ? viewBoxWidthValue : null;
  const viewBoxHeight = viewBoxHeightValue !== undefined && Number.isFinite(viewBoxHeightValue) && viewBoxHeightValue > 0 ? viewBoxHeightValue : null;
  return {
    width: width ?? viewBoxWidth ?? 800,
    height: height ?? viewBoxHeight ?? 600,
  };
}

function readInlineSvgSize(svg: SVGElement): SvgSize {
  const rect = svg.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };
  return readSvgSize(svg);
}

function parseSvgLength(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)/.exec(value.trim());
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatSvgLength(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function nearestZoomIndex(targetPercent: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  ZOOM_STEPS.forEach((step, index) => {
    const distance = Math.abs(step - targetPercent);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function zoomStepAt(index: number): number {
  return ZOOM_STEPS[index] ?? ZOOM_STEPS[0];
}

function retargetClonedSvgStyleId(clonedSvg: SVGElement, newId: string): void {
  const oldId = clonedSvg.getAttribute("id") ?? "";
  clonedSvg.setAttribute("id", newId);
  const style = clonedSvg.querySelector("style");
  if (!oldId || !style?.textContent) return;
  style.textContent = style.textContent.split(`#${oldId}`).join(`#${newId}`);
}

function closeActiveLightbox(restoreFocus: boolean): void {
  const active = activeLightbox;
  if (!active) return;
  active.dialog.removeEventListener("click", active.onClick);
  document.removeEventListener("keydown", active.onKeyDown, true);
  if (active.onCancel) active.dialog.removeEventListener("cancel", active.onCancel);
  active.cleanupPanZoom();
  restoreBackgroundInert(active.inertStates);
  if (active.dialog instanceof HTMLDialogElement && active.dialog.open && typeof active.dialog.close === "function") active.dialog.close();
  active.dialog.remove();
  activeLightbox = null;
  if (restoreFocus && active.trigger.isConnected) active.trigger.focus();
}

function applyBackgroundInert(dialog: HTMLElement): InertState[] {
  const states: InertState[] = [];
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement) || child === dialog) continue;
    states.push({ element: child, ariaHidden: child.getAttribute("aria-hidden"), inert: child.inert });
    child.inert = true;
    child.setAttribute("aria-hidden", "true");
  }
  return states;
}

function restoreBackgroundInert(states: InertState[]): void {
  for (const state of states) {
    state.element.inert = state.inert;
    if (state.ariaHidden === null) {
      state.element.removeAttribute("aria-hidden");
    } else {
      state.element.setAttribute("aria-hidden", state.ariaHidden);
    }
  }
}

function trapLightboxFocus(event: KeyboardEvent, dialog: HTMLElement): void {
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusableElement);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function updateDiagramRole(placeholder: HTMLElement): void {
  if (placeholder.querySelector("a[href]")) {
    placeholder.removeAttribute("role");
  } else {
    placeholder.setAttribute("role", "button");
  }
}

function isNavigationAnchorActivation(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const anchor = target.closest("a[href]");
  if (!anchor) return false;
  const href = anchor.getAttribute("href")?.trim() ?? "";
  if (!href) return false;
  return !wrapsRenderedSvg(anchor);
}

function wrapsRenderedSvg(anchor: Element): boolean {
  return Array.from(anchor.children).some((child) => child.tagName.toLowerCase() === "svg");
}

function isFocusableElement(element: HTMLElement): boolean {
  if (element.inert || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  if ("disabled" in element && Boolean(element.disabled)) return false;
  return true;
}

function normalizeSpaPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes("..")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (/^javascript:/i.test(trimmed) || /^data:/i.test(trimmed)) return null;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.origin !== window.location.origin) return null;
    return normalizeSpaPath(url.pathname);
  }
  const entryMatch = /^\/entry\/[^/?#]+$/.exec(trimmed);
  if (entryMatch) {
    const segment = trimmed.slice("/entry/".length);
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(decoded)) return null;
    return `/entry/${encodeURIComponent(decoded)}`;
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed)) return `/entry/${encodeURIComponent(trimmed)}`;
  return null;
}

function parseOklch(value: string): OklchColor | null {
  const match = OKLCH_PATTERN.exec(value);
  if (!match) return null;
  const inner = match[1]?.trim();
  if (!inner) return null;
  const slashIndex = inner.indexOf("/");
  const headRaw = slashIndex >= 0 ? inner.slice(0, slashIndex) : inner;
  const tailRaw = slashIndex >= 0 ? inner.slice(slashIndex + 1).trim() : "";
  const parts = headRaw.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 3) return null;
  const [lPart, cPart, hPart] = parts;
  if (!lPart || !cPart || !hPart) return null;
  const L = parsePercentOrNumber(lPart, 1);
  const C = parsePercentOrNumber(cPart, 0.4);
  const h = parseAngle(hPart);
  if (L === null || C === null || h === null) return null;
  let alpha = 1;
  if (slashIndex >= 0) {
    const a = parsePercentOrNumber(tailRaw, 1);
    if (a === null) return null;
    alpha = a;
  }
  return { L, C, h, alpha };
}

function oklchToHex(color: OklchColor): string {
  const hRad = (color.h * Math.PI) / 180;
  const a = color.C * Math.cos(hRad);
  const b = color.C * Math.sin(hRad);
  const L = color.L;

  const lPrime = L + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = L - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = L - 0.0894841775 * a - 1.291485548 * b;

  const lLin = lPrime ** 3;
  const mLin = mPrime ** 3;
  const sLin = sPrime ** 3;

  const r = 4.0767416621 * lLin - 3.3077115913 * mLin + 0.2309699292 * sLin;
  const g = -1.2684380046 * lLin + 2.6097574011 * mLin - 0.3413193965 * sLin;
  const bl = -0.0041960863 * lLin - 0.7034186147 * mLin + 1.707614701 * sLin;

  const r8 = toByte(linearToGamma(r));
  const g8 = toByte(linearToGamma(g));
  const b8 = toByte(linearToGamma(bl));

  if (color.alpha < 1) {
    const a8 = toByte(color.alpha);
    return `#${hex2(r8)}${hex2(g8)}${hex2(b8)}${hex2(a8)}`;
  }
  return `#${hex2(r8)}${hex2(g8)}${hex2(b8)}`;
}

function parsePercentOrNumber(token: string, percentBase: number): number | null {
  if (!token) return null;
  if (token.endsWith("%")) {
    const n = Number(token.slice(0, -1));
    if (!Number.isFinite(n)) return null;
    return (n / 100) * percentBase;
  }
  const n = Number(token);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseAngle(token: string): number | null {
  const match = ANGLE_PATTERN.exec(token);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function linearToGamma(u: number): number {
  const c = Math.max(0, Math.min(1, u));
  return c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
}

function toByte(v: number): number {
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}
