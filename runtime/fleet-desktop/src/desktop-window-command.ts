import { DESKTOP_WINDOW_COMMAND_EVENT, DESKTOP_WINDOW_COMMAND_EVENTS_PATH, DESKTOP_WINDOW_COMMAND_PATH, isDesktopWindowCommandSnapshot, type DesktopWindowCommand, type DesktopWindowCommandSnapshot } from "@fleet-console/protocol/desktop";

import { normalizeConsoleOrigin as normalizeAnyConsoleOrigin } from "./console-links.js";
import { createDesktopEventStream, type DesktopEventStream } from "./desktop-event-stream.js";

const MAX_WINDOW_COMMAND_SSE_BUFFER_CHARS = 4 * 1024;

export interface DesktopWindowCommandSynchronizerDeps {
  /** 창이 시킨 창 조작. Console은 명령을 걸어 두지 않으므로 재연결이 같은 명령을 되풀이하지 않는다. */
  readonly perform: (command: DesktopWindowCommand) => void;
  readonly fetch?: typeof fetch;
}

/**
 * 창이 보고 있는 Console에서 창 조작 명령(지금은 네이티브 전체화면 진입·이탈)을 듣는다. 이 명령을
 * 모르는 옛 Console은 스냅샷 경로에 404로 답하므로 스트림을 열지 않는다.
 */
