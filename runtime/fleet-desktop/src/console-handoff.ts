/**
 * 창을 다른 콘솔로 넘길 때의 순서.
 *
 * 네 가지 일이 일어나는데 그중 하나만 순서가 계약이다: **집 주소는 창보다 먼저 가야 한다.**
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
  readonly synchronizeFullscreen: (origin: string) => void;
  /** 게시를 기다려 주는 시간. 테스트가 실제 시계를 기다리지 않도록 갈아 끼울 수 있게 둔다. */
  readonly waitForPublishDeadline?: (ms: number) => Promise<void>;
}

/** 루프백 한 번 왕복에 넉넉하고, 사용자가 창이 멈췄다고 느끼기에는 짧은 값. */
const PUBLISH_DEADLINE_MS = 2_000;

export async function handOffWindowToConsole(deps: ConsoleHandoffDeps, url: string): Promise<void> {
  const origin = new URL(url).origin;
  const deadline = deps.waitForPublishDeadline ?? sleep;
  // 게시가 실패해도, 답하지 않아도 항해는 계속된다. 그 판단이 한 곳에서만 참이 되도록 여기서 막는다.
  await Promise.race([
    deps.publishShellHome(origin).catch(() => undefined),
    deadline(PUBLISH_DEADLINE_MS),
  ]);
  await deps.loadUrl(url);
  // 창이 옮겨 갔으면 타이틀바·전체화면 동기화도 그 콘솔을 따라가야 한다.
  await deps.synchronizeTheme(origin);
  deps.synchronizeFullscreen(origin);
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
