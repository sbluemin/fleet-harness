import type { DESKTOP_BROWSER_FLOAT_CHANNEL } from "@fleet-console/protocol/desktop";

/**
 * 채널 이름은 값으로 가져오지 않는다 — 표면의 진입 청크가 공용 모듈을 통해 앱 진입 청크를 끌어오면 앱이 이 창에서
 * 통째로 실행된다. 타입이 프로토콜 상수의 리터럴과 같아야 하므로 이름이 어긋나면 타입 검사가 막는다.
 */
const CHANNEL_NAME: typeof DESKTOP_BROWSER_FLOAT_CHANNEL = "fleet-browser-float";

/**
 * Desktop 자식 창 안의 메뉴 표면. Console 창이 보낸 메뉴 모양을 같은 스타일시트로 그리고, 사람이 누른 항목과 휠을 번호로
 * 돌려보낸다. 이 문서는 아무 상태도 갖지 않는다 — 동작은 모두 Console 창의 원본 요소가 한다(`native-float.ts`).
 * React 도 앱도 띄우지 않는다: 자식 창은 메뉴가 열릴 때마다 보였다 감춰지므로 가볍게 둔다.
 */

interface RenderMessage {
  readonly type: "render";
  readonly revision: number;
  readonly html: string;
  readonly width: number;
  readonly height: number;
  readonly styles: { readonly links: readonly string[]; readonly inline: string };
  readonly root: Record<string, string>;
  readonly body: Record<string, string>;
}

const SURFACE_STYLE = [
  "html,body{background:transparent!important;margin:0!important;padding:0!important;overflow:hidden!important;width:100%;height:100%}",
  // 정지한 채 그리되, 자기 전환을 표지(`data-float-motion`)한 표면만 재생한다. 그 표면의 펄스 같은 상시 애니메이션은 계속 멈춘다.
  "*:not([data-float-motion]),*:not([data-float-motion])::before,*:not([data-float-motion])::after,[data-float-motion]::before,[data-float-motion]::after{animation:none!important;transition:none!important}",
  "[data-float-focus]{box-shadow:var(--focus-face)!important}",
].join("\n");

export function startFloatSurface(): void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const host = document.createElement("div");
  document.body.append(host);
  const inline = document.createElement("style");
  const fixed = document.createElement("style");
  fixed.textContent = SURFACE_STYLE;
  document.head.append(inline, fixed);
  let linksKey = "";
  let revision = -1;
  let pendingLinks: Promise<unknown> = Promise.resolve();

  const announce = (): void => {
    if (revision < 0 || document.visibilityState !== "visible") return;
    const shown = revision;
    requestAnimationFrame(() => requestAnimationFrame(() => { if (shown === revision) channel.postMessage({ type: "shown", revision: shown }); }));
  };

  const applyAttributes = (element: Element, next: Record<string, string>): void => {
    for (const attribute of [...element.attributes]) if (!(attribute.name in next)) element.removeAttribute(attribute.name);
    for (const [name, value] of Object.entries(next)) if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };

  const render = (message: RenderMessage): void => {
    applyAttributes(document.documentElement, message.root);
    applyAttributes(document.body, message.body);
    const key = message.styles.links.join("\n");
    if (key !== linksKey) {
      linksKey = key;
      for (const link of document.head.querySelectorAll("link[data-float-style]")) link.remove();
      const loads = message.styles.links.filter((href) => new URL(href, location.href).origin === location.origin).map((href) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.dataset.floatStyle = "";
        const loaded = new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; });
        inline.before(link);
        return loaded;
      });
      pendingLinks = Promise.all(loads);
    }
    if (inline.textContent !== message.styles.inline) inline.textContent = message.styles.inline;
    const current = message.revision;
    void pendingLinks.then(() => {
      if (current < revision) return;
      host.innerHTML = message.html;
      for (const element of host.querySelectorAll<HTMLElement>("[data-float-scroll]")) {
        const [left, top] = (element.dataset.floatScroll ?? "0,0").split(",").map(Number);
        element.scrollLeft = left ?? 0;
        element.scrollTop = top ?? 0;
      }
      revision = current;
      announce();
    });
  };

  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as ({ readonly type?: string } & Partial<Omit<RenderMessage, "type">>) | null;
    if (!message || typeof message !== "object") return;
    if (message.type === "render" && typeof message.html === "string" && typeof message.revision === "number") render(message as RenderMessage);
    else if (message.type === "clear") { host.replaceChildren(); revision = -1; }
  };

  const pathOf = (target: EventTarget | null): number | null => {
    const element = target instanceof Element ? target.closest<HTMLElement>("[data-fp]") : null;
    const path = element ? Number(element.dataset.fp) : NaN;
    return Number.isInteger(path) ? path : null;
  };
  // 이 창은 포커스를 받지 않는다 — 누름이 선택·포커스를 만들지 않게 막고, 항목은 Console 창의 원본이 누른다.
  for (const type of ["pointerdown", "mousedown"] as const) document.addEventListener(type, (event) => event.preventDefault(), true);
  document.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const path = pathOf(event.target);
    if (path !== null && revision >= 0) channel.postMessage({ type: "activate", revision, path });
  }, true);
  document.addEventListener("wheel", (event) => {
    event.preventDefault();
    const path = pathOf(event.target);
    if (path !== null && revision >= 0) channel.postMessage({ type: "wheel", revision, path, dx: event.deltaX, dy: event.deltaY });
  }, { capture: true, passive: false });
  // 표면 안의 진입·이탈을 번호로 알린다 — 원본의 enter·leave 처리기(호버로 열린 표면의 닫힘 타이머 등)가 같은 순서로 듣는다.
  for (const kind of ["over", "out"] as const) {
    document.addEventListener(kind === "over" ? "pointerover" : "pointerout", (event) => {
      const path = pathOf(event.target);
      if (path === null || revision < 0) return;
      channel.postMessage({ type: "pointer", revision, kind, path, related: pathOf(event.relatedTarget) });
    }, true);
  }
  document.addEventListener("pointerenter", () => channel.postMessage({ type: "hover", inside: true }), true);
  document.documentElement.addEventListener("pointerleave", () => channel.postMessage({ type: "hover", inside: false }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") channel.postMessage({ type: "hover", inside: false });
    announce();
  });
  channel.postMessage({ type: "hello" });
}
