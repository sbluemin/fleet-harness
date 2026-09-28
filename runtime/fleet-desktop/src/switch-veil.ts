import type { WebContents, WebContentsView } from "electron";

import type { DesktopShellWindow } from "./shell-window.js";

/**
 * 콘솔을 갈아타는 동안 창이 끊겨 보이지 않게 하는 덮개.
 *
 * 다른 콘솔로 가는 일은 문서를 통째로 바꾸는 일이라, 그대로 두면 옛 화면이 사라진 뒤 새 화면이 서기까지
 * 빈 셸과 기본 배경이 한 박자 비친다. 떠나기 직전의 화면을 찍어 그 위에 덮고, 새 화면이 "섰다"고 말할 때
 * 걷는다. 덮개는 수동적인 판이다 — 항해하지 않고 창을 열지 않으며, 떠 있는 동안 입력을 삼킨다.
 *
 * 스냅샷은 메인 메모리와 이 렌더러에만 머물고 걷는 즉시 지운다. 디스크와 로그에는 남기지 않는다.
 */

/**
 * 새 화면이 본문을 그렸다는 표식. Console이 제목 끝에 붙이고(core/client/src/integration/desktop-shell.ts의
 * CONSOLE_READY_TITLE_MARK) 여기서 `page-title-updated`로 받는다 — 렌더러와 셸 사이에 새 통로를 두지 않고 문서가 셸에게 말하는
 * 유일한 길이다. 보이지 않는 문자라 제목을 그대로 보여 주는 곳에서도 글자가 늘지 않는다.
 */
export const CONSOLE_READY_TITLE_MARK = "⁣";

/** 표식을 모르는 옛 Console을 위한 상한. 본문이 선 뒤 신호가 올 여유이자, 낡은 스냅샷을 보이는 최대 시간이다. */
export const SWITCH_VEIL_FALLBACK_MS = 1_200;
/** 로드 자체가 멈춘 경우 — 덮개가 창을 영영 가리지 않도록 끝을 둔다. */
const SWITCH_VEIL_HARD_CAP_MS = 15_000;
/** 덮개를 세우는 데 쓸 수 있는 시간. 넘기면 덮개 없이 전환한다 — 전환을 늦추면서까지 가릴 일은 아니다. */
const COVER_BUDGET_MS = 400;
/**
 * 표식을 받고 걷기 시작할 때까지 두는 짧은 틈. 본문 DOM이 선 뒤에도 무거운 첫 커밋이 끝나기까지 한 프레임쯤 빈 셸이
 * 칠해질 수 있어(실측: 표식 직후 1프레임), 그 프레임이 페이드에 비치지 않게 한다.
 */
const READY_SETTLE_MS = 50;
const FADE_MS = 120;

