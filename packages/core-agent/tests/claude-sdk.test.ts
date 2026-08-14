import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLAUDE_GATEWAY_MODEL_CACHE_RELPATH } from "../src/claude/launch-env.js";

// 자식 프로세스를 띄우지 않는다. 검증 대상은 spawn 직전까지의 조립과 거부다.
const runVendorQuery = vi.fn();
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
  vendorClose = () => {};
});

describe("construction", () => {
  it("refuses a missing baseUrl rather than falling back to the public endpoint", async () => {
    await expect(createClaudeGatewaySdk({ baseUrl: "", models: [LUNA] })).rejects.toThrow(/baseUrl is required/);
  });

  it("refuses a relative or non-HTTP baseUrl", async () => {
    await expect(createClaudeGatewaySdk({ baseUrl: "/ai-gateway", models: [LUNA] })).rejects.toThrow(/absolute URL/);
    await expect(createClaudeGatewaySdk({ baseUrl: "ftp://host/x", models: [LUNA] })).rejects.toThrow(/http\(s\)/);
  });

  it("refuses an empty or unknown model list at construction, not at the first turn", async () => {
    await expect(createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [] })).rejects.toThrow(/at least one/);
    await expect(createClaudeGatewaySdk({ baseUrl: BASE_URL, models: ["claude-gateway--codex--no-such"] }))
      .rejects.toThrow(/Unknown gateway model/);
    // 게이트웨이 별칭도 아니고 네이티브 Anthropic id도 아닌 것은 생성 시점에 거부한다.
    await expect(createClaudeGatewaySdk({ baseUrl: BASE_URL, models: ["gpt-4o"] }))
      .rejects.toThrow(/not a native Anthropic model/);
    // 자식이 스스로 푸는 별칭은 통과한다. 실측: `sonnet`은 와이어에서 `claude-sonnet-5`가 된다.
    const aliased = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: ["sonnet"] });
    expect(aliased.models).toEqual(["sonnet"]);
    await aliased.dispose();

    const fable = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [FABLE_1M] });
    expect(fable.models).toEqual([FABLE_1M]);
    await drain(await fable.startTurn({ prompt: "hi", model: FABLE_1M }));
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options.model).toBe(FABLE_1M);
    await fable.dispose();
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
  it("writes a discovery cache whose baseUrl matches the child env byte for byte", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await drain(await sdk.startTurn({ prompt: "hi", model: LUNA }));

    const cache = JSON.parse(
      readFileSync(path.join(sdk.configDir, CLAUDE_GATEWAY_MODEL_CACHE_RELPATH), "utf8"),
    );
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    const env = options.env as Record<string, string>;
    expect(cache.baseUrl).toBe(env.ANTHROPIC_BASE_URL);
    expect(cache.models.map((m: { id: string }) => m.id)).toEqual([LUNA]);
    await sdk.dispose();
  });

  it("fixes settingSources and strictMcpConfig, and injects no prompt or agents", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await drain(await sdk.startTurn({ prompt: "hi", model: LUNA }));

    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options).not.toHaveProperty("systemPrompt");
    expect(options).not.toHaveProperty("agent");
    expect(options).not.toHaveProperty("agents");
    expect(options).not.toHaveProperty("hooks");
    await sdk.dispose();
  });

  it("forwards effort so the gateway effort ladder is reachable", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await drain(await sdk.startTurn({ prompt: "hi", model: LUNA, effort: "low" }));
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options.effort).toBe("low");
    await sdk.dispose();
  });

  it("omits an unset optional instead of forwarding undefined", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await drain(await sdk.startTurn({ prompt: "hi", model: LUNA }));
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options).not.toHaveProperty("effort");
    expect(options).not.toHaveProperty("resume");
    await sdk.dispose();
  });

  it("normalizes a catalog id to the Claude-facing id the cache advertises", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    // `[1m]` 마커 없는 표기로 불러도 자식에게는 카탈로그가 광고하는 id가 간다.
    await drain(await sdk.startTurn({ prompt: "hi", model: "claude-gateway--codex--gpt-5.6-luna-fast" }));
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options.model).toBe(LUNA);
    await sdk.dispose();
  });
});

describe("fail-closed refusals", () => {
  it("rejects a turn option that is not on the allowlist", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    // TypeScript는 변수를 거쳐 들어온 객체의 초과 속성을 잡지 못하고, JS 호출자는 아예 잡지 못한다.
    const turn = { prompt: "hi", model: LUNA, hooks: {}, agents: {} };
    await expect(sdk.startTurn(turn as never)).rejects.toThrow(/hooks, agents/);
    expect(runVendorQuery).not.toHaveBeenCalled();
    await sdk.dispose();
  });

  it("rejects a raw vendor-shaped systemPrompt string", async () => {
    // 키는 이제 합법이지만 모양은 wrapper 소유다. vendor 표기를 그대로 넘기면 조용히 통과하지 않는다.
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await expect(sdk.startTurn({ prompt: "hi", model: LUNA, systemPrompt: "you are a pirate" } as never))
      .rejects.toThrow(/non-empty string/);
    expect(runVendorQuery).not.toHaveBeenCalled();
    await sdk.dispose();
  });

  it("rejects a model this instance was not given", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await expect(sdk.startTurn({ prompt: "hi", model: SOL })).rejects.toThrow(/not one of this instance's models/);
    expect(runVendorQuery).not.toHaveBeenCalled();
    await sdk.dispose();
  });

  it("rejects an empty prompt", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await expect(sdk.startTurn({ prompt: "", model: LUNA })).rejects.toThrow(/non-empty string/);
    await sdk.dispose();
  });

  it("refuses a second concurrent turn on one instance", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    const first = await sdk.startTurn({ prompt: "hi", model: LUNA });
    await expect(sdk.startTurn({ prompt: "hi", model: LUNA })).rejects.toThrow(/already running/);
    await drain(first);
    // 슬롯은 스트림 소진으로 돌아온다.
    await drain(await sdk.startTurn({ prompt: "hi", model: LUNA }));
    await sdk.dispose();
  });

  it("releases the active slot when underlying close throws", async () => {
    vendorClose = () => {
      throw new Error("close failed");
    };
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    const first = await sdk.startTurn({ prompt: "hi", model: LUNA });
    expect(() => first.close()).toThrow("close failed");
    vendorClose = () => {};
    await drain(await sdk.startTurn({ prompt: "hi", model: LUNA }));
    await sdk.dispose();
  });

  it("refuses a turn after disposal", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await sdk.dispose();
    await expect(sdk.startTurn({ prompt: "hi", model: LUNA })).rejects.toThrow(/disposed/);
  });

  it("tolerates a second dispose", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await sdk.dispose();
    await expect(sdk.dispose()).resolves.toBeUndefined();
  });
});

