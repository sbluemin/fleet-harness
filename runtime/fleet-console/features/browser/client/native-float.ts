import * as React from "react";
import { DESKTOP_BROWSER_FLOAT_CAPABILITY, DESKTOP_BROWSER_FLOAT_CHANNEL } from "@fleet-console/protocol/desktop";
import { desktopShellCapabilities, isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import "./native-float.css";

/**
 * 플릿 브라우저 자리를 덮는 Console 메뉴·팝오버를 Desktop 의 작은 투명 자식 창에 띄운다.
 *
 * 네이티브 브라우저 뷰는 Console 페이지 위에 그려지므로, 그 자리에 떨어지는 DOM 메뉴는 뷰 뒤로 가려진다. 지금까지는 뷰를
 * Console 뒤로 물리고 정지 화면을 깔았다 — 브라우저가 멈춰 보였다. 셸이 `browser-float` 능력을 게시하면 대신:
 *
 * 1. 이 창은 메뉴의 자리(CSS px)를 셸에 알리고(`float`), 메뉴의 모양을 같은 출처 채널로 자식 창 표면에 보낸다.
 * 2. 표면(`/console/browser-float.html`)이 같은 스타일시트로 그 모양을 그리고, 보였다고 답하면 원본은 투명해진다.
 * 3. 표면에서 누른 항목·휠은 이 창의 원본 요소로 돌려보낸다 — 상태와 동작은 여전히 이 창의 React 가 가진다.
 *
 * 그동안 브라우저 뷰는 패널 자리에서 라이브로 남는다. 능력이 없는 셸(옛 Desktop)에서는 아무 일도 하지 않으므로 기존
 * 가림 판정 경로가 그대로 쓰인다.
 */

/** 그림자·꼬리가 잘리지 않도록 메뉴 사각형 둘레에 두는 여백(CSS px). */
const FLOAT_PAD = 24;
/** 앵커를 따라 움직이는 팝오버의 자리를 놓치지 않도록 다시 재는 주기. */
const FLOAT_TRACK_MS = 200;
/** 이 창이 포커스를 잃은 뒤, 그것이 표면을 누른 것이었는지 기다려 보는 시간. */
const FLOAT_BLUR_GRACE_MS = 180;
/** 원본 요소가 투명해졌음을 나타내는 표지 — 가림 판정도 이 안의 요소는 덮개로 세지 않는다. */
export const NATIVE_FLOAT_ATTRIBUTE = "data-native-float";
/** 브라우저 네이티브 자리를 가진 요소에 다는 표지 — 값은 그 브라우저의 키(`/api/v1/browser/objectives/:id`). */
export const NATIVE_FLOAT_TARGET_ATTRIBUTE = "data-native-float-target";

type SurfaceMessage =
  | { readonly type: "hello" }
  | { readonly type: "shown"; readonly revision: number }
  | { readonly type: "hover"; readonly inside: boolean }
  | { readonly type: "activate"; readonly revision: number; readonly path: number }
  | { readonly type: "wheel"; readonly revision: number; readonly path: number; readonly dx: number; readonly dy: number };

interface FloatEntry {
  readonly element: HTMLElement;
  readonly dismiss: (() => void) | null;
  revision: number;
  /** 마지막으로 보낸 그림의 노드 — `path` 로 원본을 찾는다. */
  nodes: readonly Element[];
  target: string | null;
  lastRect: string;
}

let channel: BroadcastChannel | null = null;
const stack: FloatEntry[] = [];
let revisionSeed = 0;
let surfaceHover = false;
let scheduled = 0;

/** 셸이 자식 창 메뉴를 해석하는가. 렌더 밖에서 읽는다. */
export function nativeFloatAvailable(): boolean {
  return isDesktopShell() && typeof BroadcastChannel === "function" && desktopShellCapabilities().includes(DESKTOP_BROWSER_FLOAT_CAPABILITY);
}

/** `element` 가 떠 있는(자식 창에 그려지는) 메뉴 안에 있는가 — 브라우저 가림 판정이 건너뛴다. */
export function insideNativeFloat(element: Element | null): boolean {
  return element?.closest(`[${NATIVE_FLOAT_ATTRIBUTE}]`) != null;
}

/**
 * `open` 인 동안 `ref` 의 요소가 브라우저 자리를 덮으면 자식 창에 띄운다. `dismiss` 는 브라우저(다른 뷰)를 눌러 이 창이
 * 포커스를 잃었을 때 메뉴를 닫는 길이다 — DOM 밖을 누른 것이라 문서의 바깥 클릭 처리기가 듣지 못한다.
 */
export function useNativeFloat(ref: React.RefObject<HTMLElement | null>, open: boolean, dismiss?: () => void): void {
  const dismissRef = React.useRef(dismiss);
  dismissRef.current = dismiss;
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!open || !element || !nativeFloatAvailable()) return;
    const entry: FloatEntry = { element, dismiss: () => dismissRef.current?.(), revision: -1, nodes: [], target: null, lastRect: "" };
    stack.push(entry);
    ensureChannel();
    const observer = new MutationObserver((records) => {
      if (records.every((record) => record.type === "attributes" && record.attributeName === NATIVE_FLOAT_ATTRIBUTE)) return;
      schedule();
    });
    observer.observe(element, { subtree: true, childList: true, attributes: true, characterData: true });
    const onChange = () => schedule();
    element.addEventListener("scroll", onChange, true);
    element.addEventListener("focusin", onChange);
    element.addEventListener("focusout", onChange);
    window.addEventListener("resize", onChange);
    const track = setInterval(() => { if (rectKey(element) !== entry.lastRect) schedule(); }, FLOAT_TRACK_MS);
    const onBlur = () => {
      setTimeout(() => {
        if (top() !== entry || document.hasFocus() || surfaceHover) return;
        entry.dismiss?.();
      }, FLOAT_BLUR_GRACE_MS);
    };
    window.addEventListener("blur", onBlur);
    schedule();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onChange, true);
      element.removeEventListener("focusin", onChange);
      element.removeEventListener("focusout", onChange);
      window.removeEventListener("resize", onChange);
      window.removeEventListener("blur", onBlur);
      clearInterval(track);
      element.removeAttribute(NATIVE_FLOAT_ATTRIBUTE);
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      if (index === stack.length) {
        // 맨 위가 닫혔다 — 아래에 남은 것이 있으면 그것을, 없으면 자식 창을 내린다.
        if (entry.target) clearFloat(entry.target);
        schedule();
      }
    };
  }, [ref, open]);
}

