import type { WebContents } from "electron";

import { isLoopbackConsoleOrigin, isRemoteConsoleOrigin } from "./console-origin.js";
import type { DesktopNotice } from "./desktop-notices.js";
import { confirmRemoteIdentity, joinRemoteConsole, type RemoteCertificatePins, type SessionFetch } from "./remote-access.js";
import type { WindowPolicy } from "./window-policy.js";

/**
 * 다른 콘솔로 건너가는 동선은 전부 Console 안에 있다. Desktop이 남겨 두는 것은 화면이 아니라
 * 배관 한 겹이다 — 자체서명 인증서를 쓰는 호스트는 Chromium이 경고조차 띄우지 않고 그냥 실패하므로,
 * 창을 그리로 보내려면 누군가는 그 인증서를 지문과 대조해 신뢰해 주어야 한다.
 *
 * 이 다리는 스스로 아무것도 고르지 않는다. 어디로 갈지, 무엇을 믿을지는 전부 로컬 Console이
 * 들고 있는 목록에서 온다. 링크 문자열을 해석하는 일조차 하지 않는다.
 */
export interface RemoteBridgeDeps {
  readonly pins: RemoteCertificatePins;
  readonly policy: () => WindowPolicy | null;
  /** 창이 쓰는 세션. 조인 쿠키는 반드시 이 항아리에 담겨야 한다. */
  readonly sessionFetch: SessionFetch;
  /** 로컬 Console은 평문 루프백이라 Node의 fetch로 충분하다. */
  readonly localFetch?: typeof fetch;
  readonly localOrigin: () => string | null;
  /** 원격 콘솔의 세션 목록에 남을 이 기기의 이름. */
  readonly deviceName?: string;
  readonly loadConsole: (url: string) => Promise<void>;
  /**
   * 집의 목록을 그 자리에서 펼친다. 원격 콘솔이 서빙한 화면은 남의 기계 주소를 알 수 없고
   * 알아서도 안 되므로, 목록은 이 URL을 적재하는 홈 origin의 렌더러가 직접 그린다.
   */
  readonly openPicker?: (url: string) => Promise<void>;
  readonly closePicker?: () => void;
  readonly notify: (notice: DesktopNotice) => void;
  readonly log?: (message: string) => void;
  readonly confirmIdentity?: (hostname: string, port: number, fingerprint: string) => Promise<void>;
}

export interface RemoteBridge {
  attach(contents: Pick<WebContents, "on" | "removeListener">): void;
  /**
   * 집의 목록을 그리는 렌더러. 여기서 고른 콘솔은 메인 창이 받아 열고, 피커는 닫힌다 —
   * 성공이든 실패든 닫는다. 실패한 채 덮개만 남으면 사용자는 돌아갈 화면을 잃는다.
   */
  attachPicker(contents: Pick<WebContents, "on" | "removeListener">): void;
  /** 목록에 이미 있는 호스트를 연다. `url`은 루프백 대상의 특정 화면까지 정해져 온 경우에만 쓰인다. */
  open(origin: string, url?: string): Promise<void>;
  /** `fleet://join?code=…`를 로컬 Console에 넘기고, 받아들여지면 그 호스트를 연다. */
  receiveLink(link: string): Promise<void>;
  /** 실패를 사람이 읽을 수 있는 한 줄로 바꿔 알린다. 화면이 없는 배관의 유일한 발화 지점이다. */
  report(error: unknown): void;
  dispose(): void;
}

interface Handoff {
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly token: string | null;
}

const HANDOFF_PATH = "/api/v1/desktop/handoff";
const LOCAL_CONSOLES_PATH = "/api/v1/local-consoles";
const REMOTE_HOSTS_PATH = "/api/v1/remote-hosts";
const CONSOLE_PATH = "/console/";
const JOIN_PATH = "/api/v1/join";

/**
 * Console 계약의 쿼리 리터럴 — DESKTOP_SHELL_PATH와 같은 방식으로 여기서 선언한다
 * (Console 내부를 import하지 않는다). 이 항해는 절대 기계를 떠나지 않는다: 아래 리스너가
 * 요청이 나가기 전에 가로채고, 값을 실어 나르는 것도 아니라 어느 표면을 뜻하는지만 말한다.
 */
