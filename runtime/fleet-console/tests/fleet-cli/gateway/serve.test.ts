import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAiGatewaySettingsStore } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServeBanner, parseGatewayServeArgs, runGatewayServe } from "../../../cli/gateway/serve.js";

const dataDirs: string[] = [];

function createDataDir(): string {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-serve-"));
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

function serveDeps(dataDir: string, overrides: Record<string, unknown> = {}) {
  return {
    env: { NO_COLOR: "1" },
    dataDir,
    createStore: (dir: string) => createAiGatewaySettingsStore({ dataDir: dir }),
    createAuthService: (() => ({})) as never,
    waitForShutdown: async () => undefined,
    ...overrides,
  };
}

describe("fleet gateway serve banner", () => {

  it("names the credential header a standalone client must send", () => {
    // 라우터는 `sk-ant-` 접두가 없는 요청을 401로 돌려보낸다. base URL만 안내하면 배너를 그대로
    // 따른 사용자가 곧장 401을 만난다.
    const banner = buildServeBanner({
      baseUrl: "http://127.0.0.1:53211/ai-gateway",
      exposed: 3,
      env: { NO_COLOR: "1" },
      isTTY: true,
    });
    expect(banner).toContain("ANTHROPIC_API_KEY=sk-ant-");
    expect(banner).toContain("starts with `sk-ant-`");
    expect(banner).toContain("never reads the");
  });

  it("says plainly that an empty selection refuses every request", () => {
    const banner = buildServeBanner({
      baseUrl: "http://127.0.0.1:1/ai-gateway",
      exposed: 0,
      env: { NO_COLOR: "1" },
      isTTY: true,
    });
    expect(banner).toContain("none exposed");
    expect(banner).toContain("every request is refused");
  });
});

describe("fleet gateway serve run", () => {
  it("starts the server, announces it, then closes it on shutdown", async () => {
    const io = createIo();
    const close = vi.fn(async () => undefined);
    const startServer = vi.fn(async () => ({
      origin: () => "http://127.0.0.1:4321",
      routePath: "/ai-gateway",
      close,
    }));

    const status = await runGatewayServe([], io, serveDeps(createDataDir(), { startServer }));

    expect(status).toBe(0);
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(io.stdout.toString()).toContain("http://127.0.0.1:4321/ai-gateway");
    expect(io.stdout.toString()).toContain("Fleet AI Gateway stopped.");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
