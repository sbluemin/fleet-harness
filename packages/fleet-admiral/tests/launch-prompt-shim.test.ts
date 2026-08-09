import { describe, expect, it } from "vitest";

import { assertLaunchPromptShimSafe, LaunchPromptError } from "../src/index.js";

// Windows의 .cmd shim은 cmd.exe /d /s /c 로 감싸 실행된다(core-process wrapWindowsShim). cmd는 따옴표
// 안에서도 %NAME%을 전개하므로, 그 명령줄에 실린 프롬프트는 조용히 변조되고 환경변수 값이 모델로 샌다.
// core-process가 shim 경로에 대해 이미 택한 규율(이스케이프가 아니라 거부)을 프롬프트에도 적용한다.
const CMD_WRAPPED_PREFIX_ARGS = ["/d", "/s", "/c", "call", "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd "] as const;

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
