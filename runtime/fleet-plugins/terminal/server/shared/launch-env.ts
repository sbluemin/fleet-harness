export const TERMINAL_TERM = "xterm-256color";

export function withTerminalCapabilities(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    // xterm.js의 24-bit SGR 렌더링을 알리되, TERM은 널리 호환되는 terminfo 항목을 유지한다.
    COLORTERM: "truecolor",
    TERM: TERMINAL_TERM,
  };
}

const CONSOLE_INTERNAL_ENV_KEYS = [
  "FLEET_CONSOLE_OWNER_ID",
  "FLEET_CONSOLE_OWNER_KIND",
  "FLEET_CONSOLE_PROTOCOL_VERSION",
  "FLEET_CONSOLE_RESOURCE_ROOT",
  "FLEET_CONSOLE_DESKTOP_DEVELOPMENT",
  "FLEET_CONSOLE_DESKTOP_VERSION",
  "FLEET_CONSOLE_PACKAGE_ROOT",
] as const;

// 데스크톱 셸이 sidecar에 주입하는 프로토콜 마커와 호스트 내부 힌트가 터미널 세션으로 새어 나가면,
// 그 터미널에서 실행된 다른 fleet console이 자신을 desktop sidecar로 오인하거나(리소스 루트 검증 실패)
// 잘못된 desktop 소유 잠금에 붙는다. FLEET_CONSOLE_DIR은 capture hook이 콘솔 데이터 디렉터리를
// 찾는 데 필요하고, FLEET_CONSOLE_SESSION_ID는 세션별로 명시 주입되므로 유지한다.
export function stripConsoleInternalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of CONSOLE_INTERNAL_ENV_KEYS) delete next[key];
  return next;
}

/**
 * Chat Mode의 SDK 자식이 받을 환경.
 *
 * 위와 한 가지가 다르다: `FLEET_CONSOLE_SESSION_ID`까지 지운다. PTY 세션은 이 값을 세션별로
 * 명시 주입하지만 SDK 자식에게는 주입할 값이 없고, Console 자신이 Fleet 터미널에서 떴다면
 * **그 터미널 세션의 id를 상속하고 있다.** 그대로 따라가면 이 자식이 실은 훅들이 남의 세션
 * 축에 턴 시작·종료·주의를 보고한다 — 조용히, 그리고 그 세션이 도는 내내.
 */
export function chatChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = stripConsoleInternalEnv(env);
  delete next.FLEET_CONSOLE_SESSION_ID;
  return next;
}
