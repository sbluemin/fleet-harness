import type { Rectangle, WebContents, WebContentsView } from "electron";
import type { DesktopShellWindow } from "./shell-window.js";

export interface BrowserPane {
  readonly host: DesktopShellWindow;
  readonly contents: WebContents;
  readonly view: WebContentsView;
  bounds(): Rectangle;
  show(): void;
  focus(): void;
  dispose(): void;
}

/** 경계와 크롬은 셸의 형제 뷰다. 네이티브 페이지까지 같은 main 틱에서 다시 놓는다. */
/** 칸이 열릴 때 폭이 0에서 선호 폭까지 자라는 시간 — Console 글리프 이동·칸의 닫기 X 등장(browser-panel.css)과 같은 길이다. */
export const BROWSER_PANE_OPEN_MS = 200;

export function createBrowserPane(host: DesktopShellWindow, chrome: WebContentsView, divider: WebContentsView, changed: () => void, width: { value: number }, options: { readonly animate?: boolean } = {}): BrowserPane {
  let disposed = false;
  // 열림 진행도 — 1이면 끝난 상태다. 폭 계산이 이 값을 곱할 뿐이라 끌기·창 리사이즈와 같은 한 틱 경로에서 페이지 뷰까지 따라간다.
  let opened = options.animate === true ? 0 : 1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let drag: { screenX: number; width: number } | null = null;
  let current: Rectangle = { x: 0, y: 0, width: 1, height: 1 };
  const layout = (): void => {
    if (disposed || host.isDestroyed()) return;
    const content = host.base.getContentBounds();
    // Console은 600 DIP를 먼저 지킨다. 창이 좁아질 때 선호 폭을 덮어쓰지 않고 칸부터 줄인다.
    const target = Math.min(Math.max(320, width.value), Math.max(1, content.width - 600 - 8));
    const paneWidth = opened >= 1 ? target : Math.max(1, Math.round(target * opened));
    const left = Math.max(1, content.width - paneWidth - 8);
    current = { x: left + 8, y: 0, width: paneWidth, height: Math.max(1, content.height) };
    host.stack.layoutBrowserPane(chrome, divider, left, current);
    changed();
  };
  const message = (details: { message: string; frame: { url: string } | null }): void => {
    // 이 수동 문서의 고정 frame만 읽는다. Console/페이지 로그는 이 listener에 연결되지 않는다.
    if (disposed || details.frame !== divider.webContents.mainFrame || details.frame.url !== DIVIDER_URL) return;
    let value: unknown;
    try { value = JSON.parse(details.message); } catch { return; }
    if (!Array.isArray(value) || value[0] !== "fleet-pane" || value.length !== 3) return;
    const [, action, x] = value;
    if (typeof x !== "number" || !Number.isFinite(x)) return;
    if (action === "start") drag = { screenX: x, width: current.width };
    else if (action === "move" && drag) {
      width.value = Math.max(320, Math.min(host.base.getContentBounds().width - 608, drag.width + drag.screenX - x));
      layout();
    } else if (action === "end") drag = null;
    else if (action === "key") { width.value = Math.max(320, current.width + x); layout(); }
  };
  divider.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  divider.webContents.on("will-navigate", (event) => event.preventDefault());
  divider.webContents.on("will-attach-webview", (event) => event.preventDefault());
  divider.webContents.on("console-message", message);
  host.base.on("resize", layout);
  const cancel = () => { drag = null; };
  host.base.on("blur", cancel);
  void divider.webContents.loadURL(DIVIDER_URL).catch(() => undefined);
  layout();
  if (opened < 1) {
    const started = Date.now();
    const step = (): void => {
      timer = null;
      if (disposed) return;
      const t = Math.min(1, (Date.now() - started) / BROWSER_PANE_OPEN_MS);
      opened = 1 - (1 - t) ** 3;
      if (t >= 1) opened = 1;
      layout();
      if (opened < 1) timer = setTimeout(step, 8);
    };
    timer = setTimeout(step, 8);
  }
  return {
    host, contents: chrome.webContents, view: chrome,
    bounds: () => current,
    show: layout,
    focus: () => { if (!disposed && !chrome.webContents.isDestroyed()) chrome.webContents.focus(); },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      drag = null;
      if (timer) clearTimeout(timer);
      timer = null;
      host.base.removeListener("resize", layout);
      host.base.removeListener("blur", cancel);
      divider.webContents.removeListener("console-message", message);
      host.stack.removeBrowserPane(chrome, divider);
      if (!divider.webContents.isDestroyed()) divider.webContents.close();
    },
  };
}

// 셸의 수동 문서는 Node·preload·IPC 없이 pointer capture와 진단 이벤트만 쓴다.
const DIVIDER_HTML = `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;user-select:none;cursor:col-resize;background:light-dark(#e4e4e5,#202023)}
body{box-sizing:border-box;border-left:1px solid light-dark(#c8c8ca,#39393e);border-right:1px solid light-dark(#c8c8ca,#39393e);box-shadow:inset 2px 0 4px #0002;touch-action:none}
body:hover,body:focus-visible{background:light-dark(#d2d2d5,#35353b);outline:none}
</style><body role="separator" aria-label="Resize browser pane" aria-orientation="vertical" tabindex="0"><script>
const send=(action,x)=>console.log(JSON.stringify(['fleet-pane',action,x]));
let pointer=null;
addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();document.body.setPointerCapture(e.pointerId);pointer=e.pointerId;send('start',e.screenX)});
addEventListener('pointermove',e=>{if(pointer===e.pointerId)send('move',e.screenX)});
const end=e=>{if(pointer!==e.pointerId)return;pointer=null;send('end',e.screenX)};
addEventListener('pointerup',end);addEventListener('pointercancel',end);addEventListener('lostpointercapture',end);
addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();send('key',(e.key==='ArrowLeft'?1:-1)*(e.shiftKey?64:16))}});
</script>`;
const DIVIDER_URL = `data:text/html;charset=utf-8,${encodeURIComponent(DIVIDER_HTML)}`;