export function createDesktopWindowCommandSynchronizer(deps: DesktopWindowCommandSynchronizerDeps): DesktopEventStream {
  return createDesktopEventStream<DesktopWindowCommandSnapshot>({
    snapshotPath: DESKTOP_WINDOW_COMMAND_PATH,
    eventsPath: DESKTOP_WINDOW_COMMAND_EVENTS_PATH,
    eventName: DESKTOP_WINDOW_COMMAND_EVENT,
    parseSnapshot: (value) => isDesktopWindowCommandSnapshot(value) ? value : null,
    apply: (snapshot) => {
      if (snapshot.command !== null) deps.perform(snapshot.command);
    },
    maxFrameChars: MAX_WINDOW_COMMAND_SSE_BUFFER_CHARS,
    normalizeOrigin: (origin) => normalizeAnyConsoleOrigin(origin, "desktop_window_command_origin_invalid"),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

export interface ZenFullscreenWindow {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  on(event: "enter-full-screen" | "leave-full-screen", listener: () => void): unknown;
  removeListener(event: "enter-full-screen" | "leave-full-screen", listener: () => void): unknown;
}

export interface ZenFullscreenController {
  perform(command: DesktopWindowCommand): void;
  stop(): void;
}

/** 전환 완료 이벤트가 오지 않을 때(OS가 요청을 삼킴) 기다림을 풀고 실제 상태로 다시 맞추는 한도. */
const FULLSCREEN_SETTLE_TIMEOUT_MS = 1_500;
/** 같은 뜻을 거듭 삼키는 창에 끝없이 되풀이하지 않는다 — 이만큼 시도하고도 안 되면 뜻을 내려놓는다. */
const FULLSCREEN_MAX_ATTEMPTS = 3;

/**
 * Zen이 켜고 끄는 네이티브 전체화면의 소유자. 판단은 화면이 아니라 여기서 한다 — 화면이 보는 전체화면
 * 여부는 셸 → Console → SSE를 거쳐 늦게 도착하므로, 그 값으로 "이미 전체화면인가"를 가리면 빠르게 켰다
 * 끈 뒤에 전체화면이 남고, 그다음부터는 Zen이 연 것이 아니라며 영영 끄지 않는다(Windows 실사용 신고).
 *
 * - 켜기: 창이 이미(사용자가) 전체화면이면 손대지 않는다. 아니면 Zen 몫으로 잡고 켠다.
 * - 끄기: Zen이 잡은 전체화면만 끈다.
 * - 전환 중에 들어온 명령은 버리지 않고 마지막 뜻만 남겨 전환이 끝난 뒤 실제 상태와 맞춘다 — 전환 도중의
 *   setFullScreen은 OS가 무시하거나(macOS 애니메이션) 상태를 어긋나게 한다.
 * - Zen 몫의 전체화면을 사용자가 스스로 빠져나오면 몫을 놓는다(Zen 종료는 화면이 스냅숏으로 한다).
 */
export function createZenFullscreenController(
  window: ZenFullscreenWindow,
  deps: { readonly setTimeout?: typeof setTimeout; readonly clearTimeout?: typeof clearTimeout } = {},
): ZenFullscreenController {
  const schedule = deps.setTimeout ?? globalThis.setTimeout;
  const cancel = deps.clearTimeout ?? globalThis.clearTimeout;
  let owned = false;
  let desired: boolean | null = null;
  let settling: ReturnType<typeof setTimeout> | null = null;
  /** 지금 창에 요청해 둔 전환 — 도착한 이탈이 우리가 부른 것인지 가린다(뜻은 그사이 바뀔 수 있다). */
  let inflight: boolean | null = null;
  let attempts = 0;
  let stopped = false;

  const clearSettling = () => {
    if (settling !== null) cancel(settling);
    settling = null;
    inflight = null;
  };

  const reconcile = () => {
    if (stopped || window.isDestroyed() || settling !== null || desired === null) return;
    const fullscreen = window.isFullScreen();
    if (desired === fullscreen || attempts >= FULLSCREEN_MAX_ATTEMPTS) {
      if (!fullscreen) owned = false;
      desired = null;
      attempts = 0;
      return;
    }
    attempts += 1;
    inflight = desired;
    settling = schedule(() => {
      // 요청은 남겨 둔다 — 늦게 도착한 완료 이벤트도 우리가 부른 것으로 읽어야 한다.
      settling = null;
      reconcile();
    }, FULLSCREEN_SETTLE_TIMEOUT_MS);
    window.setFullScreen(desired);
  };

  let deferred: ReturnType<typeof setTimeout> | null = null;
  const onSettled = (entered: boolean) => {
    const requested = inflight;
    clearSettling();
    // Zen 몫의 전체화면에서 사용자가 나왔다(우리가 끄라고 한 것이 아니다) — 몫을 놓고 다시 켜지 않는다.
    if (!entered && owned && requested !== false) {
      owned = false;
      desired = null;
      attempts = 0;
      return;
    }
    // 다음 틱에 맞춘다. Windows의 Electron은 이 이벤트를 setFullScreen 안에서, 창 상태를 바꾸기 **전에** 동기로
    // 내보낸다 — 여기서 곧바로 isFullScreen()을 읽으면 아직 옛 값이라 켠 전체화면을 "안 켜졌다"로 보고 되풀이하다
    // 몫을 놓아 버렸고, 그 뒤 Zen을 꺼도 전체화면이 풀리지 않았다(Windows 신고). 이벤트 안에서 다시
    // setFullScreen을 부르는 재진입도 함께 피한다.
    if (deferred !== null) cancel(deferred);
    deferred = schedule(() => {
      deferred = null;
      reconcile();
    }, 0);
  };
  const onEnter = () => onSettled(true);
  const onLeave = () => onSettled(false);
  window.on("enter-full-screen", onEnter);
  window.on("leave-full-screen", onLeave);

  return {
    perform(command) {
      if (stopped || window.isDestroyed()) return;
      if (command === "enter-fullscreen") {
        if (!owned) {
          // 전환 중이 아닌데 이미 전체화면이면 사용자의 것이다.
          if (settling === null && window.isFullScreen()) return;
          owned = true;
        }
        desired = true;
      } else {
        if (!owned) return;
        desired = false;
      }
      attempts = 0;
      reconcile();
    },
    stop() {
      stopped = true;
      clearSettling();
      if (deferred !== null) cancel(deferred);
      deferred = null;
      window.removeListener("enter-full-screen", onEnter);
      window.removeListener("leave-full-screen", onLeave);
    },
  };
}
