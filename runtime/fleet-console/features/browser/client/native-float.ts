import { DESKTOP_BROWSER_FLOAT_CAPABILITY, DESKTOP_BROWSER_FLOAT_CHANNEL } from "@fleet-console/protocol/desktop";
import { NATIVE_VIEW_COVER_ATTRIBUTE } from "@fleet-console/ui/native-view";
import { desktopShellCapabilities, isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import "./native-float.css";

/**
 * 플릿 브라우저 자리를 덮는 비모달 표면을 Desktop 의 작은 투명 자식 창에 띄운다.
 *
 * 네이티브 브라우저 뷰는 Console 페이지 위에 그려지므로, 그 자리로 펼쳐지는 DOM 메뉴·팝오버는 뷰 뒤로 가려진다. 지금까지는
 * 그런 표면(`data-covers-native-view`)이 있으면 뷰를 Console 뒤로 물리고 정지 화면을 깔았다 — 브라우저가 멈춰 보였다.
 * 셸이 `browser-float` 능력을 게시하면 대신:
 *
 * 1. 이 창은 브라우저 자리와 겹치는 표면들의 자리(CSS px)를 셸에 알리고(`float`), 그 모양을 같은 출처 채널로 자식 창 표면에 보낸다.
 * 2. 표면(`/console/browser-float.html`)이 같은 스타일시트로 그 모양을 그리고, 보였다고 답하면 원본은 투명해진다.
 * 3. 표면에서 누른 항목·휠은 이 창의 원본 요소로 돌려보낸다 — 상태와 동작은 여전히 이 창의 React 가 가진다.
 * 4. 브라우저를 눌러 이 창이 포커스를 잃으면 바깥 누름을 흉내 내 표면이 스스로 닫히게 한다 — DOM 밖을 누른 것이라 문서의
 *    바깥 클릭 처리기가 듣지 못한다.
 *
 * 그동안 브라우저 뷰는 패널 자리에서 라이브로 남는다. 모달 대화상자(`aria-modal="true"`)는 여기서 다루지 않는다 — 입력을
 * 가두는 표면이라 지금처럼 뷰를 물린다. 능력이 없는 셸(옛 Desktop)에서는 아무 일도 하지 않는다.
 */

/** 그림자·꼬리가 잘리지 않도록 표면 사각형 둘레에 두는 여백(CSS px). */
const FLOAT_PAD = 24;
/** 앵커를 따라 움직이는 팝오버의 자리를 놓치지 않도록 다시 재는 주기. */
const FLOAT_TRACK_MS = 200;
/** 이 창이 포커스를 잃은 뒤, 그것이 표면을 누른 것이었는지 기다려 보는 시간. */
const FLOAT_BLUR_GRACE_MS = 180;
/** 원본 요소가 자식 창에 떠 있음을 나타내는 표지 — 가림 판정도 이 안의 요소는 덮개로 세지 않는다. */
export const NATIVE_FLOAT_ATTRIBUTE = "data-native-float";
/** 자식 창에서도 자기 CSS 전환·애니메이션을 재생하는 표면에 다는 표지 — 달지 않은 표면은 자식 창에서 정지한 채 그려진다(`float-surface.ts`). */
export const NATIVE_FLOAT_MOTION_ATTRIBUTE = "data-float-motion";
/** 브라우저 네이티브 자리를 가진 요소에 다는 표지 — 값은 그 브라우저의 키(`/api/v1/browser/objectives/:id`). */
export const NATIVE_FLOAT_TARGET_ATTRIBUTE = "data-native-float-target";

const COVER_SELECTOR = `[${NATIVE_VIEW_COVER_ATTRIBUTE}]`;

type SurfaceMessage =
  | { readonly type: "hello" }
  | { readonly type: "shown"; readonly revision: number }
  | { readonly type: "hover"; readonly inside: boolean }
  | { readonly type: "activate"; readonly revision: number; readonly path: number }
  | { readonly type: "wheel"; readonly revision: number; readonly path: number; readonly dx: number; readonly dy: number }
  | { readonly type: "pointer"; readonly revision: number; readonly kind: "over" | "out"; readonly path: number; readonly related: number | null };

interface FloatState {
  target: string | null;
  revision: number;
  elements: readonly HTMLElement[];
  /** 마지막으로 보낸 그림의 노드 — `path` 로 원본을 찾는다. */
  nodes: readonly Element[];
  /** 같은 그림·같은 자리를 거듭 보내지 않게. */
  key: string;
}

let channel: BroadcastChannel | null = null;
let retained = 0;
let stopManager: (() => void) | null = null;
let scheduled = 0;
let revisionSeed = 0;
let surfaceHover = false;
let trackKey = "";
const state: FloatState = { target: null, revision: -1, elements: [], nodes: [], key: "" };

/** 셸이 자식 창 메뉴를 해석하는가. 렌더 밖에서 읽는다. */
export function nativeFloatAvailable(): boolean {
  return isDesktopShell() && typeof BroadcastChannel === "function" && desktopShellCapabilities().includes(DESKTOP_BROWSER_FLOAT_CAPABILITY);
}

/** `element` 가 떠 있는(자식 창에 그려지는) 표면 안에 있는가 — 브라우저 가림 판정이 건너뛴다. */
export function insideNativeFloat(element: Element | null): boolean {
  return element?.closest(`[${NATIVE_FLOAT_ATTRIBUTE}]`) != null;
}

/** 네이티브 브라우저 자리가 하나라도 있는 동안 관리자를 붙든다. 마지막 붙듦이 풀리면 자식 창을 내리고 멈춘다. */
export function retainNativeFloat(): () => void {
  retained += 1;
  if (retained === 1) stopManager = startManager();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retained -= 1;
    if (retained === 0) { stopManager?.(); stopManager = null; }
  };
}

