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
    remove(url: string, name: string): Promise<void>;
  };
  closeAllConnections(): Promise<void>;
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
  /**
   * 한 콘솔이 발급한 쿠키를 창과 셸의 모든 항아리에서 이름으로 정확히 지운다. 인증서가 바뀐 호스트의 옛 자격이
   * 새 신원으로 가지 않게 하는 자리라, 지우는 동안 그 origin으로 가는 셸 요청은 막히고, 세션의 연결을 모두
   * 끊으며, 지워졌는지 다시 읽어 확인한다. 확인이 안 되면 던진다 — 부른 쪽은 자격을 보내지 않고 멈춘다.
   */
  purge(origin: string, cookieNames: readonly string[]): Promise<void>;
}

export function createShellNetwork(deps: ShellNetworkDeps): ShellNetwork {
  const windowPins = installRemoteCertificatePins(deps.windowSession, deps.log);
  const shellPins = installRemoteCertificatePins(deps.shellSession, deps.log);
  /** origin 별로 마지막에 베껴 온 쿠키의 모양. 같은 값이면 다시 쓰지 않는다. */
  const adopted = new Map<string, string>();
  /** 지우는 중인 origin과 그 세대. 지우기 전에 시작한 베끼기가 지운 뒤에 옛 값을 되살리지 못하게 한다. */
  const purging = new Set<string>();
  let purgeGeneration = 0;

  /** 창의 항아리가 원본이다. 원본에서 사라진 쿠키는 복사본에서도 지운다 — 복사본만 남은 자격이 요청에 실리지 않게. */
  const adopt = async (origin: string): Promise<void> => {
    const startedAt = purgeGeneration;
    const cookies = await deps.windowSession.cookies.get({ url: origin }).catch(() => []);
    const signature = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("\n");
    if (adopted.get(origin) === signature) return;
    const copies = await deps.shellSession.cookies.get({ url: origin }).catch(() => []);
    if (startedAt !== purgeGeneration || purging.has(origin)) throw new Error("shell_network_purging");
    const names = new Set(cookies.map((cookie) => cookie.name));
    for (const copy of copies) {
      if (!names.has(copy.name)) await deps.shellSession.cookies.remove(origin, copy.name).catch(() => undefined);
    }
    for (const cookie of cookies) {
      await deps.shellSession.cookies.set({ ...cookie, url: origin }).catch(() => undefined);
    }
    if (startedAt !== purgeGeneration || purging.has(origin)) throw new Error("shell_network_purging");
    adopted.set(origin, signature);
  };

  const consoleFetch: typeof fetch = (input, init) => {
    // 동기화기는 문자열 URL만 넘긴다. Request가 오면 조용히 다른 경로로 보내지 않고 기존 경로를 쓴다.
    if (typeof input !== "string" && !(input instanceof URL)) return globalThis.fetch(input, init);
    const url = typeof input === "string" ? input : input.href;
    const origin = new URL(url).origin;
    if (!deps.isRemote(origin)) return globalThis.fetch(url, init);
    if (purging.has(origin)) return Promise.reject(new Error("shell_network_purging"));
    return adopt(origin)
      .then(() => deps.shellSession.fetch(url, init))
      .then((response) => {
        // 자격이 갈렸다 — 다음 요청은 창의 항아리를 다시 본다. 그 사이 조인이 새 쿠키를 놓았을 수 있다.
        if (response.status === 401) adopted.delete(origin);
        return response;
      });
  };

  const purge = async (origin: string, cookieNames: readonly string[]): Promise<void> => {
    purging.add(origin);
    purgeGeneration += 1;
    adopted.delete(origin);
    try {
      for (const jar of [deps.windowSession, deps.shellSession]) {
        for (const name of cookieNames) await jar.cookies.remove(origin, name);
      }
      // 연결 풀에 쿠키가 남는 것은 아니지만, 그 자격을 실어 이미 열린 연결은 여기서 끝낸다.
      await Promise.all([deps.windowSession.closeAllConnections(), deps.shellSession.closeAllConnections()]);
      for (const jar of [deps.windowSession, deps.shellSession]) {
        const remaining = await jar.cookies.get({ url: origin });
        if (remaining.some((cookie) => cookieNames.includes(cookie.name))) throw new Error("remote_host_cookie_purge_unconfirmed");
      }
    } catch (error) {
      deps.log?.(`cookie purge failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error instanceof Error && error.message === "remote_host_cookie_purge_unconfirmed" ? error : new Error("remote_host_cookie_purge_unconfirmed", { cause: error });
    } finally {
      purging.delete(origin);
    }
  };

  return {
    fetch: consoleFetch,
    purge,
    pins: {
      pin(hostname, fingerprint): void { windowPins.pin(hostname, fingerprint); shellPins.pin(hostname, fingerprint); },
      unpin(hostname): void { windowPins.unpin(hostname); shellPins.unpin(hostname); },
      clear(): void { windowPins.clear(); shellPins.clear(); adopted.clear(); },
      trustedOtherIdentity: (hostname, fingerprint) => windowPins.trustedOtherIdentity(hostname, fingerprint) || shellPins.trustedOtherIdentity(hostname, fingerprint),
    },
  };
}
