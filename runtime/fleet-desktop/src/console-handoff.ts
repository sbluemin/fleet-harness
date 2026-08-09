/**
 * 창을 다른 콘솔로 넘길 때의 순서.
 *
 * 네 가지 일이 일어나는데 그중 하나만 순서가 계약이다: **집 주소는 창보다 먼저 가야 한다.**
 * 도착한 화면은 뜨자마자 "돌아갈 곳"을 한 번 묻고 다시 묻지 않으므로, 창이 먼저 도착하면
 * 그 물음은 빈손으로 끝나고 그 콘솔에는 돌아가는 줄이 서지 않는다. 적재가 끝난 뒤에 게시하면
 * 둘 중 무엇이 먼저인지는 그때그때 달라진다 — 돌아갈 길이 붙었다 떨어졌다 하는 이유가 그것이다.
 *
 * 게시가 실패해도 항해는 막지 않는다. 이 라우트를 모르는 옛 콘솔도 열려야 하고, 돌아갈 길
 * 하나를 지키려다 가는 길까지 막으면 사용자가 잃는 쪽이 더 크다. 실패는 로그로만 남는다.
 */
export interface ConsoleHandoffDeps {
  /** 이 콘솔에 "이 셸이 띄운 콘솔은 어디인가"를 알린다. 실패는 삼키고 로그로 남긴다. */
  readonly publishShellHome: (origin: string) => Promise<void>;
  readonly loadUrl: (url: string) => Promise<void>;
  readonly synchronizeTheme: (origin: string) => Promise<void>;
  readonly synchronizeFullscreen: (origin: string) => void;
}

export async function handOffWindowToConsole(deps: ConsoleHandoffDeps, url: string): Promise<void> {
  const origin = new URL(url).origin;
  // 게시가 실패해도 항해는 계속된다. 그 판단이 한 곳에서만 참이 되도록 여기서 막는다.
  await deps.publishShellHome(origin).catch(() => undefined);
  await deps.loadUrl(url);
  // 창이 옮겨 갔으면 타이틀바·전체화면 동기화도 그 콘솔을 따라가야 한다.
  await deps.synchronizeTheme(origin);
  deps.synchronizeFullscreen(origin);
}