describe("system prompt channel", () => {
  it("forwards replace mode as a bare vendor systemPrompt string", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await drain(await sdk.startTurn({
      prompt: "hi", model: LUNA,
      systemPrompt: { mode: "replace", text: "You are Session Analyst." },
    }));
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options.systemPrompt).toBe("You are Session Analyst.");
    await sdk.dispose();
  });

  it("forwards append mode as the claude_code preset with the caller's text", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await drain(await sdk.startTurn({
      prompt: "hi", model: LUNA,
      systemPrompt: { mode: "append", text: "Always explain your reasoning." },
    }));
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options.systemPrompt).toEqual({
      type: "preset", preset: "claude_code", append: "Always explain your reasoning.",
    });
    await sdk.dispose();
  });

  it("injects nothing when the caller omits it", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await drain(await sdk.startTurn({ prompt: "hi", model: LUNA }));
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options).not.toHaveProperty("systemPrompt");
    await sdk.dispose();
  });

  it("refuses an empty or unknown-mode prompt before spawn", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await expect(sdk.startTurn({ prompt: "hi", model: LUNA, systemPrompt: { mode: "replace", text: "" } }))
      .rejects.toThrow(/non-empty string/);
    await expect(sdk.startTurn({ prompt: "hi", model: LUNA, systemPrompt: { mode: "prepend", text: "x" } as never }))
      .rejects.toThrow(/"replace" or "append"/);
    expect(runVendorQuery).not.toHaveBeenCalled();
    await sdk.dispose();
  });

  it("restricts the built-in tool set through tools, not allowedTools", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await drain(await sdk.startTurn({
      prompt: "hi", model: LUNA, tools: ["WebSearch", "WebFetch"], allowedTools: ["WebSearch", "WebFetch"],
      permissionMode: "dontAsk",
    }));
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(options.permissionMode).toBe("dontAsk");
    await sdk.dispose();
  });

  it("forwards an empty tools array as a real restriction, not as omission", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA] });
    await drain(await sdk.startTurn({ prompt: "hi", model: LUNA, tools: [] }));
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options.tools).toEqual([]);
    await sdk.dispose();
  });

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

describe("native Anthropic passthrough models", () => {
  const SONNET = "claude-sonnet-4-5-20250929";

  it("accepts a native model id the catalog does not carry", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [SONNET] });
    expect(sdk.models).toEqual([SONNET]);
    await drain(await sdk.startTurn({ prompt: "hi", model: SONNET, effort: "low" }));
    const options = runVendorQuery.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options.model).toBe(SONNET);
    expect(options.effort).toBe("low");
    await sdk.dispose();
  });

  it("leaves a native model out of the discovery cache", async () => {
    // 캐시는 게이트웨이 별칭을 유효하게 만드는 장치다. 네이티브 모델은 실을 카탈로그 항목이 없고,
    // 빈 목록으로도 실제로 통과하는 것을 라이브 게이트웨이에서 실측했다.
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [SONNET] });
    await drain(await sdk.startTurn({ prompt: "hi", model: SONNET }));
    const cache = JSON.parse(
      readFileSync(path.join(sdk.configDir, CLAUDE_GATEWAY_MODEL_CACHE_RELPATH), "utf8"),
    );
    expect(cache.models).toEqual([]);
    expect(cache.baseUrl).toBe(BASE_URL);
    await sdk.dispose();
  });

  it("still refuses an unresolvable claude-gateway-- alias", async () => {
    await expect(createClaudeGatewaySdk({ baseUrl: BASE_URL, models: ["claude-gateway--codex--nope"] }))
      .rejects.toThrow(/Unknown gateway model/);
  });

  it("mixes catalog and native models in one instance", async () => {
    const sdk = await createClaudeGatewaySdk({ baseUrl: BASE_URL, models: [LUNA, SONNET] });
    expect(sdk.models).toEqual([LUNA, SONNET]);
    const cache0 = await sdk.startTurn({ prompt: "hi", model: SONNET });
    await drain(cache0);
    const cache = JSON.parse(
      readFileSync(path.join(sdk.configDir, CLAUDE_GATEWAY_MODEL_CACHE_RELPATH), "utf8"),
    );
    expect(cache.models.map((m: { id: string }) => m.id)).toEqual([LUNA]);
    await sdk.dispose();
  });
});
