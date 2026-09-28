import type { WebContents } from "electron";

import { remotePairingCookieName, remoteSessionCookieName } from "@fleet-console/protocol/remote";

import { isLoopbackConsoleOrigin, isRemoteConsoleOrigin } from "./console-links.js";
import type { SurfaceSelection, SwitchAttempt } from "./console-surface-state.js";
import type { DesktopNotice } from "./desktop-notices.js";
import { confirmRemoteIdentity, joinRemoteConsole, normalizeFingerprint, type RemoteCertificatePins, type SessionFetch } from "./remote-access.js";
import type { WindowPolicy } from "./window-policy.js";

/**
 * 다른 콘솔로 건너가는 동선은 전부 Console 안에 있다. Desktop이 남겨 두는 것은 화면이 아니라
 * 배관 한 겹이다 — 자체서명 인증서를 쓰는 호스트는 Chromium이 경고조차 띄우지 않고 그냥 실패하므로,
 * 창을 그리로 보내려면 누군가는 그 인증서를 지문과 대조해 신뢰해 주어야 한다.
 *
 * 이 다리는 스스로 아무것도 고르지 않는다. 어디로 갈지, 무엇을 믿을지는 전부 로컬 Console이
 * 들고 있는 목록에서 온다. 링크 문자열을 해석하는 일조차 하지 않는다.
 *
 * 무엇을 선택으로 받는지도 여기서 정한다. 선택은 이 앱이 띄운 콘솔이 그린 화면에서만 온다 — 활성 로컬 뷰의
 * main frame, 또는 지금 떠 있는 바로 그 덮개. 데이터 뷰(다른 콘솔이 서빙한 화면)는 덮개를 열어 달라고
 * 청할 수만 있고, 호스트를 고르지 못한다.
 */
export interface RemoteBridgeDeps {
  readonly pins: RemoteCertificatePins;
  readonly policy: () => WindowPolicy | null;
  /** 창이 쓰는 세션. 조인 쿠키는 반드시 이 항아리에 담겨야 한다. */
  readonly sessionFetch: SessionFetch;
  /** 원격 콘솔로 가는 메인 프로세스 요청(셸 세션). 최종 떠남에만 쓴다. */
  readonly remoteFetch: typeof fetch;
  /** 로컬 Console은 평문 루프백이라 Node의 fetch로 충분하다. */
  readonly localFetch?: typeof fetch;
  readonly localOrigin: () => string | null;
  /** 원격 콘솔의 세션 목록에 남을 이 기기의 이름. */
  readonly deviceName?: string;
  /** 한 콘솔이 발급한 쿠키를 모든 항아리에서 정확히 지우고 확인한다. 확인이 안 되면 던진다. */
  readonly purgeCookies: (origin: string, cookieNames: readonly string[]) => Promise<void>;
  /** 데이터 뷰에 싣고 도착·준비까지 기다린다. */
  readonly loadData: (url: string, attempt: SwitchAttempt) => Promise<void>;
  /** 검증을 통과한 선택을 전환으로 넘긴다. */
  readonly select: (selection: SurfaceSelection) => Promise<void>;
  /** 활성 로컬 뷰의 main frame이 지금 선택을 할 수 있는가(local-ready). */
  readonly acceptsLocalSelection: (contents: unknown) => boolean;
  /** 이 contents가 지금 떠 있는, 이번 세대의 덮개인가. */
  readonly isCurrentPicker: (contents: unknown) => boolean;
  /** 데이터 뷰가 오류 문서에 착지했다. */
  readonly disconnect: (reason: "expired" | "unavailable") => void;
  /**
   * 집의 목록을 그 자리에서 펼친다. 원격 콘솔이 서빙한 화면은 남의 기계 주소를 알 수 없고
   * 알아서도 안 되므로, 목록은 이 URL을 적재하는 홈 origin의 렌더러가 직접 그린다.
   */
  readonly openPicker?: (url: string) => Promise<void>;
  readonly closePicker?: () => void;
  readonly notify: (notice: DesktopNotice) => void;
  readonly log?: (message: string) => void;
  readonly confirmIdentity?: (hostname: string, port: number, fingerprint: string) => Promise<void>;
  readonly now?: () => number;
}

