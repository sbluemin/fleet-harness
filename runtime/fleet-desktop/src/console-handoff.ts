import { CONSOLE_SECTION_COMMAND } from "@fleet-console/protocol/desktop/console-section";

/**
 * 창을 다른 콘솔로 넘길 때의 순서.
 *
 * 세 가지 일이 일어나는데 그중 하나만 순서가 계약이다: **집 주소는 창보다 먼저 가야 한다.**
 * 도착한 화면은 뜨자마자 "돌아갈 곳"을 한 번 묻고 다시 묻지 않으므로, 창이 먼저 도착하면
 * 그 물음은 빈손으로 끝나고 그 콘솔에는 돌아가는 줄이 서지 않는다. 적재가 끝난 뒤에 게시하면
 * 둘 중 무엇이 먼저인지는 그때그때 달라진다 — 돌아갈 길이 붙었다 떨어졌다 하는 이유가 그것이다.
 *
 * 게시가 실패해도, 그리고 끝내 답하지 않아도 항해는 막지 않는다. 이 라우트를 모르는 옛 콘솔도
 * 열려야 하고, 돌아갈 길 하나를 지키려다 가는 길까지 막으면 사용자가 잃는 쪽이 더 크다.
 * 거절은 catch가 받지만 **침묵은 catch가 받지 못하므로**, 기다림에는 끝이 있어야 한다 —
 * 없으면 응답하지 않는 콘솔 하나가 창을 영영 옛 화면에 붙들어 둔다.
 */
export interface ConsoleHandoffDeps {
  /** 이 콘솔에 "이 셸이 띄운 콘솔은 어디인가"를 알린다. 실패는 삼키고 로그로 남긴다. */
  readonly publishShellHome: (origin: string) => Promise<void>;
  readonly loadUrl: (url: string) => Promise<void>;
  readonly synchronizeTheme: (origin: string) => Promise<void>;
  /** 게시를 기다려 주는 시간. 테스트가 실제 시계를 기다리지 않도록 갈아 끼울 수 있게 둔다. */
  readonly waitForPublishDeadline?: (ms: number) => Promise<void>;
  /**
   * 지금 화면을 붙잡는다(switch-hold). 커밋 순간의 빈 프레임과 새 콘솔의 부팅 셸이 그 판 아래로 숨는다.
   * 붙잡지 못해도 항해는 막지 않는다.
   */
  readonly holdScreen?: () => Promise<void>;
  /**
   * 적재 전에 창을 새 콘솔 쪽으로 미리 돌린다 — 옛 콘솔의 브라우저 뷰를 내리고, 새 콘솔의 테마와 전체화면을 먼저
   * 맞추고, 그 콘솔의 창 명령(ready)을 듣기 시작한다. 판을 붙잡은 뒤라 이 변화는 판 아래에서 일어난다.
   */
  readonly prepare?: (origin: string) => Promise<void>;
  /** 적재가 실패했다 — 창이 아직 서 있는 콘솔로 그 동기화들을 되돌린다. */
  readonly restore?: () => Promise<void>;
  /** 창이 그 콘솔의 문서를 다 받았다. */
  readonly loaded?: (origin: string) => void;
}

/** 루프백 한 번 왕복에 넉넉하고, 사용자가 창이 멈췄다고 느끼기에는 짧은 값. */
const PUBLISH_DEADLINE_MS = 2_000;

