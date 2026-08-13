import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Windows의 .cmd/.bat shim은 cmd.exe /d /s /c 로 감싸 실행된다(core-process wrapWindowsShim).
// cmd는 따옴표 안에서도 %NAME%을 전개하고 ^를 이스케이프로 읽으므로, 그 명령줄에 실린 임의
// 텍스트는 조용히 변조되고 환경변수 값이 그대로 모델에 실려 나간다. 명령줄에서는 %%도 접히지
// 않아 이스케이프로 막을 수단이 없다. native `.exe`와 POSIX도 원문을 argv에 올리지 않는다 —
// 명령줄 상한과 플랫폼을 가리지 않고 Fleet이 만든 파일 경로를 가리키는 짧은 지시만 실는다.
// 그 지시(경로 포함)는 cmd shim일 때 이 문자 집합을 통과해야 한다. %는 전개, 나머지는 cmd의
// 연산자·인용 경계다. 이 저장소의 quoteForCmd (구 ACP BaseConnection)가 `& < > ( ) @ ^ |`와
// `"`를 cmd 특수문자로 분류하면서 **내부 `"`의 이중화와 windowsVerbatimArguments를 함께
// 요구**한다고 명시하는데, node-pty로 나가는 이 런치 경로는 둘 다 제공하지 않는다. 따라서
// 따옴표 안이라는 가정도 성립하지 않는다.
const CMD_UNSAFE_PROMPT_PATTERN = /["&<>()@^|%]/;
const LAUNCH_PROMPT_FILE_MODE = 0o600;

export const LAUNCH_PROMPT_TEMP_DIR_PREFIX = "fleet-quick-launch-";
export const LAUNCH_PROMPT_FILE_NAME = "prompt.md";
export const LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX = "Read and follow the launch prompt file: ";

/**
 * Windows 명령줄 상한. cmd.exe를 경유하는 shim 실행은 8,191자, 실행 파일을 직접 부르는
 * 경로는 CreateProcess의 32,767자에서 잘린다. 두 숫자와 이 저장소가 `--agents` JSON을
 * argv에서 걷어낸 경위는 gateway-agents.ts에 적혀 있다 — 거기서는 왜 옮겼는지를 설명하고,
 * 여기서는 남은 argv가 그 상한을 넘기지 않는지를 실제로 강제한다.
 */
export const WINDOWS_CMD_SHIM_COMMAND_LINE_MAX_CHARS = 8191;
export const WINDOWS_CREATE_PROCESS_COMMAND_LINE_MAX_CHARS = 32767;

export type LaunchPromptErrorCode =
  | "prompt_unsafe_for_shim"
  | "prompt_unsupported_launch"
  | "prompt_command_line_too_long"
  | "launch_command_line_too_long";

export interface LaunchCommandLineLimit {
  readonly maxChars: number;
  readonly via: "cmd-shim" | "create-process";
}

export class LaunchPromptError extends Error {
  readonly code: LaunchPromptErrorCode;
  /**
   * 프롬프트를 몇 글자 줄여야 이 실행이 들어가는지. 호스트가 거절 응답에 실어 보내야
   * 사용자에게 닿는다 — 문장으로만 들고 있으면 그 숫자는 서버에서 끝난다.
   */
  readonly shortenByChars?: number;

  constructor(code: LaunchPromptErrorCode, message: string, shortenByChars?: number) {
    super(message);
    this.name = "LaunchPromptError";
    this.code = code;
    if (shortenByChars !== undefined) this.shortenByChars = shortenByChars;
  }
}

/**
 * cmd.exe로 감싸인 shim으로 실행될 때에 한해, cmd가 재해석할 문자를 담은 argv 텍스트를 거부한다.
 * 사용자 원문은 이 검사에 올리지 않는다 — 원문은 파일로 두고, 여기에는 그 파일을 가리키는
 * 짧은 지시(경로 포함)만 온다. `prefixArgs`가 비어 있으면(POSIX 또는 실행 파일 직접 실행)
 * 아무 제약도 걸지 않는다.
 */
export function assertLaunchPromptShimSafe(prompt: string | undefined, prefixArgs: readonly string[]): void {
  if (prompt === undefined || prefixArgs.length === 0) return;
  if (!CMD_UNSAFE_PROMPT_PATTERN.test(prompt)) return;
  throw new LaunchPromptError(
    "prompt_unsafe_for_shim",
    'The launch prompt contains a character cmd.exe would reinterpret (" & < > ( ) @ ^ | %) while running the Windows shim. Remove it and try again.',
  );
}

/**
 * 이 실행에 걸리는 명령줄 상한을 고른다. POSIX에는 이 크기대의 상한이 없어 선언하지 않는다.
 * `prefixArgs`가 있다는 것은 core-process가 bin을 cmd.exe로 감쌌다는 뜻이고, 그때는 상한이
 * CreateProcess가 아니라 cmd 쪽에서 먼저 걸린다.
 */
export function resolveLaunchCommandLineLimit(
  prefixArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): LaunchCommandLineLimit | undefined {
  if (platform !== "win32") return undefined;
  return prefixArgs.length > 0
    ? { maxChars: WINDOWS_CMD_SHIM_COMMAND_LINE_MAX_CHARS, via: "cmd-shim" }
    : { maxChars: WINDOWS_CREATE_PROCESS_COMMAND_LINE_MAX_CHARS, via: "create-process" };
}

/**
 * 최종 명령줄이 차지할 문자 수를 어림한다. Windows는 bin과 인자를 하나의 문자열로 이어
 * 자식에게 넘기므로, 프롬프트만이 아니라 bin·shim 선행 인자·주입 인자를 모두 세야 한다.
 *
 * 어림이지만 낮게 잡지는 않는다 — 실제보다 적게 세면 상한을 넘긴 실행을 통과시켜 이 검사가
 * 있으나 마나가 된다.
 */
export function estimateWindowsCommandLineChars(bin: string, args: readonly string[]): number {
  return args.reduce((total, arg) => total + 1 + quoteWindowsArg(arg).length, quoteWindowsArg(bin).length);
}

/**
 * 인자 하나가 Windows 명령줄에 실제로 실리는 형태.
 *
 * 길이를 근사식으로 세지 않고 인용 규칙을 그대로 돌린다 — 백슬래시는 `"` 앞이나 인용을 닫기
 * 직전에서만 두 배가 되므로, 원본 글자 수만 세면 백슬래시로 끝나는 인자를 상한 아래로 잘못
 * 재고 그대로 통과시킨다. 그 오차가 이 검사가 막으려던 실패다.
 */
function quoteWindowsArg(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      // 앞선 백슬래시 런은 두 배가 되고, 따옴표 자신도 백슬래시 하나로 이스케이프된다.
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  // 인용을 닫는 따옴표 직전의 백슬래시 런도 두 배가 된다.
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * 조립이 끝난 argv가 이 플랫폼의 명령줄 상한 안에 들어가는지 확인한다.
 *
 * 프롬프트 길이만 보는 검사(MAX_LAUNCH_PROMPT_CHARS)로는 부족하다 — 상한을 채우는 것은
 * 프롬프트만이 아니라 bin·shim 선행 인자·`--mcp-config`/`--plugin-dir` 같은 주입 인자의
 * 합계이고, 그 합계는 프로필이 조립된 뒤에야 알 수 있다. 여기서 막지 않으면 spawn이
 * 플랫폼 오류로 죽어 사용자에게는 원인이 남지 않는다.
 */
export function assertLaunchCommandLineBudget(options: {
  /** 최종 argv 그대로. */
  readonly args: readonly string[];
  /**
   * 같은 argv에서 런치 프롬프트만 빠진 것. "프롬프트를 줄이면 고쳐지는가"는 프롬프트 길이가
   * 아니라 이 값이 답한다 — 프롬프트가 초과분보다 짧으면 통째로 지워도 여전히 넘치고,
   * 그때 "몇 자를 줄이라"는 지시는 따를 수 없는 말이 된다.
   */
  readonly argsWithoutPrompt: readonly string[];
  readonly bin: string;
  readonly limit: LaunchCommandLineLimit | undefined;
  /**
   * argv에 남은 프롬프트가 파일 포인터처럼 길이를 줄일 수 없는 지시일 때. 원문은 이미 파일에
   * 있으므로 "몇 자를 줄이라"는 말은 따를 수 없다 — 설정 쪽 거절로 돌린다.
   */
  readonly promptIsFixedLength?: boolean;
}): void {
  const { limit } = options;
  if (limit === undefined) return;
  const total = estimateWindowsCommandLineChars(options.bin, options.args);
  if (total <= limit.maxChars) return;
  const boundary = limit.via === "cmd-shim" ? "cmd.exe shim" : "CreateProcess";
  // 프롬프트를 통째로 빼도 넘치면 줄일 대상이 프롬프트가 아니다. 프롬프트가 아예 없는 실행도
  // 여기로 떨어진다 — 그때 argsWithoutPrompt는 args와 같다.
  const withoutPrompt = estimateWindowsCommandLineChars(options.bin, options.argsWithoutPrompt);
  if (withoutPrompt > limit.maxChars) {
    throw new LaunchPromptError(
      "launch_command_line_too_long",
      `The launch command line is ${withoutPrompt} characters before any launch prompt, over the ${limit.maxChars}-character Windows ${boundary} limit. Shortening the prompt cannot help; reduce the launch configuration instead.`,
    );
  }
  if (options.promptIsFixedLength === true) {
    throw new LaunchPromptError(
      "launch_command_line_too_long",
      `The launch command line is ${total} characters, over the ${limit.maxChars}-character Windows ${boundary} limit even after moving the launch prompt into a file. Shortening the prompt cannot help; reduce the launch configuration instead.`,
    );
  }
  const shortenByChars = total - limit.maxChars;
  throw new LaunchPromptError(
    "prompt_command_line_too_long",
    `The launch command line is ${total} characters, over the ${limit.maxChars}-character Windows ${boundary} limit. Shorten the launch prompt by at least ${shortenByChars} characters and try again.`,
    shortenByChars,
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

export function formatLaunchPromptFileInstruction(filePath: string): string {
  return `${LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX}${filePath}`;
}

/**
 * Quick Launch 원문을 OS temp의 고유 디렉터리에 쓰고, argv에 실을 짧은 지시를 반환한다.
 * 지시(경로 포함)가 cmd shim에서 재해석되면 방금 만든 파일을 지우고 거절한다.
 */
export function writeLaunchPromptPointer(
  body: string,
  onCleanup: (cleanup: () => void) => void,
  cmdWrapped: boolean,
): string {
  const written = writeLaunchPromptFile(body, onCleanup);
  try {
    assertLaunchPromptShimSafe(written.instruction, cmdWrapped ? ["cmd-shim"] : []);
  } catch (error) {
    written.cleanup();
    if (error instanceof LaunchPromptError && error.code === "prompt_unsafe_for_shim") {
      throw new LaunchPromptError(
        "prompt_unsafe_for_shim",
        'The launch prompt file path contains a character cmd.exe would reinterpret (" & < > ( ) @ ^ | %) while running the Windows shim. Fleet cannot start this launch from the current Windows temp directory.',
      );
    }
    throw error;
  }
  return written.instruction;
}

export function writeLaunchPromptFile(
  body: string,
  onCleanup: (cleanup: () => void) => void,
): { readonly cleanup: () => void; readonly filePath: string; readonly instruction: string } {
  // os.tmpdir()은 TEMP/TMP가 상대값이면 상대 경로를 돌려준다. Claude의 cwd는 Theater라
  // 상대 포인터는 방금 만든 파일을 찾지 못한다 — 지시에는 절대 경로만 실어야 한다.
  const tempRoot = path.resolve(os.tmpdir());
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(path.join(tempRoot, LAUNCH_PROMPT_TEMP_DIR_PREFIX));
  const cleanup = () => rmBestEffort(tempDir);
  try {
    const filePath = path.join(tempDir, LAUNCH_PROMPT_FILE_NAME);
    writeFileSync(filePath, body, { encoding: "utf8", flag: "wx", mode: LAUNCH_PROMPT_FILE_MODE });
    chmodBestEffort(filePath, LAUNCH_PROMPT_FILE_MODE);
    // 쓰기가 끝난 뒤에만 호출자 cleanup 스택에 올린다. 그 전에 실패하면 이 함수가
    // 디렉터리를 거두고, 호출자가 받은 콜백을 실행할 기회 없이 누수하지 않는다.
    onCleanup(cleanup);
    return {
      cleanup,
      filePath,
      instruction: formatLaunchPromptFileInstruction(filePath),
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function chmodBestEffort(targetPath: string, mode: number): void {
  try {
    chmodSync(targetPath, mode);
  } catch {
    // POSIX 권한을 지원하지 않는 파일시스템에서는 best-effort로 둔다.
  }
}

function rmBestEffort(targetPath: string): void {
  try {
    rmSync(targetPath, { force: true, recursive: true });
  } catch {
    // 세션 정리는 파일이 이미 사라진 경우에도 전체 shutdown을 막지 않는다.
  }
}
