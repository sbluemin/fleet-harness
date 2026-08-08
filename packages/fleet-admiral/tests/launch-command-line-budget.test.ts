import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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

describe("estimateWindowsCommandLineChars", () => {
  it("counts the bin, every argument, and the separating spaces", () => {
    // "claude" + " a" + " b"
    expect(estimateWindowsCommandLineChars("claude", ["a", "b"])).toBe(10);
  });

  it("counts the quotes an argument with whitespace gains", () => {
    // "cmd.exe" + ' "a b"'
    expect(estimateWindowsCommandLineChars("cmd.exe", ["a b"])).toBe(7 + 1 + 5);
  });

  it("never counts lower than the raw characters it carries", () => {
    const prompt = "x".repeat(1000);
    expect(estimateWindowsCommandLineChars("claude", [prompt])).toBeGreaterThanOrEqual(prompt.length);
  });

  // Windows는 인용을 닫는 따옴표 직전의 백슬래시 런을 두 배로 직렬화한다. 원본 글자 수만 세면
  // 백슬래시로 끝나는 프롬프트를 상한 아래로 잘못 재고 통과시킨다 — 이 검사가 막으려던 실패다.
  it("counts the doubling of a backslash run that closes a quoted argument", () => {
    // `a \\\\` -> `"a \\\\\\\\"`: 백슬래시 4개가 8개가 되고 따옴표 2개가 붙는다.
    expect(estimateWindowsCommandLineChars("x", ["a " + "\\".repeat(4)]))
      .toBe(1 + 1 + ('"a ' + "\\".repeat(8) + '"').length);
  });

  it("counts the doubling of a backslash run that precedes an inner quote", () => {
    // `a \\"` -> `"a \\\\\""`: 앞선 백슬래시 2개가 4개가 되고 따옴표 자신도 이스케이프된다.
    expect(estimateWindowsCommandLineChars("x", ['a ' + "\\".repeat(2) + '"']))
      .toBe(1 + 1 + ('"a ' + "\\".repeat(4) + '\\""').length);
  });

  it("leaves backslashes alone when they neither close the argument nor precede a quote", () => {
    // 인용은 필요하지만(공백) 백슬래시가 중간에 있으면 두 배가 되지 않는다.
    expect(estimateWindowsCommandLineChars("x", ["a \\b"])).toBe(1 + 1 + '"a \\b"'.length);
  });
});

describe("assertLaunchCommandLineBudget", () => {
  it("does nothing when the launch declares no limit", () => {
    expect(() => assertLaunchCommandLineBudget({
      args: ["x".repeat(100_000)],
      argsWithoutPrompt: [],
      bin: "/usr/local/bin/claude",
      limit: undefined,
    })).not.toThrow();
  });

  it("admits a launch that fits", () => {
    expect(() => assertLaunchCommandLineBudget({
      args: [...CMD_WRAPPED_PREFIX_ARGS, "hello"],
      argsWithoutPrompt: [...CMD_WRAPPED_PREFIX_ARGS],
      bin: "cmd.exe",
      limit: CMD_SHIM_LIMIT,
    })).not.toThrow();
  });

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

  it("carries no reduction figure on the refusal that a prompt cannot fix", () => {
    try {
      assertLaunchCommandLineBudget({
        args: [...CMD_WRAPPED_PREFIX_ARGS, "c".repeat(9_000)],
        argsWithoutPrompt: [...CMD_WRAPPED_PREFIX_ARGS, "c".repeat(9_000)],
        bin: "cmd.exe",
        limit: CMD_SHIM_LIMIT,
      });
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as LaunchPromptError).shortenByChars).toBeUndefined();
    }
  });

  it("counts injected arguments, not just the prompt", () => {
    // 프롬프트만으로는 상한 안이지만, 주입 인자와 합치면 넘긴다.
    const prompt = "a".repeat(5_000);
    const injected = ["--mcp-config", "b".repeat(4_000)];
    expect(() => assertLaunchCommandLineBudget({
      args: [...CMD_WRAPPED_PREFIX_ARGS, prompt],
      argsWithoutPrompt: [...CMD_WRAPPED_PREFIX_ARGS],
      bin: "cmd.exe",
      limit: CMD_SHIM_LIMIT,
    })).not.toThrow();
    expect(() => assertLaunchCommandLineBudget({
      args: [...CMD_WRAPPED_PREFIX_ARGS, ...injected, prompt],
      argsWithoutPrompt: [...CMD_WRAPPED_PREFIX_ARGS, ...injected],
      bin: "cmd.exe",
      limit: CMD_SHIM_LIMIT,
    })).toThrow(LaunchPromptError);
  });

  // 프롬프트 길이로 "고칠 수 있는가"를 대신 물으면, 프롬프트가 초과분보다 짧을 때 틀린 답이 나온다 —
  // 한 글자짜리 프롬프트에 수백 자를 줄이라는, 따를 수 없는 지시가 된다.
  it("does not blame a prompt too short to close the overflow", () => {
    const bulky = [...CMD_WRAPPED_PREFIX_ARGS, "--mcp-config", "b".repeat(9_000)];
    try {
      assertLaunchCommandLineBudget({
        args: [...bulky, "x"],
        argsWithoutPrompt: bulky,
        bin: "cmd.exe",
        limit: CMD_SHIM_LIMIT,
      });
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as LaunchPromptError).code).toBe("launch_command_line_too_long");
      expect((error as LaunchPromptError).shortenByChars).toBeUndefined();
      expect((error as LaunchPromptError).message).not.toMatch(/Shorten the launch prompt/);
    }
  });

  it("still blames the prompt when removing it would bring the launch under the limit", () => {
    // 경계 바로 옆: 프롬프트를 빼면 들어가므로, 이때는 몇 자를 줄이라고 말하는 것이 맞다.
    const fits = [...CMD_WRAPPED_PREFIX_ARGS, "--mcp-config", "b".repeat(4_000)];
    try {
      assertLaunchCommandLineBudget({
        args: [...fits, "p".repeat(5_000)],
        argsWithoutPrompt: fits,
        bin: "cmd.exe",
        limit: CMD_SHIM_LIMIT,
      });
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as LaunchPromptError).code).toBe("prompt_command_line_too_long");
      const cut = (error as LaunchPromptError).shortenByChars ?? 0;
      // 지시가 따를 수 있는 것이어야 한다: 줄이라는 양이 프롬프트 자체보다 크면 안 된다.
      expect(cut).toBeGreaterThan(0);
      expect(cut).toBeLessThanOrEqual(5_000);
    }
  });

  it("does not tell the user to shorten a prompt that is not there", () => {
    try {
      assertLaunchCommandLineBudget({
        args: [...CMD_WRAPPED_PREFIX_ARGS, "c".repeat(9_000)],
        argsWithoutPrompt: [...CMD_WRAPPED_PREFIX_ARGS, "c".repeat(9_000)],
        bin: "cmd.exe",
        limit: CMD_SHIM_LIMIT,
      });
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as LaunchPromptError).code).toBe("launch_command_line_too_long");
      expect((error as LaunchPromptError).message).not.toMatch(/Shorten the launch prompt/);
    }
  });

  it("still admits at the CreateProcess limit what the shim limit would refuse", () => {
    const args = [...CMD_WRAPPED_PREFIX_ARGS, "d".repeat(10_000)];
    expect(() => assertLaunchCommandLineBudget({
      args,
      argsWithoutPrompt: [...CMD_WRAPPED_PREFIX_ARGS],
      bin: "cmd.exe",
      limit: { maxChars: WINDOWS_CREATE_PROCESS_COMMAND_LINE_MAX_CHARS, via: "create-process" },
    })).not.toThrow();
    expect(() => assertLaunchCommandLineBudget({
      args,
      argsWithoutPrompt: [...CMD_WRAPPED_PREFIX_ARGS],
      bin: "cmd.exe",
      limit: CMD_SHIM_LIMIT,
    })).toThrow(LaunchPromptError);
  });
});

