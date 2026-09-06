import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertLaunchPromptShimSafe, LaunchPromptError } from "../src/index.js";
import {
  formatLaunchPromptFileInstruction,
  LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX,
  LAUNCH_PROMPT_FILE_NAME,
  LAUNCH_PROMPT_TEMP_DIR_PREFIX,
  launchPromptHasCmdLineBreak,
  launchPromptHasCmdUnsafeChars,
  writeLaunchPromptFile,
  writeLaunchPromptPointer,
} from "../src/agent-cli/prompt.js";

// Windows의 .cmd shim은 cmd.exe /d /s /c 로 감싸 실행된다(core-process wrapWindowsShim). cmd는 따옴표
// 안에서도 %NAME%을 전개하므로, 그 명령줄에 실린 프롬프트는 조용히 변조되고 환경변수 값이 모델로 샌다.
// Windows에서 원문이 cmd 특수문자를 가지거나 명령줄을 넘기면 파일로 두고, 이 헬퍼는 그 파일을
// 가리키는 짧은 지시(경로 포함)를 같은 규율로 검사한다.
const CMD_WRAPPED_PREFIX_ARGS = ["/d", "/s", "/c", "call", "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd "] as const;

const promptFileCleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of promptFileCleanups.splice(0)) {
    cleanup();
  }
  vi.restoreAllMocks();
});

describe("assertLaunchPromptShimSafe", () => {

  it("refuses a prompt carrying % through a cmd-wrapped shim", () => {
    // %USERPROFILE% 같은 시퀀스는 cmd가 전개해 사용자 환경변수 값을 모델에 실어 보낸다.
    expect(() => assertLaunchPromptShimSafe("Summarize %USERPROFILE%", CMD_WRAPPED_PREFIX_ARGS))
      .toThrow(LaunchPromptError);
  });
});

// quoteForCmd(구 ACP BaseConnection)가 cmd 특수문자로 분류하는 집합이다. 그 헬퍼는
// 내부 따옴표 이중화와 windowsVerbatimArguments를 함께 요구하는데 node-pty 런치 경로는 둘 다
// 제공하지 않으므로, "따옴표로 감싸였으니 안전하다"는 가정 자체가 성립하지 않는다.

describe("launch prompt file pointer", () => {

  it("deletes the temp file when a cmd-wrapped pointer path is itself unsafe", () => {
    const unsafeTmp = path.join(`fleet-ql-unsafe&tmp-${process.pid}`);
    mkdirSync(unsafeTmp, { recursive: true });
    vi.spyOn(os, "tmpdir").mockReturnValue(unsafeTmp);
    try {
      try {
        writeLaunchPromptPointer("hello", () => {}, true);
        expect.unreachable("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(LaunchPromptError);
        expect((error as LaunchPromptError).code).toBe("prompt_unsafe_for_shim");
        expect((error as LaunchPromptError).message).toMatch(/file path/);
        expect((error as LaunchPromptError).message).toMatch(/temp directory/);
      }
      expect(readdirSync(unsafeTmp)).toEqual([]);
    } finally {
      rmSync(unsafeTmp, { recursive: true, force: true });
    }
  });
});