const PICKER_SURFACE_PARAM = "desktop-surface";
const PICKER_SURFACE_OPEN = "host-picker";
const PICKER_SURFACE_DISMISS = "host-picker-dismiss";

export function createRemoteBridge(deps: RemoteBridgeDeps): RemoteBridge {
  const localFetch = deps.localFetch ?? globalThis.fetch;
  const confirmIdentity = deps.confirmIdentity ?? confirmRemoteIdentity;
  const attached: Array<{ readonly contents: Pick<WebContents, "on" | "removeListener">; readonly listener: (...args: never[]) => void; readonly event?: "did-navigate" }> = [];

  async function askLocalConsole(path: string, body: unknown): Promise<Response> {
    const origin = deps.localOrigin();
    if (!origin) throw new Error("remote_bridge_no_local_console");
    return localFetch(`${origin}${path}`, {
      method: "POST",
      // 로컬 Console의 쓰기 경로는 Origin을 본다. 메인 프로세스 요청에는 문서 출처가 없으므로 직접 싣는다.
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
  }

  /**
   * `url`은 루프백 콘솔로 갈 때만 쓰인다 — 그 콘솔 안의 어느 화면을 열지까지 정해져 온 경우다
   * (덮개의 "호스트 관리"가 그렇다). 원격은 핸드오프가 돌려준 origin의 `/console/`로만 간다.
   */
  async function open(origin: string, url?: string): Promise<void> {
    // 집으로 돌아가는 길에는 핀도 자격도 필요 없다 — 루프백은 언제나 허용된 origin이다.
    if (origin === deps.localOrigin()) return openLocal(origin, url);
    /**
     * 이 기계의 다른 콘솔도 핀과 자격 없이 열 수 있다. 다만 창을 아무 로컬 포트로나 보낼 수는
     * 없다 — 원격 콘솔이 서빙한 페이지가 `http://127.0.0.1:<임의>`로 항해를 걸면 그 주소는
     * 사용자 기계의 전혀 다른 서비스를 가리킨다. 로컬 Console이 실제로 발견한 것만 연다.
     */
    if (isLoopbackConsoleOrigin(origin)) {
      if (!(await isDiscoveredLocally(origin))) throw new Error("remote_host_unknown");
      return openLocal(origin, url);
    }
    const response = await askLocalConsole(HANDOFF_PATH, { origin });
    if (response.status === 404) throw new Error("remote_host_unknown");
    if (!response.ok) throw new Error("remote_host_unavailable");
    const handoff = await response.json() as Handoff;

    // Chromium이 이 호스트를 처음 보기 전에 대조한다 — 어긋난 판정은 캐시에 눌어붙어 재시작 전까지 살아남는다.
    await confirmIdentity(handoff.hostname, handoff.port, handoff.fingerprint);

    const policy = deps.policy();
    if (!policy) throw new Error("remote_bridge_no_window");
    deps.pins.pin(handoff.hostname, handoff.fingerprint);
    policy.admitRemoteConsoleOrigin(handoff.origin);
    policy.stageConsoleOrigin(handoff.origin);
    try {
      /**
       * 링크의 1회용 자격은 처음 한 번만 실려 온다. 그 뒤로는 token이 비어 오지만 조인을
       * 건너뛰지는 않는다 — 그 요청이 페어링 쿠키를 세션으로 바꾸는 유일한 자리이고,
       * 제어권을 회수당했거나 접속이 만료된 뒤 돌아오는 길이 바로 이것이다.
       */
      await joinRemoteConsole(deps.sessionFetch, `${handoff.origin}${JOIN_PATH}`, handoff.token, deps.deviceName ?? null);
      await verifyConsoleReachable(handoff.origin);
      await deps.loadConsole(`${handoff.origin}${CONSOLE_PATH}`);
      policy.commitConsoleOrigin();
    } catch (error) {
      policy.cancelPendingConsoleOrigin();
      policy.withdrawRemoteConsoleOrigin(handoff.origin);
      deps.pins.unpin(handoff.hostname);
      throw error;
    }
  }

  /**
   * 창을 보내기 전에 그 콘솔이 정말 콘솔을 내주는지 확인한다.
   *
   * `loadURL`은 401 JSON 본문도 "성공한 적재"로 되돌려 준다. 그 판정을 창에 맡기면 롤백 경로가
   * 아예 발동하지 않고, 사용자는 콘솔 대신 오류 문서 위에 갇힌다 — 그 문서에는 돌아갈 UI가 없다.
   */
  async function verifyConsoleReachable(origin: string): Promise<void> {
    let response: Response;
    try {
      response = await deps.sessionFetch(`${origin}${CONSOLE_PATH}`, { method: "GET", redirect: "error" });
    } catch (error) {
      throw new Error("remote_link_unreachable", { cause: error });
    }
    if (response.status === 401) throw new Error("remote_host_session_expired");
    if (!response.ok) throw new Error("remote_host_unavailable");
  }

  async function isDiscoveredLocally(origin: string): Promise<boolean> {
    const home = deps.localOrigin();
    if (!home) return false;
    try {
      const response = await localFetch(`${home}${LOCAL_CONSOLES_PATH}`);
      if (!response.ok) return false;
      const payload = await response.json() as { readonly consoles?: readonly { readonly origin?: unknown }[] };
      return (payload.consoles ?? []).some((entry) => entry.origin === origin);
    } catch {
      return false;
    }
  }

  async function openPicker(url: string): Promise<void> {
    if (!deps.openPicker) throw new Error("remote_bridge_no_picker");
    await deps.openPicker(url);
  }

  /** 덮개를 걷는 일은 여러 경로에서 불린다 — 없어도, 이미 걷혔어도 실패가 아니다. */
  function closePicker(): void {
    deps.closePicker?.();
  }

  async function openLocal(origin: string, url?: string): Promise<void> {
    const policy = deps.policy();
    if (!policy) throw new Error("remote_bridge_no_window");
    // 정해져 온 화면이 있어도 그 콘솔의 `/console/` 안이어야 한다 — 아니면 기본 화면으로 연다.
    const target = url !== undefined && consoleTarget(url, origin) === origin ? url : `${origin}${CONSOLE_PATH}`;
    /**
     * 창이 실제로 도착한 뒤에 활성 origin을 옮긴다. 먼저 옮겨 두면 적재가 실패했을 때 정책은
     * 새 콘솔을, 창은 옛 콘솔을 가리킨 채 갈라지고, 그 창은 자기가 보고 있는 화면 안에서조차
     * 움직이지 못한다. 원격 경로가 이미 쓰는 예약·확정 문법을 여기서도 쓴다.
     */
    policy.stageConsoleOrigin(origin);
    try {
      await deps.loadConsole(target);
    } catch (error) {
      policy.cancelPendingConsoleOrigin();
      throw error;
    }
    policy.commitConsoleOrigin();
  }

  async function receiveLink(link: string): Promise<void> {
    const response = await askLocalConsole(REMOTE_HOSTS_PATH, { link });
    if (!response.ok) throw new Error(await readErrorCode(response));
    const added = await response.json() as { readonly host?: { readonly origin?: unknown } };
    const origin = typeof added.host?.origin === "string" ? added.host.origin : null;
    if (!origin) throw new Error("pairing_target_invalid");
    await open(origin);
  }

  /** 오류 문서 위에 남겨 두지 않는다 — 그 화면에는 돌아올 방법이 없다. */
  async function recoverToHome(origin: string, home: string, status: number): Promise<void> {
    const policy = deps.policy();
    policy?.withdrawRemoteConsoleOrigin(origin);
    try {
      await openLocal(home);
    } catch (error) {
      deps.log?.(`recovery to the local console failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    report(new Error(status === 401 ? "remote_host_session_expired" : "remote_host_unavailable"));
  }

  function report(error: unknown): void {
    const code = error instanceof Error ? error.message : String(error);
    deps.log?.(`remote bridge failed: ${code}`);
    deps.notify({ type: "error", title: "Could not open that console", body: describe(code) });
  }

  return {
    attach(contents) {
      const listener = (event: { preventDefault: () => void }, url: string, _redirect?: unknown, isMainFrame?: boolean): void => {
        if (isMainFrame === false) return;
        /**
         * 피커 판정이 consoleTarget보다 먼저다. 센티넬도 홈의 `/console/`이라 아래 판정에
         * 걸리는데, 그러면 목록을 펼치는 대신 창째로 집에 돌아가 버린다 — 지금의 2단 동선 그대로다.
         */
        const surface = pickerSurfaceOf(url, deps.localOrigin());
        if (surface !== null) {
          event.preventDefault();
          if (surface === "open") void openPicker(url).catch(report);
          else closePicker();
          return;
        }
        const target = consoleTarget(url, deps.localOrigin());
        // 이미 활성인 콘솔 안에서의 이동은 window policy의 몫이다.
        if (target === null || target === deps.policy()?.currentConsoleOrigin()) return;
        event.preventDefault();
        void open(target).catch(report);
      };
      contents.on("will-navigate", listener as never);
      attached.push({ contents, listener: listener as never });

      // 확인을 통과한 뒤에도 세션은 끊길 수 있다. 창이 오류 문서에 착지하면 집으로 되돌린다.
      const landed = (_event: unknown, url: string, httpResponseCode: number): void => {
        if (typeof httpResponseCode !== "number" || httpResponseCode < 400) return;
        const home = deps.localOrigin();
        const target = consoleTarget(url, home);
        if (target === null || home === null || target === home) return;
        void recoverToHome(target, home, httpResponseCode);
      };
      contents.on("did-navigate", landed as never);
      attached.push({ contents, listener: landed as never, event: "did-navigate" });
    },

    attachPicker(contents) {
      const listener = (event: { preventDefault: () => void }, url: string, _redirect?: unknown, isMainFrame?: boolean): void => {
        if (isMainFrame === false) return;
        // 피커 안에서 다시 피커를 부르는 일은 없다. 스스로를 다시 여는 대신 조용히 닫는다.
        const surface = pickerSurfaceOf(url, deps.localOrigin());
        if (surface !== null) {
          event.preventDefault();
          closePicker();
          return;
        }
        const target = consoleTarget(url, deps.localOrigin());
        if (target === null) return;
        event.preventDefault();
        /**
         * 고르고 난 뒤에는 성공이든 실패든 덮개를 걷는다. 실패한 채로 남기면 사용자는
         * 아무 일도 일어나지 않은 목록을 마주하고, 그 아래 멀쩡한 콘솔에는 손이 닿지 않는다.
         */
        void open(target, url).then(closePicker, (error: unknown) => { closePicker(); report(error); });
      };
      contents.on("will-navigate", listener as never);
      attached.push({ contents, listener: listener as never });
    },
    open,
    receiveLink,
    report,
    dispose() {
      while (attached.length > 0) {
        const entry = attached.pop();
        if (!entry) continue;
        // 두 이벤트를 한 배열로 관리하므로 리스너 해제는 느슨한 시그니처로 부른다.
        (entry.contents as unknown as { removeListener: (event: string, listener: (...args: never[]) => void) => void })
          .removeListener(entry.event ?? "will-navigate", entry.listener);
      }
    },
  };
}

/**
 * 콘솔을 갈아타려는 항해만 이 다리가 가로챈다 — 원격으로 나가는 길과, 셸이 띄운 로컬 콘솔로
 * 돌아오는 길. 돌아오는 길도 여기를 거쳐야 하는 이유는 window policy가 활성 origin 밖으로의
 * 항해를 막기 때문이다.
 */
/**
 * 집의 목록을 펼치라는(또는 걷으라는) 신호인가.
 *
 * 신호는 홈 origin의 `/console/`로만 온다 — 원격 콘솔이 서빙한 화면이 남의 주소로 이 신호를
 * 흉내 내도 여기서 걸린다. 실을 수 있는 것은 어느 표면이냐는 사실 하나뿐이고, 그래서 이 URL이
 * 새어도 알려지는 것이 없다.
 */
export function pickerSurfaceOf(url: string, localOrigin: string | null): "open" | "dismiss" | null {
  if (localOrigin === null) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== localOrigin || !parsed.pathname.startsWith(CONSOLE_PATH)) return null;
    const surface = parsed.searchParams.get(PICKER_SURFACE_PARAM);
    if (surface === PICKER_SURFACE_OPEN) return "open";
    return surface === PICKER_SURFACE_DISMISS ? "dismiss" : null;
  } catch {
    return null;
  }
}

export function consoleTarget(url: string, localOrigin: string | null): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith(CONSOLE_PATH)) return null;
    if (isRemoteConsoleOrigin(parsed.origin)) return parsed.origin;
    // 루프백 콘솔은 셸이 띄운 것이든 이 기계에서 발견한 것이든 이 다리를 거친다. 열어 줄지는
    // open()이 로컬 Console에 물어 정하고, 여기서는 window policy가 막기 전에 가로채기만 한다.
    if (!isLoopbackConsoleOrigin(parsed.origin)) return null;
    // 셸이 자기 콘솔을 아직 갖지 않았다면 물어볼 곳도 없다.
    return localOrigin === null ? null : parsed.origin;
  } catch {
    return null;
  }
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    const body = await response.json() as { readonly error?: unknown };
    return typeof body.error === "string" ? body.error : "remote_host_unavailable";
  } catch {
    return "remote_host_unavailable";
  }
}

function describe(code: string): string {
  switch (code) {
    case "remote_host_unknown": return "That console is no longer in this list.";
    case "remote_link_unreachable":
    case "remote_host_unreachable": return "That console did not answer. It may be off, or on another network.";
    case "remote_link_fingerprint_mismatch":
    case "remote_host_fingerprint_mismatch": return "That address answered with a different certificate. Ask for a fresh access link.";
    case "remote_link_rejected": return "That access link was already used, or it expired. Ask for a fresh one.";
    // 페어링이 회수되었거나 그 콘솔이 신원을 갈아 끼웠다. 링크를 새로 받는 것 말고는 길이 없다.
    case "remote_host_not_paired": return "That console no longer recognises this device. Ask for a fresh access link.";
    // 자격이 나빠서가 아니라 자리가 차 있어서 거절된 경우다. "다시 받아라"로 안내하면 링크를
    // 새로 받아도 같은 거절이 돌아온다 — 기다리거나 물러나 달라고 말해야 한다.
    case "remote_link_control_held": return "Another device already has control of that console. Ask them to hand it back, then try again.";
    /*
      자리를 기다리는 문제가 아니다 — 그 콘솔이 기억할 수 있는 기기가 다 찼으므로 하나를 지워야 한다.
      "다시 시도"로 끝내면 지키지 못할 약속이 된다: 링크의 자격은 handoff가 한 번만 넘기므로,
      목록에서 이 콘솔을 다시 열어도 보낼 것이 없다. 서버가 이 거절에서 grant를 태우지 않았으니
      아직 유효한 링크 문자열을 다시 붙여넣는 길만 실제로 열려 있다.
    */
    case "remote_link_device_limit": return "That console has paired as many devices as it can hold. Remove one there, then paste the access link again.";
    case "remote_host_session_expired": return "That console no longer recognises this device. Ask for a fresh access link.";
    case "remote_link_host_mismatch": return "That console refused the link as meant for a different address.";
    case "remote_host_is_self": return "That link points back at this console.";
    case "pairing_target_invalid": return "That is not a Fleet Console access link.";
    // 덮개를 얹을 창이 없다. 목록은 이 셸이 띄운 콘솔에 그대로 있으므로 그리로 안내한다.
    case "remote_bridge_no_picker": return "The host list could not open here. Go back to this computer's console to switch machines.";
    default: return "The connection failed. This console remains available.";
  }
}