type AttachableContents = Pick<WebContents, "on" | "removeListener"> & { getURL?: () => string };

export interface RemoteBridge {
  /** 로컬 뷰 — 활성 로컬 main frame의 콘솔 항해는 선택이다. */
  attachLocal(contents: AttachableContents): void;
  /** 데이터 뷰 — 덮개를 열어 달라는 청만 받는다. 오류 문서에 착지하면 끊김을 알린다. */
  attachData(contents: AttachableContents): void;
  /**
   * 집의 목록을 그리는 렌더러. 여기서 고른 콘솔은 전환으로 넘기고, 피커는 닫힌다 —
   * 성공이든 실패든 닫는다. 실패한 채 덮개만 남으면 사용자는 돌아갈 화면을 잃는다.
   */
  attachPicker(contents: AttachableContents): void;
  /** 선택된 콘솔을 데이터 뷰에 싣는다. 원격이면 신원 확인·쿠키 결속 확인·조인을 한 번 거친다. */
  prepare(selection: SurfaceSelection, attempt: SwitchAttempt): Promise<void>;
  /** 최종 떠남 — 그 원격의 자기 세션을 끝내 달라고 한 번 청한다. 결과를 기다리지 않는다. */
  endSession(origin: string): void;
  /** `fleet://join?code=…`를 로컬 Console에 넘기고, 받아들여지면 그 호스트를 고른다. */
  receiveLink(link: string): Promise<void>;
  /** 실패를 사람이 읽을 수 있는 한 줄로 바꿔 알린다. 화면이 없는 배관의 유일한 발화 지점이다. */
  report(error: unknown): void;
  dispose(): void;
}

interface Handoff {
  readonly id?: string;
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly pinGeneration?: number;
  /** 이 기기의 쿠키가 묶인 인증서. 지금 지문과 다르거나 없으면 옛 쿠키를 새 신원에 보내지 않는다. */
  readonly cookieBoundFingerprint?: string | null;
  readonly token: string | null;
}

const HANDOFF_PATH = "/api/v1/desktop/handoff";
const LOCAL_CONSOLES_PATH = "/api/v1/local-consoles";
const REMOTE_HOSTS_PATH = "/api/v1/remote-hosts";
const CONSOLE_PATH = "/console/";
const JOIN_PATH = "/api/v1/join";
/** 원격 계약 — 요청한 세션 하나만 끝내고 페어링은 남긴다. 본문 없이, 정확한 원격 Origin으로. */
const LEAVE_PATH = "/api/v1/access/self/leave";
const LEAVE_TIMEOUT_MS = 2_000;
/**
 * 데이터 뷰가 덮개를 청하는 간격의 하한. 그 화면은 남의 콘솔이 서빙하므로, 스크립트가 신뢰 UI를 연달아
 * 띄워 사람의 손을 방해하는 길을 좁힌다.
 */
const DATA_PICKER_INTERVAL_MS = 1_000;

/**
 * Console 계약의 쿼리 리터럴 — DESKTOP_SHELL_PATH와 같은 방식으로 여기서 선언한다
 * (Console 내부를 import하지 않는다). 이 항해는 절대 기계를 떠나지 않는다: 아래 리스너가
 * 요청이 나가기 전에 가로채고, 값을 실어 나르는 것도 아니라 어느 표면을 뜻하는지만 말한다.
 */
/**
 * 떠나는 화면이 실어 보내는 표현 상태(툴바 접힘, 도구 패널, 폭, 캔버스 모드). Console의
 * features/remote-access/client/presentation-carry.ts가 같은 접두와 한도로 싸고 풀며, 여기서는 모양과
 * 길이만 보고 그대로 옮긴다 — 풀어 보지 않는다. fragment라 서버에 전송되지 않는다.
 */
const PRESENTATION_CARRY_PREFIX = "#fleet-carry=";
const PRESENTATION_CARRY_MAX_LENGTH = 2_048;
const PICKER_SURFACE_PARAM = "desktop-surface";
const PICKER_SURFACE_OPEN = "host-picker";
const PICKER_SURFACE_DISMISS = "host-picker-dismiss";
/** 전환 직전 화면 모드. Console이 새 문서에서 읽고 지운다(zen-mode.ts). */
const MODE_PARAM = "fleet-zen";
const MODE_ZEN = "1";

