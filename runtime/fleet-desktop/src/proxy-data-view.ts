import type { Session, WebContents, WebContentsView } from "electron";

import { awaitReady } from "./data-view.js";
import type { ProxyEpoch } from "./proxy-broker-client.js";

/**
 * 읽기 전용 원격 화면(A′)을 그리는 격리된 데이터 뷰.
 *
 * 이 뷰는 로컬 번들을 로컬 루프백의 epoch 리스너에서 받아 원격 데이터를 그린다. 인가는 epoch마다 새로 만드는
 * in-memory partition에만 있는 capability 쿠키다 — 포트는 인가가 아니다. 그래서 partition은 epoch마다 새것이고
 * 다시 쓰지 않으며, 그 partition에 대한 정책(네트워크·권한·다운로드·항해·창·인증·WebRTC·proxy)은 **첫 항해 전에**
 * 모두 설치하고, 정리가 끝날 때까지 풀지 않는다.
 *
 * 네트워크 출구는 세 겹이다. webRequest는 epoch origin 밖의 요청을 모두 취소한다. partition의 proxy는 epoch
 * 리스너 자신이라, webRequest 밖으로 나가는 요청(WebRTC TCP, 다른 루프백 포트 포함)은 그 리스너의 고정 거부에
 * 닿는다. WebRTC는 proxy를 거치지 않는 UDP를 쓰지 않는다. proxy가 실제로 그렇게 서 있는지 적재 전에 확인하고,
 * 확인되지 않으면 이 뷰를 쓰지 않는다(부른 쪽이 직결로 간다).
 *
 * 정리는 뷰를 파괴하는 것만으로 끝나지 않는다. 먼저 모든 요청을 막고, 렌더러와 worker를 닫아 저장소를 쓰는 쪽을
 * 없앤 뒤, 저장소·캐시·쿠키·연결을 명시적으로 비우고 비었는지 확인한다. 다른 뷰와 렌더러 프로세스를 나눌 수
 * 있으므로 렌더러를 강제로 죽이지 않는다.
 */

const PARTITION_PREFIX = "fleet-data-";
const CLOSE_TIMEOUT_MS = 3_000;

export interface ProxyDataViewDeps {
  readonly sessionFor: (partition: string) => Session;
  readonly createView: (partition: string) => WebContentsView;
  /** 이 뷰의 입력 — 피커 센티널만 받는다. */
  readonly attach: (contents: WebContents, epochOrigin: string) => void;
  readonly log?: (message: string) => void;
}

export interface ProxyDataSurface {
  readonly epoch: Pick<ProxyEpoch, "epochId" | "generation" | "origin">;
  readonly view: WebContentsView;
  readonly contents: WebContents;
  /** 적재하고 도착·준비 표식까지 기다린다. */
  load(url: string): Promise<void>;
  /** 모든 요청과 입력을 막는다. 정리의 첫 단계이며 동기적이다. */
  seal(): void;
  /** 봉인 → 렌더러 종료 → 저장소·캐시·쿠키·연결 정리 → 확인. 확인이 안 되면 던진다. */
  teardown(): Promise<void>;
}

export interface ProxyDataViews {
  /**
   * epoch 하나의 격리된 뷰를 만든다. partition 정책과 capability 쿠키를 먼저 세우고 확인한 뒤에만 돌려준다.
   * 어느 하나라도 확인되지 않으면 만든 것을 모두 정리하고 던진다.
   */
  open(epoch: ProxyEpoch): Promise<ProxyDataSurface>;
  /** 정리를 확인하지 못한 적이 있는가. 그렇다면 이 실행에서는 더 이상 격리 뷰를 열지 않는다. */
  unusable(): boolean;
}

