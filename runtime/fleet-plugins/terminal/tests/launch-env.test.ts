import { describe, expect, it } from "vitest";

import { chatChildEnv, stripConsoleInternalEnv } from "../server/shared/launch-env.js";

describe("stripConsoleInternalEnv", () => {
  it("removes desktop protocol markers and internal hints while keeping hook-required keys", () => {
    const env = stripConsoleInternalEnv({
      PATH: "/usr/bin",
      FLEET_CONSOLE_OWNER_ID: "desktop-owner-1",
      FLEET_CONSOLE_OWNER_KIND: "desktop",
      FLEET_CONSOLE_PROTOCOL_VERSION: "1",
      FLEET_CONSOLE_RESOURCE_ROOT: "/apps/fleet/resources",
      FLEET_CONSOLE_DESKTOP_DEVELOPMENT: "1",
      FLEET_CONSOLE_DESKTOP_VERSION: "1.23.0",
      FLEET_CONSOLE_PACKAGE_ROOT: "/apps/fleet/resources/sidecar/fleet-console",
      FLEET_CONSOLE_DIR: "/Users/op/.fleet/console",
      FLEET_CONSOLE_SESSION_ID: "session-1",
    });
    expect(env.PATH).toBe("/usr/bin");
    // capture hook은 FLEET_CONSOLE_DIR로 콘솔 데이터 디렉터리를 찾는다 — 유지 필수.
    expect(env.FLEET_CONSOLE_DIR).toBe("/Users/op/.fleet/console");
    expect(env.FLEET_CONSOLE_SESSION_ID).toBe("session-1");
    expect(env.FLEET_CONSOLE_OWNER_ID).toBeUndefined();
    expect(env.FLEET_CONSOLE_OWNER_KIND).toBeUndefined();
    expect(env.FLEET_CONSOLE_PROTOCOL_VERSION).toBeUndefined();
    expect(env.FLEET_CONSOLE_RESOURCE_ROOT).toBeUndefined();
    expect(env.FLEET_CONSOLE_DESKTOP_DEVELOPMENT).toBeUndefined();
    expect(env.FLEET_CONSOLE_DESKTOP_VERSION).toBeUndefined();
    expect(env.FLEET_CONSOLE_PACKAGE_ROOT).toBeUndefined();
  });

  it("does not mutate the source environment", () => {
    const source: NodeJS.ProcessEnv = { FLEET_CONSOLE_OWNER_KIND: "desktop" };
    stripConsoleInternalEnv(source);
    expect(source.FLEET_CONSOLE_OWNER_KIND).toBe("desktop");
  });
});

describe("chatChildEnv", () => {
  it("drops the inherited session id and turns Artifact on for the SDK child", () => {
    const env = chatChildEnv({
      PATH: "/usr/bin",
      FLEET_CONSOLE_SESSION_ID: "terminal-session-1",
      FLEET_CONSOLE_DIR: "/Users/op/.fleet/console",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FLEET_CONSOLE_DIR).toBe("/Users/op/.fleet/console");
    // 상속된 터미널 세션 id를 따라가면 이 자식의 훅이 남의 세션 축에 보고한다.
    expect(env.FLEET_CONSOLE_SESSION_ID).toBeUndefined();
    // SDK 진입점의 기본값은 Artifact 비활성이고, 그러면 도구와 함께 artifact-* 스킬 셋이
    // 자식의 목록에서 사라져 컴포저 덱에도 서지 못한다.
    expect(env.CLAUDE_CODE_ARTIFACT).toBe("1");
  });

  it("keeps an operator's explicit Artifact choice", () => {
    expect(chatChildEnv({ CLAUDE_CODE_ARTIFACT: "0" }).CLAUDE_CODE_ARTIFACT).toBe("0");
  });

  it("does not mutate the source environment", () => {
    const source: NodeJS.ProcessEnv = { FLEET_CONSOLE_SESSION_ID: "terminal-session-1" };
    chatChildEnv(source);
    expect(source.FLEET_CONSOLE_SESSION_ID).toBe("terminal-session-1");
    expect(source.CLAUDE_CODE_ARTIFACT).toBeUndefined();
  });
});
