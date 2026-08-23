type OpenWindow = (url: string, target: string, features: string) => unknown;
type ConfirmNavigation = (url: string) => boolean;

export function createTerminalLinkHandler(openWindow: OpenWindow, confirmNavigation: ConfirmNavigation) {
  return {
    activate(_event: MouseEvent, text: string): void {
      try {
        const url = new URL(text);
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        if (!confirmNavigation(url.href)) return;
        openWindow(url.href, "_blank", "noopener,noreferrer");
      } catch {
        // Ignore malformed OSC 8 links emitted by terminal applications.
      }
    },
  };
}

export const TERMINAL_OPTIONS = {
  // Unicode11Addon은 terminal.unicode(proposed API)를 사용하므로 이 옵션이 true여야 한다.
  // false이면 addon.activate()가 "must set allowProposedApi" 오류를 던져 터미널 마운트가 깨진다.
  allowProposedApi: true,
  // 리퀴드 글래스: 터미널 배경이 반투명 틴트일 수 있다 — 알파를 캔버스가 실제로 그리려면
  // 이 옵션이 켜져 있어야 한다. 게이트가 닫힌 불투명 배경에서는 시각 차이가 없다.
  allowTransparency: true,
  // PTY 기반 TUI(nvim 등)는 raw LF와 cursor 제어 시퀀스를 직접 관리한다.
  // LF를 CRLF로 변환하면 alternate screen에서 열 위치가 틀어져 화면이 깨질 수 있다.
  convertEol: false,
  cursorBlink: true,
  cursorStyle: "block" as const,
  // xterm's default OSC 8 handler opens about:blank first and assigns the URL later.
  // Sandboxed Desktop correctly denies that blank popup, so pass the validated URL in the initial request.
  linkHandler: createTerminalLinkHandler(
    (url, target, features) => window.open(url, target, features),
    (url) => window.confirm(`Do you want to navigate to ${url}?\n\nWARNING: This link could potentially be dangerous`),
  ),
  lineHeight: 1,
};