function startManager(): () => void {
  ensureChannel();
  const inside = (node: Node | null): boolean => node instanceof Element ? node.closest(COVER_SELECTOR) !== null : node?.parentElement?.closest(COVER_SELECTOR) != null;
  // 가림 표면뿐 아니라 모달이 붙고 떨어질 때도 다시 잰다 — 모달 동안은 아무것도 띄우지 않고, 닫히면 다시 띄운다.
  const watched = `${COVER_SELECTOR}, [aria-modal="true"]`;
  const relevantNode = (node: Node): boolean => node instanceof Element && (node.matches(watched) || node.querySelector(watched) !== null);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.attributeName === NATIVE_FLOAT_ATTRIBUTE) continue;
      if (record.type === "attributes" && (record.attributeName === NATIVE_VIEW_COVER_ATTRIBUTE || record.attributeName === "aria-modal")) { schedule(); return; }
      // 표면이 사라지는 변경은 다음 프레임을 기다리지 않는다 — 같은 틱(그림 전)에 자식 창을 내려 닫힌 메뉴의 잔상이 한 프레임도 남지 않게 한다.
      if ([...record.removedNodes].some(relevantNode)) { renderNow(); return; }
      if (inside(record.target) || [...record.addedNodes].some(relevantNode)) { schedule(); return; }
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const onScroll = (event: Event) => { if (inside(event.target as Node | null)) schedule(); };
  const onFocus = (event: Event) => { if (inside(event.target as Node | null)) schedule(); };
  const onResize = () => schedule();
  document.addEventListener("scroll", onScroll, true);
  document.addEventListener("focusin", onFocus);
  document.addEventListener("focusout", onFocus);
  document.addEventListener("input", onFocus, true);
  window.addEventListener("resize", onResize);
  const track = setInterval(() => {
    const key = coverRectsKey();
    if (key !== trackKey) { trackKey = key; schedule(); }
  }, FLOAT_TRACK_MS);
  const onBlur = () => {
    setTimeout(() => {
      if (state.target === null || document.hasFocus() || surfaceHover) return;
      pressOutside();
    }, FLOAT_BLUR_GRACE_MS);
  };
  window.addEventListener("blur", onBlur);
  schedule();
  return () => {
    observer.disconnect();
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("focusout", onFocus);
    document.removeEventListener("input", onFocus, true);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("blur", onBlur);
    clearInterval(track);
    if (scheduled) { cancelAnimationFrame(scheduled); scheduled = 0; }
    release([]);
  };
}

function ensureChannel(): BroadcastChannel {
  if (channel) return channel;
  channel = new BroadcastChannel(DESKTOP_BROWSER_FLOAT_CHANNEL);
  channel.onmessage = (event: MessageEvent<SurfaceMessage>) => receive(event.data);
  return channel;
}

