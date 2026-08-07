import type { WebContents } from "electron";

import { isRemoteConsoleOrigin } from "./console-origin.js";
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
  readonly loadConsole: (url: string) => Promise<void>;
  readonly notify: (notice: DesktopNotice) => void;
  readonly log?: (message: string) => void;
  readonly confirmIdentity?: (hostname: string, port: number, fingerprint: string) => Promise<void>;
}

export interface RemoteBridge {
  attach(contents: Pick<WebContents, "on" | "removeListener">): void;
  /** 목록에 이미 있는 호스트를 연다. */
  open(origin: string): Promise<void>;
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
const REMOTE_HOSTS_PATH = "/api/v1/remote-hosts";
const CONSOLE_PATH = "/console/";
const JOIN_PATH = "/api/v1/join";

export function createRemoteBridge(deps: RemoteBridgeDeps): RemoteBridge {
  const localFetch = deps.localFetch ?? globalThis.fetch;
  const confirmIdentity = deps.confirmIdentity ?? confirmRemoteIdentity;
  const attached: Array<{ readonly contents: Pick<WebContents, "on" | "removeListener">; readonly listener: (...args: never[]) => void }> = [];

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

  async function open(origin: string): Promise<void> {
    // 집으로 돌아가는 길에는 핀도 자격도 필요 없다 — 루프백은 언제나 허용된 origin이다.
    if (origin === deps.localOrigin()) return openLocal(origin);
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
      // 자격은 한 번뿐이다. 이미 세션 쿠키가 있으면 token은 비어 오고, 그때는 조인을 건너뛴다.
      if (handoff.token) await joinRemoteConsole(deps.sessionFetch, `${handoff.origin}${JOIN_PATH}`, handoff.token);
      await deps.loadConsole(`${handoff.origin}${CONSOLE_PATH}`);
      policy.commitConsoleOrigin();
    } catch (error) {
      policy.cancelPendingConsoleOrigin();
      policy.withdrawRemoteConsoleOrigin(handoff.origin);
      deps.pins.unpin(handoff.hostname);
      throw error;
    }
  }

  async function openLocal(origin: string): Promise<void> {
    const policy = deps.policy();
    if (!policy) throw new Error("remote_bridge_no_window");
    policy.activateConsoleOrigin(origin);
    await deps.loadConsole(`${origin}${CONSOLE_PATH}`);
  }

  async function receiveLink(link: string): Promise<void> {
    const response = await askLocalConsole(REMOTE_HOSTS_PATH, { link });
    if (!response.ok) throw new Error(await readErrorCode(response));
    const added = await response.json() as { readonly host?: { readonly origin?: unknown } };
    const origin = typeof added.host?.origin === "string" ? added.host.origin : null;
    if (!origin) throw new Error("pairing_target_invalid");
    await open(origin);
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
        const target = consoleTarget(url, deps.localOrigin());
        // 이미 활성인 콘솔 안에서의 이동은 window policy의 몫이다.
        if (target === null || target === deps.policy()?.currentConsoleOrigin()) return;
        event.preventDefault();
        void open(target).catch(report);
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
        entry?.contents.removeListener("will-navigate", entry.listener as never);
      }
    },
  };
}

/**
 * 콘솔을 갈아타려는 항해만 이 다리가 가로챈다 — 원격으로 나가는 길과, 셸이 띄운 로컬 콘솔로
 * 돌아오는 길. 돌아오는 길도 여기를 거쳐야 하는 이유는 window policy가 활성 origin 밖으로의
 * 항해를 막기 때문이다.
 */
export function consoleTarget(url: string, localOrigin: string | null): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith(CONSOLE_PATH)) return null;
    if (isRemoteConsoleOrigin(parsed.origin)) return parsed.origin;
    return localOrigin !== null && parsed.origin === localOrigin ? parsed.origin : null;
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
    case "remote_link_host_mismatch": return "That console refused the link as meant for a different address.";
    case "remote_host_is_self": return "That link points back at this console.";
    case "pairing_target_invalid": return "That is not a Fleet Console access link.";
    default: return "The connection failed. This console remains available.";
  }
}
