import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLAUDE_GATEWAY_MODEL_CACHE_RELPATH } from "../src/claude/launch-env.js";

// 자식 프로세스를 띄우지 않는다. 검증 대상은 spawn 직전까지의 조립과 거부다.
const runVendorQuery = vi.fn();
const runVendorSession = vi.fn();
let vendorClose: () => void = () => {};
vi.mock("../src/claude/vendor-sdk.js", () => ({
  runVendorQuery: (input: unknown) => {
    runVendorQuery(input);
    return {
      [Symbol.asyncIterator]: async function* () {
        yield { type: "result", subtype: "success" };
      },
      close: () => vendorClose(),
    };
  },
  runVendorSession: (input: unknown) => {
    runVendorSession(input);
    return {
      // 세션 스트림은 스스로 끝나지 않는다 — close가 유일한 종점이다.
      [Symbol.asyncIterator]: async function* () {
        await new Promise<void>(() => undefined);
      },
      send: vi.fn(),
      interrupt: vi.fn(async () => {}),
      stopTask: vi.fn(async () => {}),
      backgroundTasks: vi.fn(async () => true),
      getContextUsage: vi.fn(async () => null),
      close: () => vendorClose(),
    };
  },
  defineVendorTool: vi.fn(),
  createVendorMcpServer: vi.fn(),
}));

const { createClaudeGatewaySdk } = await import("../src/claude/sdk.js");

const BASE_URL = "http://127.0.0.1:43210/plugins/terminal/ai-gateway";
const LUNA = "claude-gateway--codex--gpt-5.6-luna-fast";
const SOL = "claude-gateway--codex--gpt-5.6-sol-fast";
const FABLE_1M = "fable[1m]";

async function drain(run: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of run) { /* 스트림을 끝까지 읽어 실행 슬롯을 돌려준다 */ }
}

beforeEach(() => {
  runVendorQuery.mockClear();
  runVendorSession.mockClear();
  vendorClose = () => {};
});

describe("construction", () => {
  it("refuses a missing baseUrl rather than falling back to the public endpoint", async () => {
    await expect(createClaudeGatewaySdk({ baseUrl: "", models: [LUNA] })).rejects.toThrow(/baseUrl is required/);
  });

  it("owns an isolated config directory", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    expect(existsSync(sdk.configDir)).toBe(true);
    expect(sdk.configDir).not.toContain(".claude");
    await sdk.dispose();
    expect(existsSync(sdk.configDir)).toBe(false);
  });
});

describe("turn assembly", () => {

  it("folds a throwing permission callback into a denial so the tool is never left parked", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await drain(await sdk.startTurn({
      prompt: "hi",
      model: LUNA,
      canUseTool: async () => { throw new Error("host blew up"); },
    }));
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    const vendorCallback = options.canUseTool as (
      name: string,
      input: Record<string, unknown>,
      extras: Record<string, unknown>,
    ) => Promise<unknown>;
    // 예외를 그대로 올리면 vendor가 응답을 쓰지 못해 도구가 무기한 막힌다(park deadline 없음).
    await expect(vendorCallback("Bash", {}, { toolUseID: "t", signal: new AbortController().signal }))
      .resolves.toEqual({ behavior: "deny", message: "host blew up" });
    await sdk.dispose();
  });
});

describe("fail-closed refusals", () => {

  it("refuses a second concurrent turn on one instance", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    const first = await sdk.startTurn({ prompt: "hi", model: LUNA });
    await expect(sdk.startTurn({ prompt: "hi", model: LUNA })).rejects.toThrow(/already running/);
    await drain(first);
    // 슬롯은 스트림 소진으로 돌아온다.
    await drain(await sdk.startTurn({ prompt: "hi", model: LUNA }));
    await sdk.dispose();
  });
});

describe("system prompt channel", () => {

  it("still refuses every unauthored instruction channel", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    for (const key of ["agents", "hooks", "settingSources", "plugins", "extraArgs"]) {
      await expect(sdk.startTurn({ prompt: "hi", model: LUNA, [key]: {} } as never))
        .rejects.toThrow(new RegExp(key));
    }
    expect(runVendorQuery).not.toHaveBeenCalled();
    await sdk.dispose();
  });
});
