/** 크롬 문서가 쓰는 DOM 도우미. 글자는 늘 textContent 로만 들어가고, 마크업 문자열을 해석하는 길은 글리프 상수뿐이다. */

type Child = Node | string | null | false | undefined;
export interface Props {
  class?: string; text?: string; title?: string; type?: string; role?: string; tabindex?: number; disabled?: boolean;
  value?: string; placeholder?: string; draggable?: boolean; src?: string; alt?: string; autocomplete?: string; spellcheck?: boolean;
  attrs?: Record<string, string | boolean | null | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  const { attrs, on, text, ...rest } = props;
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    if (key === "class") element.className = String(value);
    else if (typeof value === "boolean") (element as unknown as Record<string, unknown>)[key] = value;
    else element.setAttribute(key === "tabindex" ? "tabindex" : key, String(value));
  }
  if (rest.value !== undefined && "value" in element) (element as unknown as HTMLInputElement).value = rest.value;
  if (rest.disabled !== undefined && "disabled" in element) (element as unknown as HTMLButtonElement).disabled = rest.disabled;
  for (const [key, value] of Object.entries(attrs ?? {})) { if (value === false || value === null || value === undefined) continue; element.setAttribute(key, value === true ? "" : value); }
  if (text !== undefined) element.textContent = text;
  for (const [name, handler] of Object.entries(on ?? {})) element.addEventListener(name, handler as EventListener);
  for (const child of children) if (child) element.append(child);
  return element;
}

export function clear(element: Element): void { element.textContent = ""; }

/** 같은 키는 같은 요소를 다시 쓴다 — 탭 줄이 상태가 바뀔 때마다 아이콘을 다시 그려 깜빡이지 않게. */
export function keyed<T, E extends HTMLElement>(parent: HTMLElement, items: readonly T[], key: (item: T) => string, make: (item: T) => E, update: (element: E, item: T) => void, cache: Map<string, E>): void {
  const wanted = new Set<string>();
  let previous: Node | null = null;
  for (const item of items) {
    const id = key(item);
    wanted.add(id);
    let element = cache.get(id);
    if (!element) { element = make(item); cache.set(id, element); }
    update(element, item);
    const expected: ChildNode | null = previous === null ? parent.firstChild : previous.nextSibling;
    if (element !== expected) parent.insertBefore(element, expected);
    previous = element;
  }
  for (const [id, element] of cache) if (!wanted.has(id)) { element.remove(); cache.delete(id); }
}

const svgNs = "http://www.w3.org/2000/svg";
/** 16×16 아웃라인 글리프. 경로는 이 파일의 상수만 받는다. */
export function glyph(paths: string, size = 14): SVGSVGElement {
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size)); svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.3"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = paths;
  return svg;
}

export const G = {
  monitor: '<rect x="1.5" y="2.5" width="13" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11v3"/>',
  phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7 12.2h2"/>',
  tablet: '<rect x="2.5" y="1.5" width="11" height="13" rx="1.5"/><path d="M7 12.4h2"/>',
  reload: '<path d="M13 8A5 5 0 1 1 8 3"/><path d="M8 1v3M6.5 2.5 8 4l1.5-1.5"/>',
  pin: '<path d="M6.2 2.5h3.6l-.5 3.3 2 2v1.1H4.7V7.8l2-2z"/><path d="M8 8.9v4.5"/>',
  erase: '<path d="M2.6 4.4h10.8"/><path d="M6.4 4.4V2.9h3.2v1.5"/><path d="M4 4.4l.6 8a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8"/>',
  back: '<path d="M6.5 3.5 2.5 7l4 3.5"/><path d="M2.5 7h7a3 3 0 0 1 3 3v1.5"/>',
  import: '<path d="M8 2v8M4.8 6.8 8 10l3.2-3.2"/><path d="M2.5 10.5V12A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5"/>',
  profile: '<path d="M8 1.8 13 3.6v4.1c0 3-2 5.2-5 6.5-3-1.3-5-3.5-5-6.5V3.6z"/>',
  ephemeral: '<path d="M3 7.4 4.4 3.4h7.2L13 7.4"/><path d="M1.8 7.4h12.4"/><circle cx="5" cy="10.4" r="2"/><circle cx="11" cy="10.4" r="2"/><path d="M7 10.4h2"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
  search: '<circle cx="6.5" cy="6.5" r="4.5"/><path d="m10 10 4 4"/>',
  external: '<path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5M9.5 2.5H13.5V6.5M13.5 2.5 7.5 8.5"/>',
  comment: '<path d="M2.5 3.5A1.5 1.5 0 0 1 4 2h8a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12 11H7l-3.2 2.6V11H4a1.5 1.5 0 0 1-1.5-1.5v-6Z"/><path d="M5.5 5.5h5M5.5 8h3"/>',
  camera: '<path d="M5.5 3.5 6.6 2h2.8l1.1 1.5H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V5A1.5 1.5 0 0 1 3 3.5h2.5Z"/><circle cx="8" cy="8.5" r="2.6"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  pen: '<path d="M10.8 2.8 13.2 5.2 5.5 12.9 2.5 13.5 3.1 10.5z"/>',
  arrow: '<path d="M3 13 13 3M6.5 3H13v6.5"/>',
  rect: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/>',
  undo: '<path d="M6 3.5 2.5 7 6 10.5"/><path d="M2.5 7H10a3.5 3.5 0 0 1 0 7H8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  detach: '<path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5M9.5 2.5H13.5V6.5M13.5 2.5 7.5 8.5"/>',
  attach: '<path d="M9.5 6.5v-4H5.5M2.5 13.5 9.5 6.5M13.5 9.5V12A1.5 1.5 0 0 1 12 13.5H4A1.5 1.5 0 0 1 2.5 12V5A1.5 1.5 0 0 1 4 3.5h2.5"/>',
} as const;

export const agentGlyph = (): SVGSVGElement => {
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "0 0 12 12"); svg.setAttribute("width", "10"); svg.setAttribute("height", "10"); svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svgNs, "path");
  path.setAttribute("d", "M6 1.2 7.2 4.8 10.8 6 7.2 7.2 6 10.8 4.8 7.2 1.2 6 4.8 4.8Z"); path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
};

/** 더보기 글리프 — 점 셋이 ×로 돌아 바뀐다. 움직임은 CSS 가 맡는다. */
export function moreGlyph(): SVGSVGElement {
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", "more-glyph");
  svg.innerHTML = '<g class="more-dots" fill="currentColor"><circle cx="8" cy="3.5" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="8" cy="12.5" r="1.3"/></g><path class="more-x" d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
  return svg;
}

export function hostOf(url: string): string { try { return new URL(url).host || url; } catch { return url; } }