export function createRemoteBridge(deps: RemoteBridgeDeps): RemoteBridge {
  const localFetch = deps.localFetch ?? globalThis.fetch;
  const confirmIdentity = deps.confirmIdentity ?? confirmRemoteIdentity;
  const now = deps.now ?? Date.now;
  let dataPickerAt = Number.NEGATIVE_INFINITY;
  /** 호스트마다 가장 최근에 핀을 건 시도, 콘솔마다 가장 최근에 조인한 시도. 옛 시도가 새 시도의 핀·세션을 거두지 않게 한다. */
  const pinOwners = new Map<string, number>();
  const joinOwners = new Map<string, number>();
  const attached: Array<{ readonly contents: Pick<WebContents, "on" | "removeListener">; readonly listener: (...args: never[]) => void; readonly event: "will-navigate" | "did-navigate" }> = [];

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
   * `url`은 루프백 콘솔로 갈 때만 목적지 화면으로 쓰인다 — 그 콘솔 안의 어느 화면을 열지까지 정해져 온
   * 경우다(덮개의 "호스트 관리"가 그렇다). 원격은 핸드오프가 돌려준 origin의 `/console/`로만 가고,
   * `url`에서는 전환 직전 화면 모드(`fleet-zen=1`)와 표현 상태 fragment만 옮겨 싣는다.
   */
  async function prepare(selection: SurfaceSelection, attempt: SwitchAttempt): Promise<void> {
    const { origin, url } = selection;
    /**
     * 이 기계의 다른 콘솔은 핀과 자격 없이 연다. 다만 아무 로컬 포트로나 보낼 수는 없다 — 그 주소는
     * 사용자 기계의 전혀 다른 서비스를 가리킬 수 있다. 로컬 Console이 실제로 발견한 것만 연다.
     */
    if (isLoopbackConsoleOrigin(origin)) {
      if (!(await isDiscoveredLocally(origin))) throw new Error("remote_host_unknown");
      // 정해져 온 화면이 있어도 그 콘솔의 `/console/` 안이어야 한다 — 아니면 기본 화면으로 연다.
      const target = url !== undefined && consoleTarget(url, deps.localOrigin()) === origin ? url : `${origin}${CONSOLE_PATH}`;
      return navigate(origin, target, attempt);
    }
    if (!isRemoteConsoleOrigin(origin)) throw new Error("remote_host_unknown");
    return joinAndNavigate(origin, url, attempt);
  }

  /**
   * 신뢰할 수 있는 선택 하나에 조인은 한 번뿐이다. 그 뒤 화면을 싣는 길(`navigateJoined`)은 조인하지 않는다 —
   * 세션이 끊겨 있으면 다시 조인하지 않고 끊김으로 끝난다. 재개는 사람의 새 선택으로만 한다.
   */
  async function joinAndNavigate(origin: string, url: string | undefined, attempt: SwitchAttempt): Promise<void> {
    const response = await askLocalConsole(HANDOFF_PATH, { origin });
    if (response.status === 404) throw new Error("remote_host_unknown");
    if (!response.ok) throw new Error("remote_host_unavailable");
    const handoff = await response.json() as Handoff;
    const fingerprint = normalizeFingerprint(handoff.fingerprint);

    // Chromium이 이 호스트를 처음 보기 전에 대조한다 — 어긋난 판정은 캐시에 눌어붙어 재시작 전까지 살아남는다.
    await confirmIdentity(handoff.hostname, handoff.port, fingerprint);
    // 같은 이유로, 이 실행에서 이 호스트명의 다른 인증서를 수락한 적이 있으면 새 핀이 옛 인증서를 막는다고 말할 수 없다.
    if (deps.pins.trustedOtherIdentity(handoff.hostname, fingerprint)) throw new Error("remote_host_restart_required");
    if (!attempt.isCurrent()) throw new Error("surface_switch_superseded");

    /**
     * 이 기기의 쿠키가 지금 인증서에 묶였는지 모르면(바뀌었거나, 기록이 없으면) 옛 자격을 새 신원에 보내지 않는다.
     * 정확히 이 콘솔의 두 쿠키만 모든 항아리에서 지우고, 지워졌는지 확인한다. 확인이 안 되면 여기서 멈춘다.
     * 페어링이 지워졌으므로 이 호스트는 새 링크의 1회용 자격으로만 다시 짝지을 수 있다.
     */
    const bound = typeof handoff.cookieBoundFingerprint === "string" && normalizeFingerprint(handoff.cookieBoundFingerprint) === fingerprint;
    if (!bound) {
      deps.log?.(`remote cookies not bound to the current certificate; purging host port=${handoff.port}`);
      await deps.purgeCookies(handoff.origin, [remoteSessionCookieName(handoff.port), remotePairingCookieName(handoff.port)]);
      if (handoff.token === null) throw new Error("remote_host_link_required");
    }

    const policy = deps.policy();
    if (!policy) throw new Error("remote_bridge_no_window");
    deps.pins.pin(handoff.hostname, fingerprint);
    pinOwners.set(handoff.hostname, attempt.generation);
    policy.admitRemoteConsoleOrigin(handoff.origin);
    let joined = false;
    try {
      /**
       * 링크의 1회용 자격은 처음 한 번만 실려 온다. 그 뒤로는 token이 비어 오지만 조인을
       * 건너뛰지는 않는다 — 그 요청이 페어링 쿠키를 세션으로 바꾸는 유일한 자리이고,
       * 제어권을 회수당했거나 접속이 만료된 뒤 돌아오는 길이 바로 이것이다.
       */
      joinOwners.set(handoff.origin, attempt.generation);
      await joinRemoteConsole(deps.sessionFetch, `${handoff.origin}${JOIN_PATH}`, handoff.token, deps.deviceName ?? null);
      joined = true;
      void reportCookieBinding(handoff, fingerprint);
      await navigateJoined(handoff.origin, `${remoteConsoleEntry(handoff.origin, url)}${presentationCarryOf(url)}`, attempt);
    } catch (error) {
      // 열지 못한 원격은 허용 목록에서 뺀다. 지금 데이터 뷰가 그 콘솔에 서 있다면(같은 콘솔로 다시 온 경우) 남긴다.
      if (policy.dataConsoleOrigin() !== handoff.origin) {
        policy.withdrawRemoteConsoleOrigin(handoff.origin);
        /**
         * 조인은 됐지만 이 창이 그 콘솔을 보여 주지 못하게 됐다(실패, 또는 복귀·다른 선택에 밀림). 세션을 쥔 채 두면
         * 상대 화면에 제어 커튼이 남는다. 같은 콘솔을 더 새 시도가 조인했다면 그 세션은 건드리지 않는다.
         * 떠남 요청도 핀이 있어야 닿으므로, 핀은 그 요청이 끝난 뒤에 — 그사이 더 새 시도가 핀을 걸지 않았을 때만 — 푼다.
         */
        if (joined && joinOwners.get(handoff.origin) === attempt.generation) {
          void leaveSession(handoff.origin).finally(() => {
            if (pinOwners.get(handoff.hostname) === attempt.generation && policy.dataConsoleOrigin() !== handoff.origin) deps.pins.unpin(handoff.hostname);
          });
        } else {
          deps.pins.unpin(handoff.hostname);
        }
      }
      throw error;
    }
  }

  /** 조인은 끝났다. 창을 보내기 전에 그 콘솔이 정말 콘솔을 내주는지 확인하고 싣는다. 여기서는 조인하지 않는다. */
  async function navigateJoined(origin: string, url: string, attempt: SwitchAttempt): Promise<void> {
    await verifyConsoleReachable(origin);
    await navigate(origin, url, attempt);
  }

  async function navigate(origin: string, url: string, attempt: SwitchAttempt): Promise<void> {
    const policy = deps.policy();
    if (!policy) throw new Error("remote_bridge_no_window");
    if (!attempt.isCurrent()) throw new Error("surface_switch_superseded");
    policy.stageDataOrigin(origin);
    try {
      await deps.loadData(url, attempt);
    } catch (error) {
      if (attempt.isCurrent()) policy.cancelPendingDataOrigin();
      throw error;
    }
    if (!attempt.isCurrent()) throw new Error("surface_switch_superseded");
    policy.commitDataOrigin();
  }

  /** 조인에 성공한 신원을 로컬 Console에 알린다. 실패해도 전환은 계속된다 — 다음 전환이 다시 확인할 뿐이다. */
  async function reportCookieBinding(handoff: Handoff, fingerprint: string): Promise<void> {
    if (typeof handoff.id !== "string" || typeof handoff.pinGeneration !== "number") return;
    try {
      const response = await askLocalConsole(`${REMOTE_HOSTS_PATH}/${encodeURIComponent(handoff.id)}/cookie-binding`, { fingerprint, pinGeneration: handoff.pinGeneration });
      if (!response.ok) deps.log?.(`remote cookie binding refused status=${response.status}`);
    } catch (error) {
      deps.log?.(`remote cookie binding failed: ${error instanceof Error ? error.message : String(error)}`);
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

  function endSession(origin: string): void {
    void leaveSession(origin);
  }

  function leaveSession(origin: string): Promise<void> {
    if (!isRemoteConsoleOrigin(origin)) return Promise.resolve();
    return deps.remoteFetch(`${origin}${LEAVE_PATH}`, { method: "POST", headers: { Origin: origin }, redirect: "error", signal: AbortSignal.timeout(LEAVE_TIMEOUT_MS) })
      .then((response) => { if (response.status !== 204 && response.status !== 401 && response.status !== 404) deps.log?.(`remote leave refused status=${response.status}`); })
      .catch((error: unknown) => deps.log?.(`remote leave failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  async function openPicker(url: string): Promise<void> {
    if (!deps.openPicker) throw new Error("remote_bridge_no_picker");
    await deps.openPicker(url);
  }

  /** 덮개를 걷는 일은 여러 경로에서 불린다 — 없어도, 이미 걷혔어도 실패가 아니다. */
  function closePicker(): void {
    deps.closePicker?.();
  }

  async function receiveLink(link: string): Promise<void> {
    const response = await askLocalConsole(REMOTE_HOSTS_PATH, { link });
    if (!response.ok) throw new Error(await readErrorCode(response));
    const added = await response.json() as { readonly host?: { readonly origin?: unknown } };
    const origin = typeof added.host?.origin === "string" ? added.host.origin : null;
    if (!origin) throw new Error("pairing_target_invalid");
    // OS가 넘긴 링크는 사람이 이 앱에 건넨 것이다 — 네이티브 입력으로 받는다.
    await deps.select({ origin });
  }

  function report(error: unknown): void {
    const code = error instanceof Error ? error.message : String(error);
    // 더 새로운 선택이 앞선 시도를 대신했을 뿐이다. 사람에게 말할 실패가 아니다.
    if (code === "surface_switch_superseded") return;
    deps.log?.(`remote bridge failed: ${code}`);
    deps.notify({ type: "error", title: "Could not open that console", body: describe(code) });
  }

  function listen(contents: AttachableContents, event: "will-navigate" | "did-navigate", listener: (...args: never[]) => void): void {
    contents.on(event as never, listener as never);
    attached.push({ contents, listener, event });
  }

  function currentOriginOf(contents: AttachableContents): string | null {
    try { return new URL(contents.getURL?.() ?? "").origin; } catch { return null; }
  }

  return {
    attachLocal(contents) {
      listen(contents, "will-navigate", ((event: { preventDefault: () => void }, url: string, _redirect?: unknown, isMainFrame?: boolean): void => {
        if (isMainFrame === false) return;
        const home = deps.localOrigin();
        /**
         * 피커 판정이 consoleTarget보다 먼저다. 센티넬도 홈의 `/console/`이라 아래 판정에
         * 걸리는데, 그러면 목록을 펼치는 대신 창째로 집에 돌아가 버린다.
         */
        const surface = pickerSurfaceOf(url, home);
        if (surface !== null) {
          event.preventDefault();
          if (surface === "open") void openPicker(url).catch(report);
          else closePicker();
          return;
        }
        const target = consoleTarget(url, home);
        // 자기 콘솔 안의 이동은 window policy의 몫이다.
        if (target === null || target === home) return;
        event.preventDefault();
        // 로컬 뷰는 이 앱이 띄운 콘솔이 그린 화면이다. 그래도 활성 로컬 main frame이 자기 origin에 서 있을 때만 선택으로 받는다.
        if (!deps.acceptsLocalSelection(contents) || currentOriginOf(contents) !== home) {
          deps.log?.("console selection ignored: the local view is not the active local surface");
          return;
        }
        void deps.select({ origin: target, url }).catch(report);
      }) as never);
    },

    attachData(contents) {
      listen(contents, "will-navigate", ((event: { preventDefault: () => void }, url: string, _redirect?: unknown, isMainFrame?: boolean): void => {
        if (isMainFrame === false) return;
        const surface = pickerSurfaceOf(url, deps.localOrigin());
        if (surface !== null) {
          event.preventDefault();
          if (surface === "dismiss") { closePicker(); return; }
          // 남의 콘솔이 서빙한 화면이 청할 수 있는 것은 덮개를 여는 일뿐이다. 그것도 간격을 둔다.
          if (now() - dataPickerAt < DATA_PICKER_INTERVAL_MS) { deps.log?.("host picker request from the data view throttled"); return; }
          dataPickerAt = now();
          void openPicker(url).catch(report);
          return;
        }
        const target = consoleTarget(url, deps.localOrigin());
        if (target === null || target === deps.policy()?.dataConsoleOrigin()) return;
        // 다른 콘솔로 가는 항해는 이 화면이 고를 수 있는 것이 아니다. 조용히 버린다.
        event.preventDefault();
        deps.log?.("console selection ignored: a data view cannot choose a console");
      }) as never);

      // 확인을 통과한 뒤에도 세션은 끊길 수 있다. 데이터 뷰가 오류 문서에 착지하면 끊김으로 알린다.
      listen(contents, "did-navigate", ((_event: unknown, url: string, httpResponseCode: number): void => {
        if (typeof httpResponseCode !== "number" || httpResponseCode < 400) return;
        const dataOrigin = deps.policy()?.dataConsoleOrigin() ?? null;
        let arrived: string | null = null;
        try { arrived = new URL(url).origin; } catch { return; }
        if (dataOrigin === null || arrived !== dataOrigin) return;
        deps.disconnect(httpResponseCode === 401 ? "expired" : "unavailable");
      }) as never);
    },

    attachPicker(contents) {
      listen(contents, "will-navigate", ((event: { preventDefault: () => void }, url: string, _redirect?: unknown, isMainFrame?: boolean): void => {
        if (isMainFrame === false) return;
        const home = deps.localOrigin();
        // 피커 안에서 다시 피커를 부르는 일은 없다. 스스로를 다시 여는 대신 조용히 닫는다.
        const surface = pickerSurfaceOf(url, home);
        if (surface !== null) {
          event.preventDefault();
          closePicker();
          return;
        }
        const target = consoleTarget(url, home);
        if (target === null) return;
        event.preventDefault();
        // 지금 떠 있는 이번 세대의 덮개가 집 origin에 서 있을 때만 그 선택을 받는다.
        if (!deps.isCurrentPicker(contents) || currentOriginOf(contents) !== home) {
          deps.log?.("console selection ignored: not the current host picker");
          closePicker();
          return;
        }
        /**
         * 고르고 난 뒤에는 성공이든 실패든 덮개를 걷는다. 실패한 채로 남기면 사용자는
         * 아무 일도 일어나지 않은 목록을 마주하고, 그 아래 멀쩡한 콘솔에는 손이 닿지 않는다.
         */
        void deps.select({ origin: target, url }).then(closePicker, (error: unknown) => { closePicker(); report(error); });
      }) as never);
    },
    prepare,
    endSession,
    receiveLink,
    report,
    dispose() {
      while (attached.length > 0) {
        const entry = attached.pop();
        if (!entry) continue;
        (entry.contents as unknown as { removeListener: (event: string, listener: (...args: never[]) => void) => void })
          .removeListener(entry.event, entry.listener);
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
 * 흉내 내도 여기서 걸린다. 그 밖에 실리는 것은 부른 콘솔의 origin과 누른 칩의 자리(정수 좌표)뿐이라
 * 이 URL이 새어도 알려지는 것이 없다. 셸은 둘 다 해석하지 않고 집의 화면에 넘기며, 모양은 그
 * 화면(readHostPickerSurface)이 본다.
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

/** 모양과 길이가 맞는 표현 상태 fragment만 넘긴다. 그 밖의 fragment는 원격 주소에 싣지 않는다. */
export function presentationCarryOf(url: string | undefined): string {
  if (url === undefined) return "";
  try {
    const { hash } = new URL(url);
    if (!hash.startsWith(PRESENTATION_CARRY_PREFIX)) return "";
    const payload = hash.slice(PRESENTATION_CARRY_PREFIX.length);
    return payload.length > 0 && payload.length <= PRESENTATION_CARRY_MAX_LENGTH && /^[A-Za-z0-9_-]+$/u.test(payload) ? hash : "";
  } catch {
    return "";
  }
}

export function consoleTarget(url: string, localOrigin: string | null): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith(CONSOLE_PATH)) return null;
    if (isRemoteConsoleOrigin(parsed.origin)) return parsed.origin;
    // 루프백 콘솔은 셸이 띄운 것이든 이 기계에서 발견한 것이든 이 다리를 거친다. 열어 줄지는
    // prepare()가 로컬 Console에 물어 정하고, 여기서는 window policy가 막기 전에 가로채기만 한다.
    if (!isLoopbackConsoleOrigin(parsed.origin)) return null;
    // 셸이 자기 콘솔을 아직 갖지 않았다면 물어볼 곳도 없다.
    return localOrigin === null ? null : parsed.origin;
  } catch {
    return null;
  }
}

/** 원격 콘솔의 입구. 요청 URL에서는 화면 모드만 읽는다 — 경로와 다른 쿼리는 원격 페이지가 정하게 두지 않는다. */
export function remoteConsoleEntry(origin: string, requestedUrl?: string): string {
  const entry = new URL(CONSOLE_PATH, `${origin}/`);
  try {
    if (requestedUrl !== undefined && new URL(requestedUrl).searchParams.get(MODE_PARAM) === MODE_ZEN) entry.searchParams.set(MODE_PARAM, MODE_ZEN);
  } catch {
    // 읽을 수 없는 URL은 기본 입구로 연다.
  }
  return entry.toString();
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
    /*
      세션이 끝난 것과 페어링을 잃은 것은 다른 사실이다. 콘솔이 재시작하면 세션은 메모리와 함께
      사라지지만 페어링은 남고, 이 창의 쿠키가 그 비밀을 아직 들고 있다 — 목록에서 다시 고르기만 하면
      그 선택의 조인이 그것을 새 세션으로 바꾼다. 여기서 "새 링크를 받아라"라고 말하면, 링크가 필요 없는
      사람에게 링크를 구하러 가게 만든다. 링크가 정말 필요한 경우는 remote_host_not_paired다.
    */
    case "remote_host_session_expired": return "That console ended this session — it may have restarted. Open it again from the host list to resume.";
    case "remote_link_host_mismatch": return "That console refused the link as meant for a different address.";
    // 인증서가 바뀌어 이 기기의 옛 자격을 지웠다. 새 신원과 짝지을 자격은 새 링크에만 있다.
    case "remote_host_link_required": return "That console's certificate changed, so this device's old access was removed. Ask for a fresh access link.";
    // 이 실행이 이 주소의 다른 인증서를 이미 믿었다. 그 판정은 앱을 다시 켜야 사라진다.
    case "remote_host_restart_required": return "This address already presented a different certificate while Fleet Desktop was running. Restart Fleet Desktop, then open it again.";
    case "remote_host_cookie_purge_unconfirmed": return "This device's old access to that console could not be cleared, so nothing was sent. Restart Fleet Desktop and try again.";
    // 로컬 화면이 화면 공유를 멈췄다고 답하지 않았다. 멈췄는지 모른 채 떠나지 않는다.
    case "surface_leave_unacknowledged": return "This console did not confirm that screen sharing stopped, so it stayed open. Try again in a moment.";
    case "remote_host_is_self": return "That link points back at this console.";
    case "pairing_target_invalid": return "That is not a Fleet Console access link.";
    // 덮개를 얹을 창이 없다. 목록은 이 셸이 띄운 콘솔에 그대로 있으므로 그리로 안내한다.
    case "remote_bridge_no_picker": return "The host list could not open here. Go back to this computer's console to switch machines.";
    default: return "The connection failed. This console remains available.";
  }
}