export async function handOffWindowToConsole(deps: ConsoleHandoffDeps, url: string): Promise<void> {
  const origin = new URL(url).origin;
  const deadline = deps.waitForPublishDeadline ?? sleep;
  // 게시가 실패해도, 답하지 않아도 항해는 계속된다. 그 판단이 한 곳에서만 참이 되도록 여기서 막는다.
  // 게시는 창보다 먼저 끝나야 한다. 화면을 붙잡는 일은 로컬이라 그 왕복을 기다리는 동안 같이 한다.
  // 미리 돌리기(테마·ready 구독)는 적재 앞에 남아 있다 — 스트림을 적재 뒤에 열면 그 틈의 ready를 잃는다.
  const published = Promise.race([
    deps.publishShellHome(origin).catch(() => undefined),
    deadline(PUBLISH_DEADLINE_MS),
  ]);
  const held = deps.holdScreen?.().catch(() => undefined) ?? Promise.resolve();
  await Promise.all([published, held]);
  await deps.prepare?.(origin).catch(() => undefined);
  try {
    await deps.loadUrl(url);
  } catch (error) {
    await deps.restore?.().catch(() => undefined);
    throw error;
  }
  deps.loaded?.(origin);
  // 창이 옮겨 갔으면 타이틀바 동기화도 그 콘솔을 따라가야 한다.
  await deps.synchronizeTheme(origin);
}

/**
 * 셸에게 보내는 신호 — 화면이 이 쿼리로 main frame 항해를 걸면 셸이 will-navigate에서 막고 그 뜻만 받는다
 * (console-section-controller, remote-bridge의 피커, window-policy의 서체 동의). 그래서 이 항해는 어디로도 가지 않는다.
 * Console 내부를 import하지 않고 여기서 선언하는 것은 remote-bridge·window-policy와 같은 방식이다.
 */
const SHELL_SIGNAL_PARAM = "desktop-surface";
const SHELL_SIGNAL_SURFACES: ReadonlySet<string> = new Set([CONSOLE_SECTION_COMMAND, "host-picker", "host-picker-dismiss", "local-fonts"]);

function isShellSignal(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.pathname.startsWith("/console/") && SHELL_SIGNAL_SURFACES.has(parsed.searchParams.get(SHELL_SIGNAL_PARAM) ?? "");
  } catch {
    return false;
  }
}

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

/** Electron의 loadURL이 내는 오류와 같은 모양 — 로그와 안내가 진짜 실패를 지금과 똑같이 읽는다. */
function loadError(errno: number, code: string, url: string): Error {
  return Object.assign(new Error(`${code} (${errno}) loading '${url.slice(0, 2048)}'`), { errno, code, url });
}

type ContentsListener = (...args: unknown[]) => void;
export interface ConsoleDocumentContents {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  on(event: string, listener: ContentsListener): unknown;
  removeListener(event: string, listener: ContentsListener): unknown;
}

/**
 * 창에 콘솔 문서를 싣는다.
 *
 * Electron의 loadURL은 적재 중에 main frame에서 다른 항해가 *시작*되기만 해도 그 URL로 ERR_ABORTED를 낸다.
 * 콘솔을 옮기는 동안 떠나는 문서는 아직 살아 있어 셸에게 신호(포커스 때의 섹션 상태 요청 등)를 보낼 수 있는데,
 * 셸이 그 항해를 막으므로 대상 적재는 그대로 계속되고 창은 도착한다. 그 거절을 적재 실패로 읽으면 도착한 창을
 * 두고 정책·핀·배관을 되돌리고 실패를 안내한다. 그래서 셸 신호 때문인 거절만 삼키고, 판정은 대상 항해의 실제
 * 결과에 맡긴다: 완료면 성공, 대상의 실패·다른 항해에 밀림·적재 중단이면 거절이다. 그 밖의 거절은 그대로 낸다.
 */
