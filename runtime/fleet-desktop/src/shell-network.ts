import { installRemoteCertificatePins, type PinnableSession, type RemoteCertificatePins } from "./remote-access.js";

/**
 * 셸이 콘솔과 주고받는 배관의 연결 예산.
 *
 * 브라우저는 origin 하나에 HTTP/1.1 연결을 여섯 개까지만 연다. 그 여섯은 콘솔 화면의 것이다 — Operation 스트림,
 * 패널의 스트림, 사람이 누른 버튼이 보내는 요청이 전부 거기서 나간다. 셸의 배관(스냅샷 구독과 relay)이 같은 항아리를
 * 쓰면 그 예산을 나눠 먹고, 다 차는 순간 화면에서 나가는 모든 요청이 조용히 큐에 갇힌다 — 눌러도 아무 일이 없고,
 * 스트림 하나가 닫히는 순간 그제야 밀린 요청이 한꺼번에 나간다.
 *
 * 로컬 콘솔에서는 이 일이 일어나지 않는다. 셸이 Node 의 fetch 를 쓰므로 창과 연결 풀이 애초에 다르기 때문이다.
 * 원격만 창의 세션을 타는 이유는 자체서명 인증서와 세션 쿠키 둘 다 거기 있어서였다 — 그 둘을 셸 전용 세션으로
 * 옮겨 오면 원격에서도 같은 격리가 선다.
 *
 * 쿠키는 창의 항아리가 원본이다. 조인은 언제나 창의 세션에서 이루어지고 세션 쿠키를 발급하는 자리도 그곳뿐이라,
 * 여기서는 그 값을 원격 origin 단위로 베껴 올 뿐 새로 만들지 않는다. 셸과 창이 같은 세션으로 보여야 하는 것은
 * 콘솔의 요구다 — 뷰를 그릴 셸을 제어 보유자의 세션 이름으로 고르므로, 셸이 따로 조인하면 그 창의 주인이 아니게 된다.
 */

export interface ShellCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly expirationDate?: number;
  readonly sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
}

/** Electron `Session` 가운데 이 배관이 실제로 읽고 쓰는 부분만 선언한다. */
export interface ShellNetworkSession extends PinnableSession {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  readonly cookies: {
    get(filter: { url: string }): Promise<readonly ShellCookie[]>;
    set(details: ShellCookie & { url: string }): Promise<void>;
  };
}

export interface ShellNetworkDeps {
  /** 창이 쓰는 세션 — 조인이 이루어지고 쿠키가 발급되는 곳. */
  readonly windowSession: ShellNetworkSession;
  /** 셸 전용 세션 — 창과 연결 풀을 나누지 않는 곳. */
  readonly shellSession: ShellNetworkSession;
  readonly isRemote: (origin: string) => boolean;
  readonly log?: (message: string) => void;
}

export interface ShellNetwork {
  /** 메인 프로세스가 콘솔에 보내는 모든 요청. 원격은 셸 세션으로, 나머지는 Node 의 fetch 로 간다. */
  readonly fetch: typeof fetch;
  /** 핀은 두 세션에 함께 걸린다 — 창이 열 수 있는 호스트는 셸도 열 수 있어야 한다. */
  readonly pins: RemoteCertificatePins;
}

export function createShellNetwork(deps: ShellNetworkDeps): ShellNetwork {
  const windowPins = installRemoteCertificatePins(deps.windowSession, deps.log);
  const shellPins = installRemoteCertificatePins(deps.shellSession, deps.log);
  /** origin 별로 마지막에 베껴 온 쿠키의 모양. 같은 값이면 다시 쓰지 않는다. */
  const adopted = new Map<string, string>();

  const adopt = async (origin: string): Promise<void> => {
    const cookies = await deps.windowSession.cookies.get({ url: origin }).catch(() => []);
    const signature = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("\n");
    if (adopted.get(origin) === signature) return;
    for (const cookie of cookies) {
      await deps.shellSession.cookies.set({ ...cookie, url: origin }).catch(() => undefined);
    }
    adopted.set(origin, signature);
  };

  const consoleFetch: typeof fetch = (input, init) => {
    // 동기화기는 문자열 URL만 넘긴다. Request가 오면 조용히 다른 경로로 보내지 않고 기존 경로를 쓴다.
    if (typeof input !== "string" && !(input instanceof URL)) return globalThis.fetch(input, init);
    const url = typeof input === "string" ? input : input.href;
    const origin = new URL(url).origin;
    if (!deps.isRemote(origin)) return globalThis.fetch(url, init);
    return adopt(origin)
      .then(() => deps.shellSession.fetch(url, init))
      .then((response) => {
        // 자격이 갈렸다 — 다음 요청은 창의 항아리를 다시 본다. 그 사이 조인이 새 쿠키를 놓았을 수 있다.
        if (response.status === 401) adopted.delete(origin);
        return response;
      });
  };

  return {
    fetch: consoleFetch,
    pins: {
      pin(hostname, fingerprint): void { windowPins.pin(hostname, fingerprint); shellPins.pin(hostname, fingerprint); },
      unpin(hostname): void { windowPins.unpin(hostname); shellPins.unpin(hostname); },
      clear(): void { windowPins.clear(); shellPins.clear(); adopted.clear(); },
    },
  };
}
