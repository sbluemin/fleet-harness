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

describe("launchPromptHasCmdUnsafeChars", () => {
  it("detects cmd metacharacters that force a Windows file pointer", () => {
    expect(launchPromptHasCmdUnsafeChars("Fix the login redirect bug")).toBe(false);
    expect(launchPromptHasCmdUnsafeChars("Summarize %USERPROFILE%")).toBe(true);
    expect(launchPromptHasCmdUnsafeChars("a & b")).toBe(true);
  });

  // 줄바꿈은 이 집합이 아니다 — 재해석이 아니라 명령줄 자체의 끝이고, shim 경유일 때만
  // 문제가 된다. 두 갈래를 한 술어로 합치면 실행 파일을 직접 부르는 Windows 경로에서
  // 멀쩡히 전달되던 멀티라인 원문까지 파일로 밀려난다.
  it("leaves a line break to the cmd-shim-only predicate", () => {
    expect(launchPromptHasCmdUnsafeChars("line one\nline two")).toBe(false);
  });
});

describe("launchPromptHasCmdLineBreak", () => {
  // cmd.exe /d /s /c 로 감싼 실행에 멀티라인 인자를 실으면 첫 줄만 자식의 argv에 닿는다.
  // ^는 줄 잇기라 줄바꿈을 지우고, 따옴표 안이어도 파서가 그 줄에서 명령을 끊는다.
  it("detects the line breaks that truncate a cmd-shim command line", () => {
    expect(launchPromptHasCmdLineBreak("Fix the login redirect bug")).toBe(false);
    expect(launchPromptHasCmdLineBreak("line one\nline two")).toBe(true);
    expect(launchPromptHasCmdLineBreak("line one\r\nline two")).toBe(true);
    expect(launchPromptHasCmdLineBreak("line one\rline two")).toBe(true);
  });
});

describe("assertLaunchPromptShimSafe", () => {
  it("allows any prompt when the launch is not wrapped by cmd.exe", () => {
    expect(() => assertLaunchPromptShimSafe("100% done ^ now", [])).not.toThrow();
  });

  it("allows an expansion-safe prompt through a cmd-wrapped shim", () => {
    expect(() => assertLaunchPromptShimSafe("Fix the changelog fragment", CMD_WRAPPED_PREFIX_ARGS)).not.toThrow();
  });

  it("refuses a prompt carrying % through a cmd-wrapped shim", () => {
    // %USERPROFILE% 같은 시퀀스는 cmd가 전개해 사용자 환경변수 값을 모델에 실어 보낸다.
    expect(() => assertLaunchPromptShimSafe("Summarize %USERPROFILE%", CMD_WRAPPED_PREFIX_ARGS))
      .toThrow(LaunchPromptError);
  });

  it("refuses a prompt carrying ^ through a cmd-wrapped shim", () => {
    expect(() => assertLaunchPromptShimSafe("a ^ b", CMD_WRAPPED_PREFIX_ARGS)).toThrow(LaunchPromptError);
  });

  it("ignores an absent prompt", () => {
    expect(() => assertLaunchPromptShimSafe(undefined, CMD_WRAPPED_PREFIX_ARGS)).not.toThrow();
  });
});

// quoteForCmd(구 ACP BaseConnection)가 cmd 특수문자로 분류하는 집합이다. 그 헬퍼는
// 내부 따옴표 이중화와 windowsVerbatimArguments를 함께 요구하는데 node-pty 런치 경로는 둘 다
// 제공하지 않으므로, "따옴표로 감싸였으니 안전하다"는 가정 자체가 성립하지 않는다.
describe("cmd special characters", () => {
  it.each(['"', "&", "<", ">", "(", ")", "@", "|", "%", "^"])(
    "refuses a prompt carrying %s through a cmd-wrapped shim",
    (char) => {
      expect(() => assertLaunchPromptShimSafe("say " + char + " now", CMD_WRAPPED_PREFIX_ARGS)).toThrow(LaunchPromptError);
    },
  );

  it.each(['"', "&", "|", "%"])("leaves %s alone when the launch is not cmd-wrapped", (char) => {
    expect(() => assertLaunchPromptShimSafe("say " + char + " now", [])).not.toThrow();
  });

  it("reports the refusal with a code the host maps to a 400", () => {
    try {
      assertLaunchPromptShimSafe("a & b", CMD_WRAPPED_PREFIX_ARGS);
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as LaunchPromptError).code).toBe("prompt_unsafe_for_shim");
    }
  });
});