const VEIL_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  "<!doctype html><html><head><meta charset=\"utf-8\"><style>"
  + "html,body{margin:0;height:100%;overflow:hidden;background:transparent}"
  + "img{display:block;width:100vw;height:100vh}"
  + "body.fading img{transition:opacity " + FADE_MS + "ms linear;opacity:0}"
  + "</style></head><body><img id=\"snapshot\" alt=\"\"></body></html>",
)}`;

export interface SwitchVeilDependencies {
  /** 투명 배경의 샌드박스 뷰. 항해·창 열기는 여기서 막는다. */
  readonly createView: () => WebContentsView;
  readonly log?: (message: string) => void;
}

export interface SwitchVeil {
  /** 창이 생길 때 한 번 — 덮개 렌더러를 미리 띄워 Console 뒤에 세워 둔다. */
  mount(shell: DesktopShellWindow): void;
  /**
   * 콘솔 전환 한 번을 덮는다. `load`가 끝나도 덮개는 새 화면의 준비 표식(또는 상한)까지 남고,
   * `load`가 실패하면 곧바로 걷힌다 — 오류 화면을 스냅샷 뒤에 숨기지 않는다.
   */
  around(url: string, load: () => Promise<void>): Promise<void>;
  unmount(): void;
}

type Phase = "idle" | "covering" | "fading";

export function createSwitchVeil(deps: SwitchVeilDependencies): SwitchVeil {
  let shell: DesktopShellWindow | null = null;
  let view: WebContentsView | null = null;
  let pageReady: Promise<boolean> = Promise.resolve(false);
  let phase: Phase = "idle";
  /** 가장 최근 전환의 번호. 앞선 전환의 늦은 신호가 뒤 전환의 덮개를 걷지 못하게 한다. */
  let sequence = 0;
  let stopWatching: (() => void) | null = null;

  function contentsOf(target: WebContentsView | null): WebContents | null {
    const contents = target?.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  async function cover(current: DesktopShellWindow): Promise<boolean> {
    // 이미 덮여 있으면(연달아 전환, 실패 뒤 집으로 복귀) 다시 찍지 않는다 — 지금 Console은 반쯤 바뀐 화면일 수 있다.
    if (phase === "covering") return true;
    const veilContents = contentsOf(view);
    if (!veilContents || !(await pageReady)) return false;
    try {
      const image = await withinBudget(current.consoleContents.capturePage());
      if (image.isEmpty()) return false;
      const source = `data:image/jpeg;base64,${image.toJPEG(92).toString("base64")}`;
      // 뒤에 세워 둔 채로 칠하고, 칠해진 뒤에 올린다 — 올린 순간 보이는 것은 언제나 스냅샷이다.
      await withinBudget(veilContents.executeJavaScript(showScript(source)));
      phase = "covering";
      current.stack.raiseSwitchVeil();
      return true;
    } catch (error) {
      deps.log?.(`switch veil skipped: ${describe(error)}`);
      phase = "idle";
      void clear();
      return false;
    }
  }

  async function lower(reason: string, epoch: number): Promise<void> {
    if (epoch !== sequence || phase !== "covering") return;
    phase = "fading";
    stopWatching?.();
    stopWatching = null;
    const veilContents = contentsOf(view);
    try {
      if (veilContents) await veilContents.executeJavaScript(FADE_SCRIPT);
    } catch { /* 걷는 일은 페이드 없이도 끝나야 한다. */ }
    // 페이드 사이에 다음 전환이 시작됐다면 그 전환이 덮개를 가진다.
    if (epoch !== sequence || phase !== "fading") return;
    phase = "idle";
    try { shell?.stack.lowerSwitchVeil(); } catch { /* 창이 먼저 닫혔다. */ }
    await clear();
    deps.log?.(`switch veil lowered reason=${reason}`);
  }

  async function clear(): Promise<void> {
    try { await contentsOf(view)?.executeJavaScript(CLEAR_SCRIPT); } catch { /* 렌더러가 이미 없다. */ }
  }

  /** 새 문서가 목적지에 도착한 뒤의 표식만 믿는다. 떠나는 문서의 제목 변경은 도착 전에 일어난다. */
  function watch(contents: WebContents, targetOrigin: string, epoch: number): () => void {
    let arrived = false;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const hardCap = setTimeout(() => void lower("timeout", epoch), SWITCH_VEIL_HARD_CAP_MS);
    const onNavigate = (_event: unknown, url: string): void => {
      if (originOf(url) === targetOrigin) arrived = true;
    };
    const onTitle = (_event: unknown, title: string): void => {
      if (!arrived || !title.endsWith(CONSOLE_READY_TITLE_MARK) || settle !== null) return;
      settle = setTimeout(() => void lower("ready", epoch), READY_SETTLE_MS);
    };
    const onFinish = (): void => {
      if (!arrived || fallback !== null) return;
      fallback = setTimeout(() => void lower("fallback", epoch), SWITCH_VEIL_FALLBACK_MS);
    };
    const onFail = (_event: unknown, code: number, _description: string, _url: string, isMainFrame: boolean): void => {
      // -3(ERR_ABORTED)은 다음 항해가 앞 항해를 대신했다는 뜻이지 실패가 아니다.
      if (isMainFrame && code !== -3) void lower("failed", epoch);
    };
    contents.on("did-navigate", onNavigate);
    contents.on("page-title-updated", onTitle);
    contents.on("did-finish-load", onFinish);
    contents.on("did-fail-load", onFail);
    return () => {
      clearTimeout(hardCap);
      if (fallback !== null) clearTimeout(fallback);
      if (settle !== null) clearTimeout(settle);
      contents.removeListener("did-navigate", onNavigate);
      contents.removeListener("page-title-updated", onTitle);
      contents.removeListener("did-finish-load", onFinish);
      contents.removeListener("did-fail-load", onFail);
    };
  }

  return {
    mount(next) {
      if (shell === next && view) return;
      this.unmount();
      shell = next;
      try {
        view = deps.createView();
      } catch (error) {
        // 덮개가 없어도 전환은 그대로 된다 — 끊김이 보일 뿐이다.
        deps.log?.(`switch veil unavailable: ${describe(error)}`);
        view = null;
        return;
      }
      next.stack.mountSwitchVeil(view);
      pageReady = view.webContents.loadURL(VEIL_PAGE).then(() => true, (error: unknown) => {
        deps.log?.(`switch veil page failed: ${describe(error)}`);
        return false;
      });
    },

    async around(url, load) {
      const current = shell;
      const targetOrigin = originOf(url);
      if (!current || current.isDestroyed() || targetOrigin === null) return load();
      const epoch = ++sequence;
      // 앞선 전환의 감시는 여기서 끝난다 — 그 신호는 이제 이 덮개의 것이 아니다.
      stopWatching?.();
      stopWatching = null;
      if (phase === "fading") phase = "idle";
      if (!(await cover(current))) return load();
      stopWatching = watch(current.consoleContents, targetOrigin, epoch);
      try {
        await load();
      } catch (error) {
        await lower("load_failed", epoch);
        throw error;
      }
    },

    unmount() {
      stopWatching?.();
      stopWatching = null;
      phase = "idle";
      sequence += 1;
      try { shell?.stack.unmountSwitchVeil(); } catch { /* 창이 먼저 닫혔다. */ }
      const contents = contentsOf(view);
      try { contents?.close(); } catch { /* 이미 죽은 렌더러. */ }
      view = null;
      shell = null;
      pageReady = Promise.resolve(false);
    },
  };
}

function showScript(source: string): string {
  // 창이 가려져 rAF가 멈춰도 막히지 않게 짧은 시간 상한과 경주시킨다.
  return `(async () => {
    const image = document.getElementById("snapshot");
    document.body.className = "";
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = ${JSON.stringify(source)}; });
    await Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
    return true;
  })()`;
}

const FADE_SCRIPT = `(async () => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
  document.body.className = "fading";
  await new Promise((resolve) => setTimeout(resolve, ${FADE_MS + 20}));
  return true;
})()`;

const CLEAR_SCRIPT = `(() => {
  const image = document.getElementById("snapshot");
  image.removeAttribute("src");
  document.body.className = "";
  return true;
})()`;

function withinBudget<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error("switch_veil_budget")), COVER_BUDGET_MS)),
  ]);
}

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
