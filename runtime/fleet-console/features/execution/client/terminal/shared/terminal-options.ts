type OpenWindow = (url: string, target: string, features: string) => unknown;
type ConfirmNavigation = (url: string) => boolean;
/** 「어디서 열까」를 묻는 문. 문이 그 링크를 맡았으면 true — 맡지 않은 표면은 아래 기본 경로로 떨어진다. */
type ChooseTarget = (url: string, event: MouseEvent) => boolean;

/**
 * 열어도 되는 주소인가. http(s)만 통과하며, 통과한 값은 정규화된 href다.
 *
 * 터미널의 OSC 8·맨 URL과 채팅 본문의 앵커가 같은 문을 쓴다 — 어느 표면에서 눌렀든 열리는 스킴은 하나다.
 */
export function httpLinkHref(text: string): string | null {
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    // Ignore malformed OSC 8 links emitted by terminal applications.
    return null;
  }
}

/**
 * 터미널에서 주소를 여는 한 경로 — OSC 8 하이퍼링크와 본문에서 찾아낸 맨 URL이 같은 문을 지난다.
 *
 * Operation의 CLI에는 「어디서 열까」를 묻는 문이 있고, 그 물음 자체가 확인이다. 그 문이 없는
 * 표면(Operation이 아닌 전역 Shell)은 옛 계약 그대로 확인을 받고 새 창으로 연다.
 */
export function createTerminalLinkRoute(deps: {
  readonly chooseTarget: ChooseTarget;
  readonly openWindow: OpenWindow;
  readonly confirmNavigation: ConfirmNavigation;
}): (event: MouseEvent, text: string) => void {
  return (event, text) => {
    const href = httpLinkHref(text);
    if (href === null) return;
    if (deps.chooseTarget(href, event)) return;
    if (!deps.confirmNavigation(href)) return;
    deps.openWindow(href, "_blank", "noopener,noreferrer");
  };
}

export function createTerminalLinkHandler(route: (event: MouseEvent, text: string) => void) {
  return {
    activate(event: MouseEvent, text: string): void {
      route(event, text);
    },
  };
}

export const TERMINAL_OPTIONS = {
  // Unicode11Addon은 terminal.unicode(proposed API)를 사용하므로 이 옵션이 true여야 한다.
  // false이면 addon.activate()가 "must set allowProposedApi" 오류를 던져 터미널 마운트가 깨진다.
  allowProposedApi: true,
  // allowTransparency는 여기에 없다 — 해석된 배경의 알파에서 파생시켜야 하며
  // terminal-surface의 terminalFieldIsTranslucent()가 그 단일 판정을 소유한다.
  // 상수 true는 불투명 배경에서도 글리프 래스터 경로를 바꿔 획을 갉아먹는다(아래).
  // PTY 기반 TUI(nvim 등)는 raw LF와 cursor 제어 시퀀스를 직접 관리한다.
  // LF를 CRLF로 변환하면 alternate screen에서 열 위치가 틀어져 화면이 깨질 수 있다.
  convertEol: false,
  cursorBlink: true,
  cursorStyle: "block" as const,
  // linkHandler는 여기에 없다 — 링크를 어디서 여는지는 표면마다 다르므로(Operation은 고르는 문,
  // 전역 Shell은 확인 뒤 새 창) 마운트할 때 terminal-surface가 자기 경로를 싣는다.
  // xterm의 기본 OSC 8 처리는 about:blank를 먼저 열고 URL을 나중에 넣는데, 샌드박스된 Desktop은
  // 그 빈 팝업을 정당하게 거부한다. 그래서 어느 경로든 검증된 URL을 첫 요청에 함께 싣는다.
  lineHeight: 1,
};
