import type { WebContentsView } from "electron";

import type { EntryLanguage } from "./launch-controller.js";
import type { DesktopShellWindow } from "./shell-window.js";

/**
 * 호스트를 갈아타는 동안 옛 화면을 붙잡아 두는 판.
 *
 * 창을 다른 콘솔로 보내면 Chromium은 커밋하는 순간 옛 프레임을 버린다. 새 콘솔은 그 뒤에야 상단 띠만 있는 부팅
 * 셸을 칠하고, 설정·플러그인·목록을 차례로 받은 다음 사이드바와 본문을 한꺼번에 세운다 — 사람이 「깜빡임」으로
 * 보는 것은 그 빈 셸과 점프다. 그래서 적재 직전에 지금 화면을 한 장 떠서 Console 위에 얹어 두고, 새 콘솔이
 * 첫 목록을 칠했다고 알리면(`console-ready` 창 명령) 그 판을 흐려 걷는다. 아래에서 이미 다 그린 새 콘솔이
 * 그만큼 드러나므로 교차 전환이 된다.
 *
 * 판은 진입 화면과 같은 수동 로컬 뷰다 — 원격 렌더러는 이 판을 참조할 수도, 그 위의 글자를 바꿀 수도 없다.
 * 글자는 main이 executeJavaScript로 들여보내고 textContent로만 들어간다.
 *
 * 판만 남는 상태는 없어야 한다. 그래서 걷는 길이 여럿이고 전부 같은 함수로 모인다: 새 콘솔의 ready, ready를
 * 모르는 옛 콘솔을 위한 상한(적재 끝 + 1.5초), 실패(경고를 잠시 보인 뒤), 렌더러 사망·창 종료(즉시), 그리고
 * 무슨 일이 있어도 넘지 않는 천장. 붙잡는 일 자체가 늦거나 실패하면 붙잡지 않고 지나간다 — 판은 전환의
 * 부가 동작이지 조건이 아니다.
 */

export type SwitchTargetKind = "home" | "local" | "remote";

export interface SwitchTarget {
  /** 창이 갈 콘솔. ready와 적재 끝은 이 origin의 것만 받는다. */
  readonly origin: string;
  readonly kind: SwitchTargetKind;
  /** 원격일 때 사용자가 집의 목록에서 보는 이름. 모르면 null. */
  readonly label?: string | null;
  /** 앞선 전환이 실패해 집으로 돌아가는 길인가. 이때는 쥔 화면을 그대로 두고 알약만 경고로 바꾼다. */
  readonly recovering?: boolean;
}