// 헬퍼가 있다는 것과 실행 경로가 그것을 부른다는 것은 다른 사실이다. 상한이 걸리는 지점은
// 프로필 조립이 아니라 주입이 끝난 뒤이므로, 그 배선을 여기서 못 박는다.
describe("injectAgentCliProfile command-line enforcement", () => {
  it("refuses a launch whose merged argv overflows the declared limit, and leaves no plugin behind", async () => {
    const root = createTempRoot("fleet-admiral-cmdline-");
    const profile: AgentCliProfile = {
      args: [...CMD_WRAPPED_PREFIX_ARGS],
      bin: "cmd.exe",
      commandLineLimit: CMD_SHIM_LIMIT,
      cwd: root,
      env: { HOME: root },
      id: "claude-native",
      label: "claude-native",
      promptArgs: ["a".repeat(10_000)],
      terminalName: "xterm-256color",
    };
    let releasedToken = false;

    await expect(injectAgentCliProfile(profile, {
      buildSystemPrompt: () => "Fleet doctrine",
      dataDir: path.join(root, "data"),
      dedicatedMcpSession: {
        async getEndpoint() {
          return { servers: [{ name: "fleet", url: "http://127.0.0.1:48123/mcp" }] };
        },
        issueSessionToken() {
          return [{ name: "fleet", token: "token-123" }];
        },
        releaseSessionToken() {
          releasedToken = true;
        },
      },
      withMarketplaceLock: async (_target, fn) => fn(),
    })).rejects.toThrow(LaunchPromptError);

    // 거부가 세션 토큰과 플러그인 디렉터리를 남기면, 실패한 실행마다 찌꺼기가 쌓인다.
    expect(releasedToken).toBe(true);
    expect(existsSync(path.join(root, "data", "plugins"))).toBe(false);
  });

  it("admits the same launch when the platform declares no command-line limit", async () => {
    const root = createTempRoot("fleet-admiral-cmdline-posix-");
    const profile: AgentCliProfile = {
      args: [],
      bin: "claude",
      cwd: root,
      env: { HOME: root },
      id: "claude-native",
      label: "claude-native",
      promptArgs: ["a".repeat(10_000)],
      terminalName: "xterm-256color",
    };

    const injected = await injectAgentCliProfile(profile, {
      buildSystemPrompt: () => "Fleet doctrine",
      dataDir: path.join(root, "data"),
      dedicatedMcpSession: {
        async getEndpoint() {
          return { servers: [{ name: "fleet", url: "http://127.0.0.1:48123/mcp" }] };
        },
        issueSessionToken() {
          return [{ name: "fleet", token: "token-123" }];
        },
        releaseSessionToken() {},
      },
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    expect(injected.args.at(-1)).toBe("a".repeat(10_000));
    injected.cleanup?.();
  });
});

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}