describe("launch prompt file pointer", () => {
  it("writes the body to a unique temp dir and names that file in the instruction", () => {
    const first = writeLaunchPromptFile("first body & %PATH%", (cleanup) => promptFileCleanups.push(cleanup));
    const second = writeLaunchPromptFile("second", (cleanup) => promptFileCleanups.push(cleanup));

    expect(first.filePath).not.toBe(second.filePath);
    expect(path.basename(first.filePath)).toBe(LAUNCH_PROMPT_FILE_NAME);
    expect(path.basename(path.dirname(first.filePath)).startsWith(LAUNCH_PROMPT_TEMP_DIR_PREFIX)).toBe(true);
    expect(path.isAbsolute(first.filePath)).toBe(true);
    expect(readFileSync(first.filePath, "utf8")).toBe("first body & %PATH%");
    expect(first.instruction).toBe(formatLaunchPromptFileInstruction(first.filePath));
    expect(first.instruction.startsWith(LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX)).toBe(true);
    expect(first.instruction).toContain(first.filePath);
  });

  it("admits a file-pointer instruction whose path has no cmd metacharacters", () => {
    const instruction = formatLaunchPromptFileInstruction(
      "C:\\Users\\a\\AppData\\Local\\Temp\\fleet-quick-launch-xyz\\prompt.md",
    );
    expect(() => assertLaunchPromptShimSafe(instruction, CMD_WRAPPED_PREFIX_ARGS)).not.toThrow();
  });

  it("refuses a file-pointer instruction when the temp path itself is cmd-unsafe", () => {
    const instruction = formatLaunchPromptFileInstruction("C:\\tmp\\fleet-quick-launch-&\\prompt.md");
    expect(() => assertLaunchPromptShimSafe(instruction, CMD_WRAPPED_PREFIX_ARGS)).toThrow(LaunchPromptError);
  });

  it("returns a shim-safe instruction for a typical OS temp path when cmd-wrapped", () => {
    const instruction = writeLaunchPromptPointer(
      'Summarize %USERPROFILE% & then do "this"',
      (cleanup) => promptFileCleanups.push(cleanup),
      true,
    );
    expect(instruction.startsWith(LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX)).toBe(true);
    expect(() => assertLaunchPromptShimSafe(instruction, CMD_WRAPPED_PREFIX_ARGS)).not.toThrow();
    const filePath = instruction.slice(LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX.length);
    expect(readFileSync(filePath, "utf8")).toBe('Summarize %USERPROFILE% & then do "this"');
  });

  it("keeps a spaced TEMP path as one shim-safe instruction argument", () => {
    // node-pty는 공백이 있는 argv 항목을 인용하므로, TEMP가 `First Last`처럼 공백을 가져도
    // 지시는 한 인자로 남는다. cmd 메타문자가 아니면 거절하지 않는다.
    const spacedTmp = path.join(`fleet-ql First Last tmp-${process.pid}`);
    mkdirSync(spacedTmp, { recursive: true });
    vi.spyOn(os, "tmpdir").mockReturnValue(spacedTmp);
    try {
      const instruction = writeLaunchPromptPointer(
        "hello",
        (cleanup) => promptFileCleanups.push(cleanup),
        true,
      );
      expect(instruction.startsWith(LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX)).toBe(true);
      expect(instruction).toContain("First Last");
      expect(() => assertLaunchPromptShimSafe(instruction, CMD_WRAPPED_PREFIX_ARGS)).not.toThrow();
      const filePath = instruction.slice(LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX.length);
      expect(path.isAbsolute(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("hello");
    } finally {
      rmSync(spacedTmp, { recursive: true, force: true });
    }
  });

  it("resolves a relative TEMP into an absolute instruction path", () => {
    const relativeTmp = path.join(`fleet-ql-rel-tmp-${process.pid}`);
    mkdirSync(relativeTmp, { recursive: true });
    vi.spyOn(os, "tmpdir").mockReturnValue(relativeTmp);
    try {
      const written = writeLaunchPromptFile("relative temp body", (cleanup) => promptFileCleanups.push(cleanup));
      expect(path.isAbsolute(written.filePath)).toBe(true);
      expect(path.dirname(path.dirname(written.filePath))).toBe(path.resolve(relativeTmp));
      expect(written.instruction).toContain(written.filePath);
      expect(existsSync(written.filePath)).toBe(true);
    } finally {
      rmSync(relativeTmp, { recursive: true, force: true });
    }
  });

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