export interface SwitchHoldDeps {
  readonly shell: () => DesktopShellWindow | null;
  /** 샌드박스·Node 없는 투명 뷰. 항해 울타리와 팝업 거부는 만드는 쪽이 친다. */
  readonly createView: () => WebContentsView;
  readonly pagePath: string;
  readonly lang: EntryLanguage;
  /** 판과 알약의 극성 — 붙잡는 순간 보이는 콘솔의 것. */
  readonly scheme: () => "dark" | "light";
  /** 콘솔 맨 위 줄의 높이(DIP). 알약은 그 아래에, 창 끌기 자리는 그 안에 둔다. */
  readonly band: () => number;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface SwitchHold {
  /** 전환 하나를 시작한다. 앞선 전환이 아직 쥐고 있으면 그 판을 이어받는다. 시도 번호를 돌려준다. */
  begin(target: SwitchTarget): number;
  /** 지금 화면을 붙잡는다. 적재 직전에 부르고, 늦으면 붙잡지 않고 돌아온다 — 항해를 막지 않는다. */
  freeze(): Promise<void>;
  /** 창이 그 콘솔의 문서를 다 받았다. ready를 모르는 콘솔을 위한 상한이 여기서 시작한다. */
  loaded(origin: string): void;
  /** 그 콘솔이 첫 목록을 칠했다. */
  ready(origin: string): void;
  /** 그 시도가 실패했다. 경고를 잠시 보인 뒤 걷는다. 뒤이어 집으로 돌아가는 시도가 오면 판은 그대로 이어진다. */
  fail(attempt: number): void;
  /** 렌더러 사망·창 종료 — 기다리지 않고 걷는다. */
  release(reason: string): void;
  /** 판이 쥐고 있는 동안에는 미뤘다가 걷는 순간 적용한다(타이틀바·신호등). 아니면 바로 적용한다. */
  atReveal(apply: () => void): void;
}

/** 이보다 빨리 끝나는 전환에서는 아무 표시도 없다. */
export const SWITCH_PILL_DELAY_MS = 400;
/** ready를 보내지 않는 옛 콘솔 — 적재가 끝나고 이만큼 지나면 걷는다. */
export const SWITCH_READY_CAP_MS = 1_500;
/** switch.css `--fade`와 짝. */
export const SWITCH_FADE_MS = 220;
/** 경고 알약을 읽을 수 있을 만큼은 둔다 — 집이 금방 다 그려도 이보다 먼저 걷지 않는다. */
export const SWITCH_WARN_MIN_MS = 1_400;
/**
 * 붙잡는 데 이보다 오래 걸리면 붙잡지 않고 항해한다. 실측(1800×1200): 판 문서 적재는 시작 뒤 약 90ms, capturePage
 * 5–18ms, JPEG 7–11ms에 판이 두 프레임 합성되는 시간을 더한 값의 두 배 남짓이다. 붙잡기가 *실패*하면 이 예산을
 * 기다리지 않고 곧바로 항해한다 — 예산은 끝나지 않는 단계에만 쓰인다.
 */
const SWITCH_FREEZE_BUDGET_MS = 250;
/** 무슨 일이 있어도 판이 이보다 오래 서 있지 않는다. */
const SWITCH_HOLD_CEILING_MS = 15_000;
/** 수백 밀리초 동안만 보이는 판이다 — 무손실보다 빨리 만드는 쪽을 고른다. */
const FRAME_JPEG_QUALITY = 90;
const MAX_LABEL_CHARS = 48;
/** 판이 두 프레임 합성되기를 기다리는 상한. */
const FIRST_FRAMES_TIMEOUT_MS = 120;

interface Attempt {
  readonly id: number;
  readonly target: SwitchTarget;
  readonly label: string;
  /** 집으로 돌아가는 시도일 때, 실패한 앞 시도의 이름. */
  readonly failedLabel: string | null;
}

interface Held {
  readonly view: WebContentsView;
  readonly shell: DesktopShellWindow;
  readonly layout: () => void;
  /** 판의 문서가 적재됐는가. 전환이 시작되자마자 미리 띄워 둔다 — 렌더러를 띄우는 시간을 붙잡는 시간에서 뺀다. */
  page: Promise<boolean>;
  frozen: Promise<boolean> | null;
  presented: boolean;
  revealing: boolean;
  disposed: boolean;
  frozenAt: number;
  /** 판이 만들어진 시각과 붙잡기가 지금 머물러 있는 단계 — 예산을 넘겼을 때 어디서 막혔는지 남긴다. */
  readonly raisedAt: number;
  stage: string;
  /** 판에 들여보내는 갱신은 보낸 차례대로 적용돼야 한다. */
  chain: Promise<unknown>;
}

interface HoldUpdate {
  readonly lang?: EntryLanguage;
  readonly scheme?: "dark" | "light";
  readonly band?: number;
  readonly frame?: string;
  readonly pill?: { readonly tone: "busy" | "warn"; readonly text: string } | null;
  readonly reveal?: boolean;
}

const COPY: Record<EntryLanguage, {
  readonly thisComputer: string;
  readonly otherConsole: string;
  readonly connecting: (label: string) => string;
  readonly returning: string;
  readonly failed: (label: string) => string;
  readonly failedReturning: (label: string) => string;
}> = {
  ko: {
    thisComputer: "이 컴퓨터",
    otherConsole: "이 컴퓨터의 다른 콘솔",
    connecting: (label) => `${label}에 연결하는 중`,
    returning: "이 컴퓨터로 돌아가는 중",
    failed: (label) => `${label}에 연결하지 못했습니다`,
    failedReturning: (label) => `${label}에 연결하지 못했습니다 · 이 컴퓨터로 돌아갑니다`,
  },
  en: {
    thisComputer: "this computer",
    otherConsole: "another console on this computer",
    connecting: (label) => `Connecting to ${label}…`,
    returning: "Returning to this computer…",
    failed: (label) => `Couldn't connect to ${label}`,
    failedReturning: (label) => `Couldn't connect to ${label} · returning to this computer`,
  },
};

// 판의 HTML은 CSP로 스크립트를 막는다. 이 코드가 main이 들여보내는 유일한 코드이며, 글자는 textContent로만 들어간다.
const HOLD_RENDERER = String.raw`(() => {
  const update = __HOLD_UPDATE__;
  const root = document.documentElement;
  if (update.lang) root.setAttribute("lang", update.lang);
  if (update.scheme) root.setAttribute("data-scheme", update.scheme);
  if (typeof update.band === "number") {
    root.style.setProperty("--band", update.band + "px");
    root.style.setProperty("--pill-top", (update.band + 10) + "px");
  }
  if (update.pill === null) root.classList.remove("has-pill");
  else if (update.pill) {
    const text = document.getElementById("pill-text");
    root.setAttribute("data-tone", update.pill.tone);
    if (text) text.textContent = update.pill.text;
    root.classList.add("has-pill");
  }
  if (update.reveal) root.classList.add("is-revealing");
  if (typeof update.frame !== "string") return true;
  const frame = document.getElementById("frame");
  if (!frame) return false;
  // decode()는 컴포지터 프레임에 묶여 있어 판이 가려지면 끝나지 않을 수 있다. 적재(load)만 기다리고, 칠할 때
  // 동기로 풀게 해 첫 프레임에 빈 판이 서지 않게 한다.
  frame.decoding = "sync";
  return new Promise((resolve) => {
    frame.onload = () => resolve(true);
    frame.onerror = () => resolve(false);
    frame.src = update.frame;
  });
})();`;

/** 판이 한 번 합성된 뒤에 항해해야 커밋 순간의 빈 프레임이 판 아래로 숨는다. */
const TWO_FRAMES = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";

export function createSwitchHold(deps: SwitchHoldDeps): SwitchHold {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
  const copy = COPY[deps.lang];
  const log = (message: string): void => deps.log?.(`host switch hold ${message}`);

  let sequence = 0;
  let attempt: Attempt | null = null;
  let current: Held | null = null;
  let deferredChrome: (() => void) | null = null;
  let warnAt: number | null = null;
  let pillTimer: ReturnType<typeof setTimeout> | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (timer: ReturnType<typeof setTimeout> | null): null => {
    if (timer !== null) clearTimer(timer);
    return null;
  };
  const clearAttemptTimers = (): void => {
    pillTimer = cancel(pillTimer);
    capTimer = cancel(capTimer);
    revealTimer = cancel(revealTimer);
  };

  const runDeferredChrome = (): void => {
    const apply = deferredChrome;
    deferredChrome = null;
    if (!apply) return;
    try { apply(); } catch (error) { log(`chrome apply failed: ${describe(error)}`); }
  };

  const push = (held: Held, update: HoldUpdate): Promise<unknown> => {
    held.chain = held.chain
      .then(() => held.disposed ? false : held.view.webContents.executeJavaScript(holdScript(update)))
      .catch(() => false);
    return held.chain;
  };

  function dispose(held: Held, reason: string): void {
    if (held.disposed) return;
    held.disposed = true;
    if (current === held) {
      current = null;
      ceilingTimer = cancel(ceilingTimer);
      revealTimer = cancel(revealTimer);
      warnAt = null;
    }
    try { held.shell.base.off("resize", held.layout); } catch { /* 이미 사라진 창. */ }
    try { if (!held.shell.isDestroyed()) held.shell.stack.removeHold(held.view); } catch { /* 창이 먼저 닫혔다. */ }
    try { held.view.webContents.close(); } catch { /* 이미 죽은 렌더러. */ }
    // 미뤄 둔 타이틀바·신호등은 판이 어떻게 걷히든 잃지 않는다.
    runDeferredChrome();
    if (held.presented) log(`removed reason=${reason}`);
  }

  function raise(): Held | null {
    const shell = deps.shell();
    // 보이지 않는 창에서는 떠 둘 화면도, 깜빡일 화면도 없다.
    if (!shell || shell.isDestroyed() || !shell.base.isVisible() || shell.base.isMinimized()) return null;
    let view: WebContentsView;
    try {
      view = deps.createView();
    } catch (error) {
      log(`skipped reason=create_failed detail=${describe(error)}`);
      return null;
    }
    const layout = (): void => { try { view.setBounds(shell.stack.layoutConsole()); } catch { /* 창이 먼저 닫혔다. */ } };
    layout();
    // Console 뒤에 미리 붙인다 — 창에 붙지 않은 뷰는 숨은 위젯이라 그 위의 이미지 적재·프레임 대기가 끝나지 않는다.
    try {
      shell.stack.parkHold(view);
      shell.base.on("resize", layout);
    } catch (error) {
      log(`skipped reason=park_failed detail=${describe(error)}`);
      try { view.webContents.close(); } catch { /* 이미 죽은 렌더러. */ }
      return null;
    }
    const raisedAt = now();
    const held: Held = { view, shell, layout, page: Promise.resolve(false), frozen: null, presented: false, revealing: false, disposed: false, frozenAt: 0, raisedAt, stage: "page", chain: Promise.resolve() };
    const page = view.webContents.loadFile(deps.pagePath).then(() => true, (error: unknown) => {
      // 판을 걷으면서 적재 중인 문서를 닫은 경우도 여기로 온다 — 그때는 실패가 아니다.
      if (!held.disposed) log(`skipped reason=page_failed detail=${describe(error)}`);
      return false;
    });
    held.page = page;
    held.chain = page;
    return held;
  }

  function freezeHeld(held: Held, attemptId: number): Promise<boolean> {
    if (held.frozen) return held.frozen;
    const started = now();
    held.frozen = (async (): Promise<boolean> => {
      // 단계별 소요(ms). 미션 재측정은 이 한 줄로 어느 단계가 늦는지 가린다.
      const spent: Record<string, number> = {};
      let mark = now();
      const step = (name: string, next: string): void => {
        const at = now();
        spent[name] = at - mark;
        mark = at;
        held.stage = next;
      };
      try {
        held.stage = "page";
        if (!(await held.page) || held.disposed) return false;
        step("page", "capture");
        const image = await held.shell.consoleContents.capturePage();
        if (held.disposed) return false;
        if (image.isEmpty()) throw new Error("capture_empty");
        step("capture", "encode");
        const frame = `data:image/jpeg;base64,${image.toJPEG(FRAME_JPEG_QUALITY).toString("base64")}`;
        step("encode", "frame");
        const loaded = await push(held, { lang: deps.lang, scheme: deps.scheme(), band: deps.band(), frame });
        if (held.disposed) return false;
        if (loaded !== true) throw new Error("frame_load_failed");
        step("frame", "present");
        held.shell.stack.presentHold(held.view);
        held.presented = true;
        step("present", "frames");
        // 판이 Console 앞으로 나온 뒤 두 프레임 합성되기를 기다린다. 가려진 창에서는 프레임이 돌지 않으므로 끝을 둔다.
        let settle: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          held.view.webContents.executeJavaScript(TWO_FRAMES).catch(() => false),
          new Promise((resolve) => { settle = setTimer(() => resolve(false), FIRST_FRAMES_TIMEOUT_MS); }),
        ]);
        cancel(settle);
        if (held.disposed) return false;
        step("frames", "frozen");
        held.frozenAt = now();
        ceilingTimer = cancel(ceilingTimer);
        ceilingTimer = setTimer(() => reveal("ceiling"), SWITCH_HOLD_CEILING_MS);
        log(`stage attempt=${attemptId} pageReady=${started - held.raisedAt + (spent.page ?? 0)} page=${spent.page} capture=${spent.capture} encode=${spent.encode} frame=${spent.frame} present=${spent.present} frames=${spent.frames} total=${held.frozenAt - started}`);
        log(`frozen attempt=${attemptId} totalMs=${held.frozenAt - started}`);
        return true;
      } catch (error) {
        log(`skipped reason=freeze_failed attempt=${attemptId} stage=${held.stage} detail=${describe(error)}`);
        dispose(held, "freeze_failed");
        return false;
      }
    })();
    return held.frozen;
  }

  function connectingText(target: Attempt): string {
    return target.target.kind === "home" ? copy.returning : copy.connecting(target.label);
  }

  function showPill(): void {
    pillTimer = null;
    const pending = attempt;
    const held = current;
    if (!pending || !held || held.disposed || held.revealing) return;
    // 아직 적재 전이라도 붙잡는다 — 알약은 옛 콘솔 위가 아니라 이 판 위에만 선다.
    void freezeHeld(held, pending.id).then((frozen) => {
      if (!frozen || attempt !== pending || held.revealing || held.disposed || warnAt !== null) return;
      void push(held, { pill: { tone: "busy", text: connectingText(pending) } });
      log(`pill attempt=${pending.id} tone=busy`);
    });
  }

  function reveal(reason: string): void {
    const held = current;
    if (!held || held.disposed || held.revealing) {
      if (!held) attempt = null;
      return;
    }
    if (!held.presented) {
      attempt = null;
      clearAttemptTimers();
      dispose(held, reason);
      return;
    }
    // 경고는 읽을 수 있을 만큼 둔다. 천장만은 기다리지 않는다.
    if (warnAt !== null && reason !== "ceiling") {
      const remaining = warnAt + SWITCH_WARN_MIN_MS - now();
      if (remaining > 0) {
        revealTimer = cancel(revealTimer);
        revealTimer = setTimer(() => { revealTimer = null; reveal(reason); }, remaining);
        return;
      }
    }
    held.revealing = true;
    const revealed = attempt;
    attempt = null;
    clearAttemptTimers();
    ceilingTimer = cancel(ceilingTimer);
    // 새 콘솔의 타이틀바·신호등은 판이 흐려지기 시작하는 순간 같이 바뀐다.
    runDeferredChrome();
    void push(held, { reveal: true });
    log(`reveal attempt=${revealed?.id ?? "none"} reason=${reason} heldMs=${now() - held.frozenAt}`);
    setTimer(() => dispose(held, reason), SWITCH_FADE_MS + 40);
  }

  return {
    begin(target) {
      const previous = attempt;
      const label = labelFor(target);
      const id = ++sequence;
      attempt = { id, target: { ...target, origin: originOf(target.origin) }, label, failedLabel: target.recovering ? previous?.label ?? copy.otherConsole : null };
      clearAttemptTimers();
      // 흐려지는 중에 다시 갈아타면 그 판은 버리고 지금 화면을 새로 붙잡는다.
      if (current?.revealing) dispose(current, "superseded");
      if (target.recovering && current?.presented) {
        warnAt = now();
        void push(current, { pill: { tone: "warn", text: copy.failedReturning(attempt.failedLabel ?? copy.otherConsole) } });
        log(`pill attempt=${id} tone=warn`);
      } else {
        warnAt = null;
        if (!current) current = raise();
        pillTimer = setTimer(showPill, SWITCH_PILL_DELAY_MS);
      }
      log(`begin attempt=${id} kind=${target.kind}${target.recovering ? " recovering" : ""}`);
      return id;
    },

    async freeze() {
      const pending = attempt;
      if (!pending) return;
      if (!current || current.disposed || current.revealing) current = raise();
      const held = current;
      if (!held) return;
      let budget: ReturnType<typeof setTimeout> | null = null;
      const frozen = await Promise.race([
        freezeHeld(held, pending.id),
        new Promise<null>((resolve) => { budget = setTimer(() => resolve(null), SWITCH_FREEZE_BUDGET_MS); }),
      ]);
      cancel(budget);
      if (frozen === null) {
        log(`skipped reason=freeze_timeout attempt=${pending.id} stage=${held.stage} elapsedMs=${SWITCH_FREEZE_BUDGET_MS} sinceRaiseMs=${now() - held.raisedAt}`);
        dispose(held, "freeze_timeout");
      }
    },

    loaded(origin) {
      const pending = attempt;
      if (!pending || pending.target.origin !== originOf(origin) || !current) return;
      log(`loaded attempt=${pending.id}`);
      capTimer = cancel(capTimer);
      capTimer = setTimer(() => { capTimer = null; if (attempt === pending) reveal("cap"); }, SWITCH_READY_CAP_MS);
    },

    ready(origin) {
      const pending = attempt;
      if (!pending || pending.target.origin !== originOf(origin)) return;
      log(`ready attempt=${pending.id}`);
      reveal("ready");
    },

    fail(id) {
      const pending = attempt;
      if (!pending || pending.id !== id) return;
      const held = current;
      if (!held || held.disposed || !held.presented) {
        // 아무것도 보이기 전에 끝났다 — 판을 띄우지 않고 지나간다. 사람에게는 알림이 간다.
        attempt = null;
        clearAttemptTimers();
        if (held) dispose(held, "fail");
        return;
      }
      capTimer = cancel(capTimer);
      pillTimer = cancel(pillTimer);
      warnAt = now();
      void push(held, { pill: { tone: "warn", text: copy.failed(pending.label) } });
      log(`pill attempt=${id} tone=warn`);
      reveal("fail");
    },

    release(reason) {
      attempt = null;
      clearAttemptTimers();
      if (current) dispose(current, reason);
      runDeferredChrome();
    },

    atReveal(apply) {
      const held = current;
      if (held && held.presented && !held.revealing && !held.disposed) deferredChrome = apply;
      else apply();
    },
  };

  function labelFor(target: SwitchTarget): string {
    if (target.kind === "home") return copy.thisComputer;
    if (target.kind === "local") return copy.otherConsole;
    const label = (target.label ?? "").replace(/\s+/gu, " ").trim();
    if (label === "") return copy.otherConsole;
    return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
  }
}

export function holdScript(update: HoldUpdate): string {
  const serialized = JSON.stringify(update).replace(/[<>&\u2028\u2029]/g, (character) => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" })[character] ?? character);
  // 치환 함수로 넘긴다 — 문자열로 넘기면 이름 안의 `$'`·`$&` 같은 패턴이 해석되어 템플릿 조각이 리터럴 안으로 끼어든다.
  return HOLD_RENDERER.replace("__HOLD_UPDATE__", () => serialized);
}

/** 같은 콘솔을 다른 철자로 불러도 같은 시도로 본다(기본 포트·대소문자). */
function originOf(value: string): string {
  try { return new URL(value).origin; } catch { return value; }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
