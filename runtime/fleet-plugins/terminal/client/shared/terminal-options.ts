export const TERMINAL_OPTIONS = {
  // Unicode11Addon은 terminal.unicode(proposed API)를 사용하므로 이 옵션이 true여야 한다.
  // false이면 addon.activate()가 "must set allowProposedApi" 오류를 던져 터미널 마운트가 깨진다.
  allowProposedApi: true,
  // PTY 기반 TUI(nvim 등)는 raw LF와 cursor 제어 시퀀스를 직접 관리한다.
  // LF를 CRLF로 변환하면 alternate screen에서 열 위치가 틀어져 화면이 깨질 수 있다.
  convertEol: false,
  cursorBlink: true,
  cursorStyle: "block" as const,
  lineHeight: 1,
};
