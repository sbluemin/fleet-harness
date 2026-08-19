import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiGatewaySettingsStore } from "@dotobokuri/core-ai-gateway";
import { launchClaudeGateway } from "../../../cli/gateway/launch.js";
import type { FleetCliGatewayServer } from "../../../cli/gateway/server.js";
import type { FleetCliRuntime } from "../../../cli/runtime/runtime.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

const mockedSpawn = vi.mocked(spawn);

describe("launchClaudeGateway", () => {
  let dataDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("keeps passthrough args before Fleet injection and launches through the loopback gateway", async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-cli-launch-"));
    const calls: string[] = ["runtime-constructed", "server-constructed"];
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn(() => true);
    mockedSpawn.mockImplementation((_bin, _args, _options) => {
      calls.push("spawn");
      queueMicrotask(() => child.emit("exit", 0, null));
      return child as unknown as ReturnType<typeof spawn>;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const releaseSessionToken = vi.fn();
    const runtimeCleanup = vi.fn(async () => {});
    const serverClose = vi.fn(async () => {});
    const globalOptions = { version: 1 as const, claudeCodeSystemPrompt: "off" as const };
    const runtime = {
      aiGatewayStore: createAiGatewaySettingsStore({ dataDir }),
      infraServices: {
        globalOptionsService: { load: () => globalOptions, save: () => globalOptions, update: () => globalOptions },
      },
      dataDir,
      dedicatedMcpSession: {
        getEndpoint: async () => ({
          servers: [{ name: "fleet", url: "http://127.0.0.1:39001/fleet" }],
        }),
        issueSessionToken: () => [{ name: "fleet", token: "session-token" }],
        releaseSessionToken,
      },
      cleanup: runtimeCleanup,
    } as unknown as FleetCliRuntime;
    const gatewayServer: FleetCliGatewayServer = {
      routePath: "/ai-gateway",
      origin: () => "http://127.0.0.1:39002",
      close: serverClose,
    };
    const passthroughArgs = ["--model", "sonnet", "hello"];

    await launchClaudeGateway({
      runtime,
      gatewayServer,
      passthroughArgs,
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAUDE_BIN: process.execPath,
        CLAUDE_CONFIG_DIR: path.join(dataDir, "claude"),
      },
      dataDir,
    });

    expect(calls).toEqual(["runtime-constructed", "server-constructed", "spawn"]);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [bin, args, options] = mockedSpawn.mock.calls[0]!;
    expect(bin).toBe(process.execPath);
    expect(args.slice(0, passthroughArgs.length)).toEqual(passthroughArgs);
    // 이 런처도 Console과 같은 전역 옵션을 읽는다 — 설정 Off가 여기서도 프롬프트를 비운다.
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("");
    expect(args.indexOf("--plugin-dir")).toBeGreaterThan(args.indexOf("hello"));
    expect(args.indexOf("--mcp-config")).toBeGreaterThan(args.indexOf("hello"));
    expect(options).toMatchObject({ cwd: process.cwd(), stdio: "inherit" });
    expect(options?.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:39002/ai-gateway",
    });
    expect(releaseSessionToken).toHaveBeenCalledTimes(1);
    expect(serverClose).toHaveBeenCalledTimes(1);
    expect(runtimeCleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
