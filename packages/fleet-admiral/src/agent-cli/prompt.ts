// Windows의 .cmd/.bat shim은 cmd.exe /d /s /c 로 감싸 실행된다(core-process wrapWindowsShim).
// cmd는 따옴표 안에서도 %NAME%을 전개하고 ^를 이스케이프로 읽으므로, 그 명령줄에 실린 임의
// 텍스트는 조용히 변조되고 환경변수 값이 그대로 모델에 실려 나간다. 명령줄에서는 %%도 접히지
// 않아 이스케이프로 막을 수단이 없다 — 그래서 core-process가 shim 경로에 대해 이미 택한 규율
// (rejectCmdExpansionSensitiveShim: 이스케이프가 아니라 거부)을 프롬프트에도 그대로 적용한다.
// %는 전개, 나머지는 cmd의 연산자·인용 경계다. 이 저장소의 quoteForCmd
// (core-unified-agent BaseConnection)가 `& < > ( ) @ ^ |`와 `"`를 cmd 특수문자로 분류하면서
// **내부 `"`의 이중화와 windowsVerbatimArguments를 함께 요구**한다고 명시하는데, node-pty로
// 나가는 이 런치 경로는 둘 다 제공하지 않는다. 따라서 따옴표 안이라는 가정도 성립하지 않는다.
const CMD_UNSAFE_PROMPT_PATTERN = /["&<>()@^|%]/;

export type LaunchPromptErrorCode = "prompt_unsafe_for_shim" | "prompt_unsupported_launch";

export class LaunchPromptError extends Error {
  readonly code: LaunchPromptErrorCode;

  constructor(code: LaunchPromptErrorCode, message: string) {
    super(message);
    this.name = "LaunchPromptError";
    this.code = code;
  }
}

/**
 * cmd.exe로 감싸인 shim으로 실행될 때에 한해, cmd가 재해석할 문자를 담은 프롬프트를 거부한다.
 * `prefixArgs`가 비어 있으면(POSIX 또는 실행 파일 직접 실행) 아무 제약도 걸지 않는다.
 */
export function assertLaunchPromptShimSafe(prompt: string | undefined, prefixArgs: readonly string[]): void {
  if (prompt === undefined || prefixArgs.length === 0) return;
  if (!CMD_UNSAFE_PROMPT_PATTERN.test(prompt)) return;
  throw new LaunchPromptError(
    "prompt_unsafe_for_shim",
    'The launch prompt contains a character cmd.exe would reinterpret (" & < > ( ) @ ^ | %) while running the Windows shim. Remove it and try again.',
  );
}

// 런치 프롬프트는 PTY가 아니라 argv 위치 인자로 나간다. NUL과 제어문자는 인자 경계·로깅을
// 오염시키므로 제거하되, 줄바꿈과 탭은 프롬프트의 의미라 보존한다.
export function sanitizeLaunchPrompt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  // 길이 상한은 여기서 자르거나 던지지 않는다. MAX_LAUNCH_PROMPT_CHARS는 호스트 라우트가 강제하는 계약이다.
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  const trimmed = normalized.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
