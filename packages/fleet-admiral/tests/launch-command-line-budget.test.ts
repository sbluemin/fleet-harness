import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertLaunchCommandLineBudget,
  estimateWindowsCommandLineChars,
  injectAgentCliProfile,
  LaunchPromptError,
  MAX_LAUNCH_PROMPT_CHARS,
  resolveLaunchCommandLineLimit,
  WINDOWS_CMD_SHIM_COMMAND_LINE_MAX_CHARS,
  WINDOWS_CREATE_PROCESS_COMMAND_LINE_MAX_CHARS,
  type AgentCliProfile,
  type LaunchCommandLineLimit,
} from "../src/index.js";
import {
  LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX,
  LAUNCH_PROMPT_FILE_NAME,
  LAUNCH_PROMPT_TEMP_DIR_PREFIX,
} from "../src/agent-cli/prompt.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// core-process wrapWindowsShim이 npm `.cmd` shim에 대해 실제로 만들어 내는 모양이다.
const CMD_WRAPPED_PREFIX_ARGS = ["/d", "/s", "/c", "call", "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd "] as const;
const CMD_SHIM_LIMIT: LaunchCommandLineLimit = { maxChars: WINDOWS_CMD_SHIM_COMMAND_LINE_MAX_CHARS, via: "cmd-shim" };

describe("resolveLaunchCommandLineLimit", () => {
  it("declares no limit on POSIX", () => {
    expect(resolveLaunchCommandLineLimit([], "darwin")).toBeUndefined();
    expect(resolveLaunchCommandLineLimit(CMD_WRAPPED_PREFIX_ARGS, "linux")).toBeUndefined();
  });

  it("uses the cmd.exe shim limit when the bin was wrapped", () => {
    expect(resolveLaunchCommandLineLimit(CMD_WRAPPED_PREFIX_ARGS, "win32"))
      .toEqual({ maxChars: 8191, via: "cmd-shim" });
  });

  it("uses the CreateProcess limit when Windows runs the executable directly", () => {
    expect(resolveLaunchCommandLineLimit([], "win32"))
      .toEqual({ maxChars: 32767, via: "create-process" });
  });
});

describe("assertLaunchCommandLineBudget", () => {

  // 이 케이스가 리뷰가 지적한 구멍이다: 특수문자가 없어 shim 검사를 통과하고 16,000자
  // 상한도 통과하지만, cmd.exe 경유 실행의 8,191자를 넘겨 spawn 단계에서 죽는다.
  it("refuses an ordinary prompt that clears every prior gate but overflows the cmd shim", () => {
    const prompt = "a".repeat(10_000);
    expect(prompt.length).toBeLessThanOrEqual(MAX_LAUNCH_PROMPT_CHARS);
    expect(/["&<>()@^|%]/.test(prompt)).toBe(false);

    try {
      assertLaunchCommandLineBudget({
        args: [...CMD_WRAPPED_PREFIX_ARGS, prompt],
        argsWithoutPrompt: [...CMD_WRAPPED_PREFIX_ARGS],
        bin: "cmd.exe",
        limit: CMD_SHIM_LIMIT,
      });
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(LaunchPromptError);
      expect((error as LaunchPromptError).code).toBe("prompt_command_line_too_long");
      // 얼마나 줄여야 하는지를 말해 주지 않으면 사용자는 다시 찍어 볼 수밖에 없다.
      expect((error as LaunchPromptError).message).toMatch(/Shorten the launch prompt by at least \d+ characters/);
      // 문장으로만 들고 있으면 그 수는 서버에서 끝난다. 호스트가 응답에 실을 수 있도록 값으로도 낸다.
      expect((error as LaunchPromptError).shortenByChars).toBeGreaterThan(0);
    }
  });
});

// 헬퍼가 있다는 것과 실행 경로가 그것을 부른다는 것은 다른 사실이다. 상한이 걸리는 지점은
// 프로필 조립이 아니라 주입이 끝난 뒤이므로, 그 배선을 여기서 못 박는다.
describe("injectAgentCliProfile command-line enforcement", () => {

  it("moves a native CreateProcess launch prompt into a file when the original argv overflows", async () => {
    const root = createTempRoot("fleet-admiral-cmdline-native-overflow-");
    const original = "a".repeat(10_000);
    const isolatedTmp = path.join(root, "tmp");
    mkdirSync(isolatedTmp);
    const restoreTmp = isolateTmp(isolatedTmp);

    try {
      const baseline = await injectAgentCliProfile({
        args: [],
        bin: "claude.exe",
        commandLineLimit: { maxChars: WINDOWS_CREATE_PROCESS_COMMAND_LINE_MAX_CHARS, via: "create-process" },
        cwd: root,
        env: { HOME: root },
        id: "claude",
        label: "claude",
        promptArgs: [],
        terminalName: "xterm-256color",
      }, injectOptions(root));
      const pointer = `${LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX}${path.join(
        isolatedTmp, `${LAUNCH_PROMPT_TEMP_DIR_PREFIX}XXXXXX`, LAUNCH_PROMPT_FILE_NAME,
      )}`;
      const maxChars = estimateWindowsCommandLineChars(baseline.bin, [...baseline.args, pointer]);
      expect(estimateWindowsCommandLineChars(baseline.bin, [...baseline.args, original])).toBeGreaterThan(maxChars);
      baseline.cleanup?.();

      const injected = await injectAgentCliProfile({
        args: [],
        bin: "claude.exe",
        commandLineLimit: { maxChars, via: "create-process" },
        cwd: root,
        env: { HOME: root },
        id: "claude",
        label: "claude",
        promptArgs: [original],
        terminalName: "xterm-256color",
      }, injectOptions(root));
      const instruction = injected.args.at(-1)!;
      expect(instruction.startsWith(LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX)).toBe(true);
      expect(injected.args).not.toContain(original);
      const filePath = instruction.slice(LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX.length);
      expect(readFileSync(filePath, "utf8")).toBe(original);
      injected.cleanup?.();
    } finally {
      restoreTmp();
    }
  });
});

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function cmdShimProfile(root: string, overrides: {
  readonly commandLineLimit?: LaunchCommandLineLimit;
  readonly promptArgs: readonly string[];
}): AgentCliProfile {
  return {
    args: [...CMD_WRAPPED_PREFIX_ARGS],
    bin: "cmd.exe",
    commandLineLimit: overrides.commandLineLimit ?? CMD_SHIM_LIMIT,
    cwd: root,
    env: { HOME: root },
    id: "claude",
    label: "claude",
    promptArgs: overrides.promptArgs,
    terminalName: "xterm-256color",
  };
}

function injectOptions(root: string, released?: { token: boolean }): Parameters<typeof injectAgentCliProfile>[1] {
  return {
    dataDir: path.join(root, "data"),
    dedicatedMcpSession: {
      async getEndpoint() {
        return { servers: [{ name: "fleet", url: "http://127.0.0.1:48123/mcp" }] };
      },
      issueSessionToken() {
        return [{ name: "fleet", token: "token-123" }];
      },
      releaseSessionToken() {
        if (released) released.token = true;
      },
    },
  };
}

function isolateTmp(isolatedTmp: string): () => void {
  const spy = vi.spyOn(os, "tmpdir").mockReturnValue(isolatedTmp);
  return () => {
    spy.mockRestore();
  };
}
