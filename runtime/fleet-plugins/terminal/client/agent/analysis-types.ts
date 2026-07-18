export interface AnalysisModel {
  readonly id: string;
  readonly label: string;
  readonly effortLevels: readonly string[];
  readonly defaultEffort?: string;
}

export interface AnalysisCli {
  readonly cliId: string;
  readonly label: string;
  readonly available: boolean;
  readonly defaultModel?: string;
  readonly models: readonly AnalysisModel[];
}

export interface AnalysisCatalog { readonly clis: readonly AnalysisCli[]; }
export interface AnalysisError { readonly code: string; readonly message: string; }
export interface AnalysisArtifact { readonly id: string; readonly title: string; readonly html: string; readonly createdAt: number; }
export type AnalysisEvent =
  | { readonly type: "connected" }
  | { readonly type: "chunk"; readonly text: string }
  | { readonly type: "thought"; readonly text: string }
  | { readonly type: "tool"; readonly title: string; readonly status: string }
  | { readonly type: "artifact"; readonly artifact: AnalysisArtifact }
  | { readonly type: "complete" }
  | { readonly type: "error"; readonly error: AnalysisError };

export const FORBIDDEN_ANALYSIS_KEYS = new Set(["path", "cwd", "canonicalcwd", "transcriptpath", "providersession", "sessionid", "token", "ticket", "url", "mcpurl", "rawtranscript"]);
export const MAX_ARTIFACT_BYTES = 50 * 1024;
const ARTIFACT_CSP_CONTENT = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
export const ARTIFACT_CSP = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP_CONTENT}">`;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const STATIC_ARTIFACT_ELEMENTS = new Set([
  "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
  "data", "dd", "details", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "i", "img", "kbd", "li", "main", "mark", "meter", "ol", "p", "pre", "progress", "q", "s", "samp", "section",
  "small", "span", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var",
]);
const GLOBAL_ARTIFACT_ATTRIBUTES = new Set(["class", "dir", "hidden", "id", "lang", "role", "style", "title"]);
const ELEMENT_ARTIFACT_ATTRIBUTES = new Map<string, ReadonlySet<string>>([
  ["col", new Set(["span"])], ["colgroup", new Set(["span"])], ["data", new Set(["value"])], ["details", new Set(["open"])],
  ["img", new Set(["alt", "height", "src", "width"])], ["li", new Set(["value"])],
  ["meter", new Set(["high", "low", "max", "min", "optimum", "value"])], ["ol", new Set(["reversed", "start", "type"])],
  ["progress", new Set(["max", "value"])], ["td", new Set(["colspan", "headers", "rowspan"])],
  ["th", new Set(["abbr", "colspan", "headers", "rowspan", "scope"])], ["time", new Set(["datetime"])],
]);
const RASTER_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/]*={0,2}$/i;

export function safeArtifactSrcdoc(html: string): string | null {
  if (utf8Size(html) > MAX_ARTIFACT_BYTES) return null;
  const parser = new DOMParser();
  const source = parser.parseFromString(html, "text/html");
  const clean = parser.parseFromString("<!doctype html><html><head></head><body></body></html>", "text/html");
  const csp = clean.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = ARTIFACT_CSP_CONTENT;
  clean.head.append(csp);
  appendStaticChildren(source.head, clean.head, clean);
  appendStaticChildren(source.body, clean.body, clean);
  return `<!doctype html>${clean.documentElement.outerHTML}`;
}

function appendStaticChildren(source: ParentNode, target: Node, clean: Document): void {
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(clean.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (!(child instanceof Element) || child.namespaceURI !== HTML_NAMESPACE) continue;
    const tag = child.localName;
    if (!STATIC_ARTIFACT_ELEMENTS.has(tag)) continue;
    const element = clean.createElement(tag);
    copyStaticAttributes(child, element, tag);
    if (tag === "style") element.textContent = safeInlineCss(child.textContent ?? "");
    else appendStaticChildren(child, element, clean);
    target.appendChild(element);
  }
}

