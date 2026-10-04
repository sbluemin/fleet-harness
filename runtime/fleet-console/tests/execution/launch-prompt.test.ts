import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentTerminalLaunchResolver } from "../../features/execution/host/agent/launch.js";
import { createLaunchPromptNamespace } from "../../features/execution/host/agent/launch-prompt-namespace.js";

const baseProfile = {
  id: "claude",
  label: "Claude",
  bin: "/bin/claude",
  args: ["--model", "sonnet"],
  cwd: "/work",
  env: { PATH: "/bin", TERM: "xterm-256color" },
  messagePolicy: { bracketedPaste: true, multilineStrategy: "paste-mode" },
  terminalName: "xterm-256color",
} as const;

const AI_GATEWAY_BINDING = {
  routePath: "/api/v1/ai-gateway",
  origin: () => "http://127.0.0.1:43210",
};

function createFakeRuntime() {
  return {
    carrierRuntime: {
      jobs: {
        streaming: {
          register() {
            return () => {};
          },
        },
      },
    },
    dedicatedMcpSession: {},
    mcpRegistry: {
      getAllAgentTools() {
        return [];
      },
    },
    cleanup: async () => {},
  };
}

/** 런치가 플러그인 트리를 렌더할 자리. 실제 렌더는 스텁이 가로채므로 값 자체는 쓰이지 않는다. */
const launchDataDir = "/tmp/fleet-console-test/console";
/** 기동에 렌더된 트리를 대신한다 — 런치는 경로만 읽는다. */
const launchPluginStub = { url: async () => "http://127.0.0.1:9/fleet-plugin-stub/fleet.zip", close: async () => {} };

describe("createAgentTerminalLaunchResolver launch environment", () => {
  it("advertises truecolor without replacing the compatible TERM entry", async () => {
    const resolve = createAgentTerminalLaunchResolver({
      dataDir: launchDataDir,
      plugin: launchPluginStub,
      infraServices: { agentOptionsService: { load: () => ({}), update: (mutate) => mutate({}) } },
      cwd: "/work",
      env: {
        COLORTERM: "256color",
        CLAUDE_CODE_CHILD_SESSION: "1",
        FLEET_TERMINAL_CMD: "/bin/sh",
        PATH: "/bin",
      } as NodeJS.ProcessEnv,
      platform: "linux",
    });

    const spec = await resolve("/work/project", { sessionId: "session-a" });

    expect(spec.env).toMatchObject({
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    });
    expect(spec.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  });
});

describe("createAgentTerminalLaunchResolver prompt threading", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards context.prompt into resolveProfile options", async () => {
    const resolveProfile = vi.fn(async (env: NodeJS.ProcessEnv, cwd: string) => ({
      ...baseProfile,
      cwd,
      env: { ...env },
    }));
    const injectProfile = vi.fn(async (profile) => profile);
    const resolve = createAgentTerminalLaunchResolver({
      dataDir: launchDataDir,
      plugin: launchPluginStub,
      infraServices: { agentOptionsService: { load: () => ({}), update: (mutate) => mutate({}) } },
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: createFakeRuntime() as never,
      aiGateway: AI_GATEWAY_BINDING,
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
    });

    await resolve("/work/project", {
      sessionId: "session-a",
      cliId: "claude",
      prompt: "ship the prompt threading",
    });

    expect(resolveProfile).toHaveBeenCalledWith(
      expect.any(Object),
      "/work/project",
      expect.objectContaining({
        cliId: "claude",
        prompt: "ship the prompt threading",
      }),
    );
  });

  it("passes prompt as undefined when context has no prompt", async () => {
    const resolveProfile = vi.fn(async (env: NodeJS.ProcessEnv, cwd: string) => ({
      ...baseProfile,
      cwd,
      env: { ...env },
    }));
    const injectProfile = vi.fn(async (profile) => profile);
    const resolve = createAgentTerminalLaunchResolver({
      dataDir: launchDataDir,
      plugin: launchPluginStub,
      infraServices: { agentOptionsService: { load: () => ({}), update: (mutate) => mutate({}) } },
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: createFakeRuntime() as never,
      aiGateway: AI_GATEWAY_BINDING,
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
    });

    await resolve("/work/project", { sessionId: "session-a", cliId: "claude" });

    expect(resolveProfile).toHaveBeenCalledWith(
      expect.any(Object),
      "/work/project",
      expect.objectContaining({
        cliId: "claude",
        prompt: undefined,
      }),
    );
  });
});

describe("launch prompt namespace reclaim", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) {
      try { chmodSync(path.join(dir, readdirSync(dir).find((name) => name.startsWith("fleet-launch-")) ?? ""), 0o700); } catch { /* best-effort */ }
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")("reclaims only what a dead process left in a root this user owns", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "fleet-launch-ns-test-"));
    scratch.push(tmpDir);
    const lockFile = path.join(tmpDir, "console", "console.lock");
    const log = () => {};

    // 같은 pid를 썼던 이전 프로세스(pid가 고정된 컨테이너 재시작)가 남긴 항목 — 지금 pid와 같아도 잔재다.
    const previous = createLaunchPromptNamespace({ lockFile, tmpDir, log });
    const samePidLeftover = previous.allocateDir("fleet-quick-launch-");
    const root = path.dirname(samePidLeftover);
    // 아직 살아 있는 다른 프로세스가 만든 항목(lock 독점이 깨진 동시 Console 등).
    const liveEntry = path.join(root, `fleet-quick-launch-${process.ppid}-LiVe01`);
    mkdirSync(liveEntry, { mode: 0o700 });
    // 정리 없이 죽은 프로세스가 남긴 항목.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const deadEntry = path.join(root, `fleet-system-prompt-${deadPid}-AbC123`);
    mkdirSync(deadEntry, { mode: 0o700 });
    writeFileSync(path.join(deadEntry, "system-prompt.md"), "user prompt", { mode: 0o600 });

    // 다음 Console: lock 전에 만든 자기 항목도, 살아 있는 생성자의 항목도 남기고 죽은 것만 거둔다.
    const next = createLaunchPromptNamespace({ lockFile, tmpDir, log });
    const ownEntry = next.allocateDir("fleet-system-prompt-");
    expect(path.dirname(ownEntry)).toBe(root);
    expect(next.reclaimLeftovers()).toBe(2);
    expect(existsSync(deadEntry)).toBe(false);
    expect(existsSync(samePidLeftover)).toBe(false);
    expect(existsSync(liveEntry)).toBe(true);
    expect(existsSync(ownEntry)).toBe(true);

    // 소유를 증명하지 못하는 root(다른 사용자가 선점했을 수 있는 열린 모드)에는 쓰지도 지우지도 않는다.
    mkdirSync(deadEntry, { mode: 0o700 });
    chmodSync(root, 0o755);
    const guarded = createLaunchPromptNamespace({ lockFile, tmpDir, log });
    expect(path.dirname(guarded.allocateDir("fleet-system-prompt-"))).not.toBe(root);
    expect(guarded.reclaimLeftovers()).toBe(0);
    expect(existsSync(deadEntry)).toBe(true);
  });
});
