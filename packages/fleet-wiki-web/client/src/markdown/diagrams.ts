import DOMPurify from "dompurify";

import { decodeMermaidSource } from "./renderer";
import { navigate } from "../router";

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

const PENDING_SELECTOR = ".diagram-block[data-mermaid-source]:not([data-diagram-state='rendered']):not([data-diagram-state='error'])";
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
const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENTRY_PATH_PATTERN = /^\/entry\/[^/?#]+$/;
const CLICK_HANDLER_FLAG = "diagramClickBound";
const OKLCH_PATTERN = /^oklch\s*\(\s*([^)]+)\s*\)$/i;
const ANGLE_PATTERN = /^(-?\d+(?:\.\d+)?)(deg)?$/i;
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
let observerInstalled = false;
let renderCounter = 0;

export function cssColorToHex(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const oklch = parseOklch(trimmed);
  if (!oklch) return trimmed;
  return oklchToHex(oklch);
}

export function installDiagramHydrator(root: ParentNode): void {
  if (observerInstalled) return;
  observerInstalled = true;
  scan(root);
  const target = root instanceof Node ? root : document.body;
  const observer = new MutationObserver((mutations) => {
    let needsScan = false;
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
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
    bindClickHandler(placeholder);
    placeholder.dataset.diagramState = "rendered";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setError(placeholder, message);
  }
}

function setError(placeholder: HTMLElement, message: string): void {
  placeholder.dataset.diagramState = "error";
  placeholder.textContent = `Diagram render failed: ${message}`;
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
        startOnLoad: false,
        theme: "base",
        look: "handDrawn",
        themeVariables: extractThemeVariables(),
        themeCSS: buildThemeCss(),
        flowchart: { htmlLabels: false },
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
    pieTitleTextSize: "19px",
    pieSectionTextColor: inkPearl,
    pieSectionTextSize: "13px",
    pieLegendTextColor: inkPearl,
    pieLegendTextSize: "14px",
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
  const entryMatch = ENTRY_PATH_PATTERN.exec(trimmed);
  if (entryMatch) {
    const segment = trimmed.slice("/entry/".length);
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!ENTRY_ID_PATTERN.test(decoded)) return null;
    return `/entry/${encodeURIComponent(decoded)}`;
  }
  if (ENTRY_ID_PATTERN.test(trimmed)) return `/entry/${encodeURIComponent(trimmed)}`;
  return null;
}

function bindClickHandler(placeholder: HTMLElement): void {
  if (placeholder.dataset[CLICK_HANDLER_FLAG] === "true") return;
  placeholder.dataset[CLICK_HANDLER_FLAG] = "true";
  placeholder.addEventListener("click", handleDiagramClick);
}

function handleDiagramClick(event: MouseEvent): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href || !href.startsWith("/entry/")) return;
  event.preventDefault();
  navigate(href);
}

function parseOklch(value: string): OklchColor | null {
  const match = OKLCH_PATTERN.exec(value);
  if (!match) return null;
  const inner = match[1].trim();
  const slashIndex = inner.indexOf("/");
  const headRaw = slashIndex >= 0 ? inner.slice(0, slashIndex) : inner;
  const tailRaw = slashIndex >= 0 ? inner.slice(slashIndex + 1).trim() : "";
  const parts = headRaw.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 3) return null;
  const L = parsePercentOrNumber(parts[0], 1);
  const C = parsePercentOrNumber(parts[1], 0.4);
  const h = parseAngle(parts[2]);
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