function copyStaticAttributes(source: Element, target: Element, tag: string): void {
  const elementAttributes = ELEMENT_ARTIFACT_ATTRIBUTES.get(tag);
  for (const attribute of source.attributes) {
    const name = attribute.name.toLowerCase();
    if (!GLOBAL_ARTIFACT_ATTRIBUTES.has(name) && !elementAttributes?.has(name) && !/^aria-[a-z0-9-]+$/.test(name) && !/^data-[a-z0-9-]+$/.test(name)) continue;
    if (name === "src") {
      if (tag === "img" && RASTER_DATA_IMAGE.test(attribute.value)) target.setAttribute(name, attribute.value);
      continue;
    }
    if (name === "style") target.setAttribute(name, safeInlineCss(attribute.value));
    else if (name === "dir" && !["ltr", "rtl", "auto"].includes(attribute.value.toLowerCase())) continue;
    else target.setAttribute(name, attribute.value);
  }
}

function safeInlineCss(value: string): string {
  return value
    .replace(/@import\b[\s\S]*?(?:;|$)/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "none");
}

export function hasForbiddenAnalysisKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenAnalysisKey);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_ANALYSIS_KEYS.has(key.toLowerCase()) || hasForbiddenAnalysisKey(child));
}

export function parseAnalysisCatalog(value: unknown): AnalysisCatalog | null {
  if (hasForbiddenAnalysisKey(value) || !isRecord(value) || !Array.isArray(value.clis)) return null;
  const clis = value.clis.map(parseCli);
  return clis.every((cli): cli is AnalysisCli => cli !== null) ? { clis } : null;
}

export function parseAnalysisEvent(value: unknown): AnalysisEvent | null {
  if (hasForbiddenAnalysisKey(value) || !isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "connected") return { type: "connected" };
  if ((value.type === "chunk" || value.type === "thought") && typeof value.text === "string") return { type: value.type, text: value.text };
  if (value.type === "tool" && typeof value.title === "string" && typeof value.status === "string") return { type: "tool", title: value.title, status: value.status };
  if (value.type === "complete") return { type: "complete" };
  if (value.type === "error" && isError(value.error)) return { type: "error", error: value.error };
  if (value.type === "artifact" && isRecord(value.artifact) && typeof value.artifact.id === "string" && typeof value.artifact.title === "string" && typeof value.artifact.html === "string" && typeof value.artifact.createdAt === "number" && utf8Size(value.artifact.html) <= MAX_ARTIFACT_BYTES) return { type: "artifact", artifact: { id: value.artifact.id, title: value.artifact.title, html: value.artifact.html, createdAt: value.artifact.createdAt } };
  return null;
}

export function parseAnalysisError(value: unknown): AnalysisError | null {
  return !hasForbiddenAnalysisKey(value) && isRecord(value) && isError(value.error) ? value.error : null;
}

function parseCli(value: unknown): AnalysisCli | null {
  if (!isRecord(value) || typeof value.cliId !== "string" || typeof value.label !== "string" || typeof value.available !== "boolean" || !Array.isArray(value.models)) return null;
  const models = value.models.map((model): AnalysisModel | null => isRecord(model) && typeof model.id === "string" && typeof model.label === "string" && Array.isArray(model.effortLevels) && model.effortLevels.every((effort) => typeof effort === "string") ? { id: model.id, label: model.label, effortLevels: model.effortLevels, defaultEffort: typeof model.defaultEffort === "string" ? model.defaultEffort : undefined } : null);
  return models.every((model): model is AnalysisModel => model !== null) ? { cliId: value.cliId, label: value.label, available: value.available, defaultModel: typeof value.defaultModel === "string" ? value.defaultModel : undefined, models } : null;
}
function isError(value: unknown): value is AnalysisError { return isRecord(value) && typeof value.code === "string" && typeof value.message === "string"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function utf8Size(value: string): number { return new TextEncoder().encode(value).byteLength; }
