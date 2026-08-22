import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAiGatewayCatalog, createAiGatewaySettingsStore } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyGatewayArgv, dispatchGatewayCommand } from "../../../cli/gateway/dispatcher.js";

const dataDirs: string[] = [];

function createDataDir(): string {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-dispatch-"));
  dataDirs.push(dataDir);
  return dataDir;
}

afterEach(() => {
  while (dataDirs.length > 0) {
    const dataDir = dataDirs.pop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  }
});

function createIo() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      },
      isTTY: false as boolean | undefined,
      toString() {
        return stdout;
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      },
      toString() {
        return stderr;
      },
    },
  };
}

function baseDeps(dataDir: string) {
  return {
    env: { NO_COLOR: "1" },
    dataDir,
    createStore: (dir: string) => createAiGatewaySettingsStore({ dataDir: dir }),
    createAuthService: (() => ({ listProviderIds: async () => [] })) as never,
    readSubscriptions: {
      codex: async () => null,
      cursor: async () => null,
      xai: async () => null,
    },
  };
}

describe("fleet gateway argv", () => {
  it("routes each subcommand and treats a bare invocation as the interactive screen", () => {
    expect(classifyGatewayArgv([])).toEqual({ kind: "interactive" });
    expect(classifyGatewayArgv(["--help"])).toEqual({ kind: "help" });
    expect(classifyGatewayArgv(["-h"])).toEqual({ kind: "help" });
    expect(classifyGatewayArgv(["serve", "--port", "1234"])).toEqual({
      kind: "serve",
      argv: ["--port", "1234"],
    });
    expect(classifyGatewayArgv(["auth", "login", "kimi"])).toEqual({
      kind: "auth",
      argv: ["auth", "login", "kimi"],
    });
    expect(classifyGatewayArgv(["models", "--json"])).toEqual({ kind: "models", json: true });
    expect(classifyGatewayArgv(["status"])).toEqual({ kind: "status", json: false });
    expect(classifyGatewayArgv(["set", "wire-log", "on"])).toEqual({
      kind: "set",
      key: "wire-log",
      value: "on",
    });
  });

  it("keeps an unknown subcommand inside the gateway instead of asking Claude", () => {
    expect(classifyGatewayArgv(["deploy"])).toEqual({ kind: "unknown", command: "deploy" });
  });
});

describe("fleet gateway dispatch", () => {
  it("prints the gateway help with its own set keys", async () => {
    const io = createIo();
    const status = await dispatchGatewayCommand(["--help"], io, baseDeps(createDataDir()));
    expect(status).toBe(0);
    expect(io.stdout.toString()).toContain("fleet gateway");
    expect(io.stdout.toString()).toContain("SET KEYS");
    expect(io.stdout.toString()).toContain("provider-priority");
    expect(io.stdout.toString()).toContain("no authentication");
  });

  it("reports an unknown subcommand and still shows the way out", async () => {
    const io = createIo();
    const status = await dispatchGatewayCommand(["deploy"], io, baseDeps(createDataDir()));
    expect(status).toBe(1);
    expect(io.stderr.toString()).toContain("Unknown fleet gateway command: deploy");
    expect(io.stdout.toString()).toContain("SET KEYS");
  });

  it("writes a policy axis through set and reads it back through status", async () => {
    const dataDir = createDataDir();
    const setIo = createIo();
    expect(await dispatchGatewayCommand(["set", "xai-endpoint", "direct"], setIo, baseDeps(dataDir))).toBe(0);
    expect(setIo.stdout.toString()).toContain("xai-endpoint = direct");

    const statusIo = createIo();
    expect(await dispatchGatewayCommand(["status", "--json"], statusIo, baseDeps(dataDir))).toBe(0);
    const report = JSON.parse(statusIo.stdout.toString()) as { readonly policy: Record<string, string> };
    expect(report.policy["xai-endpoint"]).toBe("direct");
  });

  it("rejects an unknown set key by naming the ones that exist", async () => {
    const io = createIo();
    const status = await dispatchGatewayCommand(["set", "models", "all"], io, baseDeps(createDataDir()));
    expect(status).toBe(1);
    expect(io.stderr.toString()).toContain("Unknown fleet gateway set key: models");
    expect(io.stderr.toString()).toContain("provider-priority");
  });

  it("lists exposed models as text and as JSON", async () => {
    const dataDir = createDataDir();
    const model = buildAiGatewayCatalog().providers.flatMap((provider) => provider.models).at(0);
    if (!model) throw new Error("catalog is empty");
    createAiGatewaySettingsStore({ dataDir }).write({ models: [{ id: model.id }] });

    const textIo = createIo();
    expect(await dispatchGatewayCommand(["models"], textIo, baseDeps(dataDir))).toBe(0);
    expect(textIo.stdout.toString()).toContain("1 exposed");

    const jsonIo = createIo();
    expect(await dispatchGatewayCommand(["models", "--json"], jsonIo, baseDeps(dataDir))).toBe(0);
    expect(JSON.parse(jsonIo.stdout.toString()).models).toHaveLength(1);
  });

  it("hands auth through to the shared provider flow", async () => {
    const io = createIo();
    const dispatchAuth = vi.fn(async () => 0);
    const status = await dispatchGatewayCommand(["auth", "list"], io, {
      ...baseDeps(createDataDir()),
      dispatchAuthCommand: dispatchAuth as never,
    });
    expect(status).toBe(0);
    // auth 디스패처는 argv[1]을 명령으로 읽으므로 "auth" 접두가 그대로 남아야 한다.
    expect(dispatchAuth).toHaveBeenCalledWith(["auth", "list"], io, expect.anything());
  });

  it("hands serve its own options", async () => {
    const io = createIo();
    const runServe = vi.fn(async () => 0);
    const status = await dispatchGatewayCommand(["serve", "--port", "4321"], io, {
      ...baseDeps(createDataDir()),
      runServe: runServe as never,
    });
    expect(status).toBe(0);
    expect(runServe.mock.calls.at(0)?.at(0)).toEqual(["--port", "4321"]);
  });

  it("opens the interactive screen for a bare invocation", async () => {
    const io = createIo();
    const runInteractive = vi.fn(async () => 0);
    const status = await dispatchGatewayCommand([], io, {
      ...baseDeps(createDataDir()),
      runInteractive: runInteractive as never,
    });
    expect(status).toBe(0);
    expect(runInteractive).toHaveBeenCalledTimes(1);
  });
});