function top(): FloatEntry | null {
  return stack.length > 0 ? stack[stack.length - 1]! : null;
}

function ensureChannel(): BroadcastChannel {
  if (channel) return channel;
  channel = new BroadcastChannel(DESKTOP_BROWSER_FLOAT_CHANNEL);
  channel.onmessage = (event: MessageEvent<SurfaceMessage>) => receive(event.data);
  return channel;
}

function schedule(): void {
  if (scheduled) return;
  scheduled = requestAnimationFrame(() => { scheduled = 0; render(); });
}

function rectKey(element: Element): string {
  const rect = element.getBoundingClientRect();
  return `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
}

/** 메뉴가 겹치는 네이티브 브라우저 자리 — 겹치지 않으면 띄울 까닭이 없다. */
function overlappedTarget(rect: DOMRect): string | null {
  for (const host of document.querySelectorAll<HTMLElement>(`[${NATIVE_FLOAT_TARGET_ATTRIBUTE}]`)) {
    const native = host.getBoundingClientRect();
    if (native.width < 1 || native.height < 1) continue;
    if (rect.right > native.left && rect.left < native.right && rect.bottom > native.top && rect.top < native.bottom) return host.getAttribute(NATIVE_FLOAT_TARGET_ATTRIBUTE);
  }
  return null;
}

function render(): void {
  const entry = top();
  if (!entry) return;
  const { element } = entry;
  if (!element.isConnected) return;
  const rect = element.getBoundingClientRect();
  entry.lastRect = rectKey(element);
  const target = rect.width >= 1 && rect.height >= 1 ? overlappedTarget(rect) : null;
  if (target === null) {
    if (entry.target) clearFloat(entry.target);
    entry.target = null;
    element.removeAttribute(NATIVE_FLOAT_ATTRIBUTE);
    return;
  }
  if (entry.target && entry.target !== target) clearFloat(entry.target);
  entry.target = target;
  if (!element.hasAttribute(NATIVE_FLOAT_ATTRIBUTE)) element.setAttribute(NATIVE_FLOAT_ATTRIBUTE, "pending");
  const revision = ++revisionSeed;
  entry.revision = revision;
  const { html, nodes } = serialize(element, rect);
  entry.nodes = nodes;
  const width = Math.ceil(rect.width) + FLOAT_PAD * 2;
  const height = Math.ceil(rect.height) + FLOAT_PAD * 2;
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
  void fetch(`/api/v1/browser/objectives/${encodeURIComponent(target)}/float`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, x: Math.floor(rect.left) - FLOAT_PAD, y: Math.floor(rect.top) - FLOAT_PAD, width, height }),
  }).catch(() => undefined);
}

function clearFloat(target: string): void {
  channel?.postMessage({ type: "clear" });
  void fetch(`/api/v1/browser/objectives/${encodeURIComponent(target)}/float`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clear: true }),
  }).catch(() => undefined);
}

function receive(message: SurfaceMessage): void {
  if (!message || typeof message !== "object") return;
  if (message.type === "hover") { surfaceHover = message.inside === true; return; }
  const entry = top();
  if (!entry) return;
  if (message.type === "hello") { entry.revision = -1; schedule(); return; }
  if (message.type === "shown") {
    if (message.revision === entry.revision && entry.target) entry.element.setAttribute(NATIVE_FLOAT_ATTRIBUTE, "shown");
    return;
  }
  // 표면이 낡은 그림을 보고 누른 것은 버린다 — 같은 번호가 다른 항목을 가리킬 수 있다.
  if (message.revision !== entry.revision || !Number.isInteger(message.path)) return;
  const node = entry.nodes[message.path];
  if (!(node instanceof HTMLElement) || !entry.element.contains(node)) return;
  if (message.type === "activate") activate(node);
  else if (message.type === "wheel") scrollFrom(node, entry.element, Number(message.dx) || 0, Number(message.dy) || 0);
}

/** 사람이 누른 것과 같은 순서로 원본 요소에 포인터·마우스 사건을 낸다 — mousedown 에서 동작하는 항목도 있다. */
function activate(node: HTMLElement): void {
  const target = node.closest<HTMLElement>("button, a, [role='menuitem'], [role='option'], [role='tab'], label, input, summary") ?? node;
  if ((target as HTMLButtonElement).disabled) return;
  const rect = target.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, view: window };
  target.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
  target.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
  target.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  target.dispatchEvent(new MouseEvent("mouseup", init));
  target.click();
}

function scrollFrom(node: HTMLElement, root: HTMLElement, dx: number, dy: number): void {
  for (let current: HTMLElement | null = node; current; current = current === root ? null : current.parentElement) {
    const style = getComputedStyle(current);
    const scrollY = /(auto|scroll)/u.test(style.overflowY) && current.scrollHeight > current.clientHeight;
    const scrollX = /(auto|scroll)/u.test(style.overflowX) && current.scrollWidth > current.clientWidth;
    if (scrollY || scrollX) { current.scrollBy({ left: dx, top: dy }); return; }
  }
}

/**
 * 메뉴와 그 조상들을 옮긴다. 조상은 껍데기만(`display: contents`) 남겨 조상 선택자와 상속 값이 표면에서도 맞게 하고,
 * 메뉴 자신은 표면의 여백 자리에 고정한다. 각 요소에 번호를 달아 표면이 누른 것을 원본에서 찾게 한다.
 */
function serialize(element: HTMLElement, rect: DOMRect): { html: string; nodes: Element[] } {
  const clone = element.cloneNode(true) as HTMLElement;
  const nodes: Element[] = [];
  const originals = [element, ...element.querySelectorAll("*")];
  const copies = [clone, ...clone.querySelectorAll("*")];
  const active = document.activeElement;
  for (let index = 0; index < originals.length && index < copies.length; index++) {
    const original = originals[index]!;
    const copy = copies[index]!;
    nodes.push(original);
    copy.setAttribute("data-fp", String(index));
    copy.removeAttribute("id");
    if (original === active) copy.setAttribute("data-float-focus", "");
    if (original.scrollTop || original.scrollLeft) copy.setAttribute("data-float-scroll", `${original.scrollLeft},${original.scrollTop}`);
    if (original instanceof HTMLInputElement && copy instanceof HTMLInputElement) copy.setAttribute("value", original.value);
  }
  clone.removeAttribute(NATIVE_FLOAT_ATTRIBUTE);
  const pin = `position:fixed!important;left:${FLOAT_PAD}px!important;top:${FLOAT_PAD}px!important;right:auto!important;bottom:auto!important;margin:0!important;`
    + `width:${rect.width}px!important;height:${rect.height}px!important;max-width:none!important;max-height:none!important;min-width:0!important;min-height:0!important;`
    + "transform:none!important;translate:none!important;animation:none!important;opacity:1!important;visibility:visible!important;";
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
  return { html, nodes };
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