export function loadConsoleDocument(contents: ConsoleDocumentContents, url: string): Promise<void> {
  const target = originOf(url);
  return new Promise<void>((resolve, reject) => {
    let signalled: Error | null = null;
    let settled = false;
    const listeners: Array<[string, ContentsListener]> = [];
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      for (const [event, listener] of listeners) contents.removeListener(event, listener);
      if (error) reject(error); else resolve();
    };
    const listen = (event: string, listener: ContentsListener): void => {
      listeners.push([event, listener]);
      contents.on(event, listener);
    };
    // 신호가 끼어든 뒤에만 판정한다 — 그 전에는 loadURL 자신의 판정이 그대로 결과다.
    listen("did-finish-load", () => {
      if (!signalled) return;
      // 막힌 신호는 커밋되지 않는다. 그래도 창이 대상 콘솔에 서 있는지 확인한 뒤에만 성공이라 한다.
      settle(target !== null && originOf(contents.getURL()) === target ? undefined : signalled);
    });
    listen("did-fail-load", ((_event: unknown, errno: number, code: string, failedUrl: string, isMainFrame: boolean) => {
      if (signalled && isMainFrame && !isShellSignal(failedUrl)) settle(loadError(errno, code, failedUrl));
    }) as ContentsListener);
    listen("did-start-navigation", ((details: { url?: string; isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (!signalled || !details.isMainFrame || details.isSameDocument || isShellSignal(details.url)) return;
      // 셸 신호가 아닌 새 항해가 대상을 밀어냈다 — loadURL이 하던 판정 그대로다.
      settle(loadError(-3, "ERR_ABORTED", details.url ?? url));
    }) as ContentsListener);
    const stopped = (): void => { if (signalled) settle(loadError(-2, "ERR_FAILED", url)); };
    listen("did-stop-loading", stopped);
    listen("destroyed", stopped);
    contents.loadURL(url).then(() => settle(), (error: unknown) => {
      const abort = error as { code?: unknown; url?: unknown } | null;
      if (!settled && abort?.code === "ERR_ABORTED" && isShellSignal(abort.url)) {
        signalled = error instanceof Error ? error : loadError(-3, "ERR_ABORTED", String(abort.url));
        return;
      }
      settle(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** 이 타이머 하나 때문에 앱이 종료를 미루지는 않는다. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 게시 한 번의 결과. 401은 실패가 아니라 "세션이 아직 없다"이며, 그 구분이 아래 재시도의 근거다. */
export type ShellHomePublication = "accepted" | "unauthorized" | "rejected" | "failed";

export interface ShellHomeArrivalDeps {
  readonly publish: (origin: string) => Promise<ShellHomePublication>;
  /** 창이 아직 그 콘솔에 있는가. 다른 곳으로 옮겨 갔으면 남의 콘솔에 집을 게시하지 않는다. */
  readonly stillAt: (origin: string) => boolean;
  readonly wait?: (ms: number) => Promise<void>;
}

/** 화면이 페어링으로 세션을 되살리는 데 드는 시간을 넉넉히 덮고, 그 뒤로는 두드리지 않는다. */
const ARRIVAL_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/**
 * 창이 셸의 손을 거치지 않고 다시 도착했을 때의 게시 — 새로고침, 그리고 재기동한 콘솔에 화면이
 * 스스로 되돌아온 경우.
 *
 * 위의 handoff는 도착 *전에* 게시하지만, 재기동한 콘솔은 그 게시를 잊었고 세션도 잊었다.
 * 세션은 화면이 자기 페어링으로 되살리므로, 그보다 먼저 보낸 게시는 401로 돌아온다. 그래서
 * 받아들여지거나 분명히 거절될 때까지 정해진 횟수만 다시 보낸다. 게시가 끝내 서지 않으면
 * 원격 콘솔이 이 기계의 집 행세를 한다 — 그 창의 호스트 목록에서 돌아갈 줄이 사라지므로.
 */
export async function republishShellHomeOnArrival(deps: ShellHomeArrivalDeps, origin: string): Promise<ShellHomePublication> {
  const wait = deps.wait ?? sleep;
  let outcome = await deps.publish(origin);
  for (const delay of ARRIVAL_RETRY_DELAYS_MS) {
    if (outcome === "accepted" || outcome === "rejected") return outcome;
    await wait(delay);
    if (!deps.stillAt(origin)) return outcome;
    outcome = await deps.publish(origin);
  }
  return outcome;
}