export function createProxyDataViews(deps: ProxyDataViewDeps): ProxyDataViews {
  const used = new Set<string>();
  let poisoned = false;

  return {
    unusable: () => poisoned,

    async open(epoch) {
      if (poisoned) throw new Error("proxy_view_unavailable");
      const partition = `${PARTITION_PREFIX}${epoch.epochId}`;
      // in-memory(persist: 없음)이고, 한 번 쓴 이름은 다시 쓰지 않는다.
      if (used.has(partition)) throw new Error("proxy_partition_reused");
      used.add(partition);
      const epochOrigin = new URL(epoch.origin).origin;
      const authority = new URL(epoch.origin).host;
      const session = deps.sessionFor(partition);
      let sealed = false;

      // ── partition 정책: 첫 항해 전에 모두 세운다 ──
      session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
        callback({ cancel: sealed || !sameOrigin(details.url, epochOrigin) });
      });
      session.setPermissionCheckHandler(() => false);
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.setDisplayMediaRequestHandler((_request, callback) => { try { callback({}); } catch { /* 거절은 빈 답으로 끝난다. */ } });
      session.on("will-download", (event) => event.preventDefault());
      session.setSpellCheckerEnabled(false);
      // `<-loopback>`은 앞에 둔다 — 뒤에 두면 Chromium이 앞선 우회 규칙까지 지워 epoch origin도 proxy로 간다(실측).
      await session.setProxy({ mode: "fixed_servers", proxyRules: `http://${authority}`, proxyBypassRules: `<-loopback>;${authority}` });

      const teardownSession = async (): Promise<void> => {
        sealed = true;
        await session.clearStorageData();
        await session.clearCache();
        await session.closeAllConnections();
        const remaining = await session.cookies.get({});
        if (remaining.length > 0) throw new Error("proxy_cleanup_unconfirmed");
      };

      try {
        await verifyIsolation(session, epochOrigin, authority, deps.log);
        await setCapability(session, epoch, deps.log);
      } catch (error) {
        await teardownSession().catch(() => { poisoned = true; });
        throw error;
      }

      const view = deps.createView(partition);
      const contents = view.webContents;
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      const confine = (event: { preventDefault(): void }, url: string): void => {
        if (sealed || !isEpochConsoleUrl(url, epochOrigin)) event.preventDefault();
      };
      contents.on("will-navigate", confine);
      contents.on("will-frame-navigate", (event) => { if (sealed || !isEpochConsoleUrl(event.url, epochOrigin)) event.preventDefault(); });
      contents.on("will-redirect", confine);
      contents.on("will-attach-webview", (event) => event.preventDefault());
      contents.on("before-input-event", (event) => { if (sealed) event.preventDefault(); });
      (contents as unknown as { on(event: string, listener: (...args: never[]) => void): void })
        .on("select-client-certificate", ((event: { preventDefault(): void }, _url: string, _list: unknown, callback: () => void) => { event.preventDefault(); callback(); }) as never);
      contents.on("login", (event, _details, _authInfo, callback) => { event.preventDefault(); callback(); });
      deps.attach(contents, epochOrigin);

      const surface: ProxyDataSurface = {
        epoch: { epochId: epoch.epochId, generation: epoch.generation, origin: epochOrigin },
        view,
        contents,
        async load(url) {
          if (!isEpochConsoleUrl(url, epochOrigin)) throw new Error("proxy_view_url_invalid");
          const ready = awaitReady(contents, epochOrigin);
          try {
            await contents.loadURL(url);
          } catch (error) {
            ready.cancel();
            throw error;
          }
          await ready.promise;
        },
        seal() { sealed = true; },
        async teardown() {
          sealed = true;
          // 렌더러와 그 worker를 먼저 닫는다 — 살아 있는 문서가 정리 도중 저장소를 다시 쓰지 못하게.
          await closeContents(contents);
          try {
            await teardownSession();
          } catch (error) {
            poisoned = true;
            deps.log?.(`proxy view cleanup unconfirmed epoch=${epoch.epochId}`);
            throw error instanceof Error && error.message === "proxy_cleanup_unconfirmed" ? error : new Error("proxy_cleanup_unconfirmed", { cause: error });
          }
          deps.log?.(`proxy view cleaned epoch=${epoch.epochId}`);
        },
      };
      return surface;
    },
  };
}

/**
 * proxy가 계약대로 섰는지 본다: 바깥 주소와 다른 루프백 포트는 epoch 리스너로, epoch origin만 직접. 셋 중 하나라도
 * 어긋나면 이 뷰는 격리를 약속할 수 없다.
 */
async function verifyIsolation(session: Session, epochOrigin: string, authority: string, log?: (message: string) => void): Promise<void> {
  const port = Number(new URL(epochOrigin).port);
  const neighbour = port < 65_535 ? port + 1 : port - 1;
  // 같은 포트라도 다른 이름(localhost, IPv6)과 이웃 포트는 우회되지 않아야 한다 — Chromium의 암묵 루프백 우회가 여기서 드러난다.
  const [external, loopback, own, ...aliases] = await Promise.all([
    session.resolveProxy("https://example.com/"),
    session.resolveProxy(`http://127.0.0.1:${neighbour}/`),
    session.resolveProxy(`${epochOrigin}/console/`),
    session.resolveProxy(`http://localhost:${port}/`),
    session.resolveProxy(`http://[::1]:${port}/`),
  ]);
  const proxied = (value: string): boolean => value.trim() === `PROXY ${authority}`;
  if (!proxied(external) || !proxied(loopback) || own.trim() !== "DIRECT" || !aliases.every(proxied)) {
    // 판정 값에는 비밀이 없다 — proxy 규칙과 루프백 주소뿐이다. 어느 경로가 어긋났는지 남긴다.
    log?.(`proxy isolation unverified external=${external.slice(0, 64)} loopback=${loopback.slice(0, 64)} own=${own.slice(0, 64)}`);
    throw new Error("proxy_isolation_unverified");
  }
}

/**
 * capability를 이 partition의 쿠키로만 옮긴다 — host-only, HttpOnly, SameSite=Strict. 평문 루프백에서 Secure가
 * 받아들여지면 싣고, 아니면 빼되 그 사실을 남긴다(Secure의 보호는 HTTPS와 같지 않다). 들어갔는지 다시 읽어 확인한다.
 */
async function setCapability(session: Session, epoch: ProxyEpoch, log?: (message: string) => void): Promise<void> {
  const url = `${new URL(epoch.origin).origin}/`;
  const base = { url, name: epoch.cookieName, value: epoch.capability, httpOnly: true, sameSite: "strict" as const, path: "/" };
  let secure = true;
  try {
    await session.cookies.set({ ...base, secure: true });
  } catch {
    secure = false;
    await session.cookies.set(base);
  }
  const stored = await session.cookies.get({ url, name: epoch.cookieName });
  if (stored.length !== 1 || !stored[0]?.httpOnly) throw new Error("proxy_capability_unset");
  log?.(`proxy capability cookie set secure=${secure && stored[0].secure === true}`);
}

function closeContents(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
    contents.once("destroyed", () => { clearTimeout(timer); resolve(); });
    try { contents.close({ waitForBeforeUnload: false }); } catch { clearTimeout(timer); resolve(); }
  });
}

function sameOrigin(url: string, origin: string): boolean {
  try { return new URL(url).origin === origin; } catch { return false; }
}

function isEpochConsoleUrl(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && parsed.pathname.startsWith("/console/");
  } catch {
    return false;
  }
}