function schedule(): void {
  if (scheduled || retained === 0) return;
  scheduled = requestAnimationFrame(() => { scheduled = 0; render(); });
}

/** 예약된 그림을 접고 지금 그린다 — 표면이 사라진 변경을 곧바로 반영할 때. */
function renderNow(): void {
  if (retained === 0) return;
  if (scheduled) { cancelAnimationFrame(scheduled); scheduled = 0; }
  render();
}

function coverRectsKey(): string {
  let key = "";
  for (const element of document.querySelectorAll(COVER_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    key += `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)};`;
  }
  for (const host of document.querySelectorAll(`[${NATIVE_FLOAT_TARGET_ATTRIBUTE}]`)) {
    const rect = host.getBoundingClientRect();
    key += `n${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)};`;
  }
  return key;
}

const overlaps = (a: DOMRect, b: DOMRect): boolean => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;

/** 지금 떠야 하는 표면들 — 비모달이고, 보이고, 다른 표면 안에 들어 있지 않고, 네이티브 자리와 겹치는 것. */
function candidates(): { readonly target: string | null; readonly elements: HTMLElement[] } {
  // 모달이 열리면 그 아래의 떠 있는 표면도 막과 함께 물러난다 — 따로 선 자식 창은 막 위에 남아 버린다.
  if (document.querySelector('[aria-modal="true"]')) return { target: null, elements: [] };
  const covers = [...document.querySelectorAll<HTMLElement>(COVER_SELECTOR)].filter((element) => {
    if (element.getAttribute("aria-modal") === "true" || element.closest('[aria-modal="true"]')) return false;
    if (element.parentElement?.closest(COVER_SELECTOR)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(element);
    // 자식 창에 그려지는 동안 원본은 스스로 투명해진다(`native-float.css`) — 그 투명함은 닫힘이 아니다.
    return style.visibility !== "hidden" && (element.getAttribute(NATIVE_FLOAT_ATTRIBUTE) === "shown" || Number(style.opacity) > 0.01);
  });
  if (covers.length === 0) return { target: null, elements: [] };
  for (const host of document.querySelectorAll<HTMLElement>(`[${NATIVE_FLOAT_TARGET_ATTRIBUTE}]`)) {
    const native = host.getBoundingClientRect();
    if (native.width < 1 || native.height < 1) continue;
    const over = covers.filter((element) => overlaps(element.getBoundingClientRect(), native));
    if (over.length > 0) return { target: host.getAttribute(NATIVE_FLOAT_TARGET_ATTRIBUTE), elements: over };
  }
  return { target: null, elements: [] };
}

function render(): void {
  const next = nativeFloatAvailable() ? candidates() : { target: null, elements: [] };
  if (next.target === null || next.elements.length === 0) { release([]); return; }
  if (state.target !== null && state.target !== next.target) post(state.target, { clear: true });
  release(next.elements);
  const rects = next.elements.map((element) => element.getBoundingClientRect());
  const left = Math.floor(Math.min(...rects.map((rect) => rect.left)));
  const top = Math.floor(Math.min(...rects.map((rect) => rect.top)));
  const right = Math.ceil(Math.max(...rects.map((rect) => rect.right)));
  const bottom = Math.ceil(Math.max(...rects.map((rect) => rect.bottom)));
  const nodes: Element[] = [];
  const html = next.elements.map((element, index) => serialize(element, rects[index]!, left, top, nodes)).join("");
  const width = right - left + FLOAT_PAD * 2;
  const height = bottom - top + FLOAT_PAD * 2;
  const key = `${next.target}|${left},${top},${width},${height}|${html}`;
  for (const element of next.elements) if (!element.hasAttribute(NATIVE_FLOAT_ATTRIBUTE)) element.setAttribute(NATIVE_FLOAT_ATTRIBUTE, "pending");
  state.target = next.target;
  state.elements = next.elements;
  if (key === state.key) return;
  state.key = key;
  state.nodes = nodes;
  const revision = ++revisionSeed;
  state.revision = revision;
  ensureChannel().postMessage({
    type: "render",
    revision,
    html,
    width,
    height,
    styles: stylesheets(),
    root: attributesOf(document.documentElement),
    body: attributesOf(document.body),
  });
  post(next.target, { revision, x: left - FLOAT_PAD, y: top - FLOAT_PAD, width, height });
}

/** `keep` 밖의 표면에서 표지를 떼고, 아무것도 남지 않으면 자식 창을 내린다. */
function release(keep: readonly HTMLElement[]): void {
  for (const element of state.elements) if (!keep.includes(element)) element.removeAttribute(NATIVE_FLOAT_ATTRIBUTE);
  if (keep.length > 0) return;
  if (state.target !== null) {
    channel?.postMessage({ type: "clear" });
    post(state.target, { clear: true });
  }
  state.target = null;
  state.elements = [];
  state.nodes = [];
  state.key = "";
}

function post(target: string, body: Record<string, unknown>): void {
  void fetch(`/api/v1/browser/objectives/${encodeURIComponent(target)}/float`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

function receive(message: SurfaceMessage): void {
  if (!message || typeof message !== "object") return;
  if (message.type === "hover") { surfaceHover = message.inside === true; return; }
  if (message.type === "hello") { state.key = ""; schedule(); return; }
  if (state.target === null) return;
  if (message.type === "shown") {
    if (message.revision === state.revision) for (const element of state.elements) element.setAttribute(NATIVE_FLOAT_ATTRIBUTE, "shown");
    return;
  }
  // 표면이 낡은 그림을 보고 누른 것은 버린다 — 같은 번호가 다른 항목을 가리킬 수 있다.
  if (message.revision !== state.revision || !Number.isInteger(message.path)) return;
  // 누른 것이 글리프(SVG)여도 그 둘레의 HTML 요소가 동작을 가진다.
  const node = originalAt(message.path);
  if (!node) return;
  if (message.type === "pointer") { hover(node, message.kind, message.related === null ? null : originalAt(message.related)); return; }
  if (message.type === "activate") activate(node);
  else if (message.type === "wheel") scrollFrom(node, Number(message.dx) || 0, Number(message.dy) || 0);
}

/** 자식 창 번호의 원본 — 글리프(SVG)를 눌러도 그 둘레의 HTML 요소가 동작을 가진다. 떠 있는 표면 밖이면 없다. */
function originalAt(path: number): HTMLElement | null {
  let node: Element | null = state.nodes[path] ?? null;
  while (node && !(node instanceof HTMLElement)) node = node.parentElement;
  return node instanceof HTMLElement && state.elements.some((element) => element.contains(node)) ? node : null;
}

/**
 * 자식 창 안의 포인터 진입·이탈을 원본에 그대로 낸다. 호버로 열리고 떠나면 닫히는 표면(원격 콘솔 목록, 옆 하위 메뉴)은
 * 표면에 들어온 것을 원본의 enter 처리기로 알아야 닫힘 타이머를 거둔다. `related` 가 없으면 창 밖과 오간 것이다.
 */
function hover(node: HTMLElement, kind: "over" | "out", related: HTMLElement | null): void {
  const rect = node.getBoundingClientRect();
  const init = { ...pointerInit(rect.left + rect.width / 2, rect.top + rect.height / 2), relatedTarget: related };
  node.dispatchEvent(new PointerEvent(kind === "over" ? "pointerover" : "pointerout", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  node.dispatchEvent(new MouseEvent(kind === "over" ? "mouseover" : "mouseout", init));
}

const pointerInit = (x: number, y: number) => ({ bubbles: true, cancelable: true, composed: true, button: 0, clientX: x, clientY: y });

/** 사람이 누른 것과 같은 순서로 원본 요소에 포인터·마우스 사건을 낸다 — mousedown 에서 동작하는 항목도 있다. */
function activate(node: HTMLElement): void {
  // 입력란은 원본에 포커스를 준다 — 이 창이 키보드를 계속 가지므로 타이핑은 원본에 들어가고, 바뀐 값이 다시 그려진다.
  const field = node.closest<HTMLElement>("input, textarea, [contenteditable='true'], [contenteditable='']");
  if (field) { field.focus({ preventScroll: true }); return; }
  const target = node.closest<HTMLElement>("button, a, [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], [role='option'], [role='tab'], label, summary") ?? node;
  if ((target as HTMLButtonElement).disabled) return;
  const rect = target.getBoundingClientRect();
  const init = pointerInit(rect.left + rect.width / 2, rect.top + rect.height / 2);
  target.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
  target.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
  target.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  target.dispatchEvent(new MouseEvent("mouseup", init));
  target.click();
}

/** 브라우저를 누른 것을 문서 바깥 누름으로 알린다 — 표면마다 가진 바깥 클릭 닫기가 그대로 동작한다. */
function pressOutside(): void {
  const init = pointerInit(0, 0);
  document.body.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
  document.body.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
  document.body.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  document.body.dispatchEvent(new MouseEvent("mouseup", init));
  document.body.dispatchEvent(new MouseEvent("click", init));
}

function scrollFrom(node: HTMLElement, dx: number, dy: number): void {
  for (let current: HTMLElement | null = node; current && !current.matches(COVER_SELECTOR); current = current.parentElement) {
    if (canScroll(current)) { current.scrollBy({ left: dx, top: dy }); return; }
  }
  const root = node.closest<HTMLElement>(COVER_SELECTOR);
  if (root && canScroll(root)) root.scrollBy({ left: dx, top: dy });
}

function canScroll(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return (/(auto|scroll)/u.test(style.overflowY) && element.scrollHeight > element.clientHeight)
    || (/(auto|scroll)/u.test(style.overflowX) && element.scrollWidth > element.clientWidth);
}

/**
 * 표면과 그 조상들을 옮긴다. 조상은 껍데기만(`display: contents`) 남겨 조상 선택자와 상속 값이 자식 창에서도 맞게 하고,
 * 표면 자신은 자식 창 안의 같은 상대 자리에 고정한다. 각 요소에 번호를 달아 자식 창이 누른 것을 원본에서 찾게 한다.
 */
function serialize(element: HTMLElement, rect: DOMRect, left: number, top: number, nodes: Element[]): string {
  const clone = element.cloneNode(true) as HTMLElement;
  const originals = [element, ...element.querySelectorAll("*")];
  const copies = [clone, ...clone.querySelectorAll("*")];
  const active = document.activeElement;
  for (let index = 0; index < originals.length && index < copies.length; index++) {
    const original = originals[index]!;
    const copy = copies[index]!;
    copy.setAttribute("data-fp", String(nodes.length));
    nodes.push(original);
    copy.removeAttribute("id");
    copy.removeAttribute(NATIVE_FLOAT_ATTRIBUTE);
    if (original === active) copy.setAttribute("data-float-focus", "");
    if (original.scrollTop || original.scrollLeft) copy.setAttribute("data-float-scroll", `${original.scrollLeft},${original.scrollTop}`);
    if (original instanceof HTMLInputElement && copy instanceof HTMLInputElement) copy.setAttribute("value", original.value);
    if (original instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) copy.textContent = original.value;
  }
  const pin = `position:fixed!important;left:${rect.left - left + FLOAT_PAD}px!important;top:${rect.top - top + FLOAT_PAD}px!important;right:auto!important;bottom:auto!important;margin:0!important;`
    + `width:${rect.width}px!important;height:${rect.height}px!important;max-width:none!important;max-height:none!important;min-width:0!important;min-height:0!important;`
    + `transform:none!important;translate:none!important;inset-inline:auto;${element.hasAttribute(NATIVE_FLOAT_MOTION_ATTRIBUTE) ? "" : "animation:none!important;"}opacity:1!important;visibility:visible!important;`;
  clone.setAttribute("style", `${clone.getAttribute("style") ?? ""};${pin}`);
  let html = clone.outerHTML;
  for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
    const shell = ancestor.cloneNode(false) as HTMLElement;
    shell.removeAttribute("id");
    shell.setAttribute("style", `${shell.getAttribute("style") ?? ""};display:contents!important`);
    const outer = shell.outerHTML;
    const close = outer.lastIndexOf("</");
    html = close >= 0 ? `${outer.slice(0, close)}${html}${outer.slice(close)}` : outer;
  }
  return html;
}

function stylesheets(): { readonly links: readonly string[]; readonly inline: string } {
  const links = [...document.querySelectorAll<HTMLLinkElement>("link[rel='stylesheet']")]
    .map((link) => link.href)
    .filter((href) => { try { return new URL(href).origin === location.origin; } catch { return false; } });
  const inline = [...document.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
  return { links, inline };
}

function attributesOf(element: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attribute of element.attributes) out[attribute.name] = attribute.value;
  return out;
}
