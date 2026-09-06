import {
  AnthropicMessagesGateway,
  CURSOR_TOOL_BYTES_LIMIT,
  createClaudeCodexCompactionStore,
  ContextWindowExceededError,
  CursorAdapter,
  CLAUDE_COMPACT_CONTINUATION_MARKER,
  CLAUDE_COMPACT_PROMPT_MARKER,
} from "../../src/index.js";
import type {
  AdapterResponse,
  AiGatewayAdapter,
  AiGatewayStoredSettings,
  AnthropicMessagesRequest,
  CanonicalResponseRequest,
} from "../../src/index.js";
import type { GatewayFailureRecord } from "../../src/index.js";
import type { GatewayHttpHandlerContext } from "../../src/router/types.js";
import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  KIMI_MESSAGES_URL,
  MAX_GATEWAY_REQUEST_BODY_BYTES,
  OPENCODE_MESSAGES_URL,
  XAI_CLI_RESPONSES_URL,
  XAI_RESPONSES_URL,
  createAiGatewayRouter as createCoreAiGatewayRouter,
  errorMessage,
} from "../../src/index.js";
import type { AiGatewayRouteDeps } from "../../src/index.js";
import { wireLogFixture } from "../helpers/wire-log.js";

function aiGatewaySettingsStub(settings: AiGatewayStoredSettings): () => AiGatewayStoredSettings {
  return () => settings;
}

const BASE = "/plugins/terminal/ai-gateway";
const MESSAGES = `${BASE}/v1/messages`;
const ANTHROPIC_CRED = "sk-ant-oat01-caller";
const SUBSCRIPTION_TOKEN = "chatgpt-subscription-access-token";
const ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";

/** Claude Code's shell-first directive as it arrives, with one neighbour on each side. */
/** A caller catalog carrying the tools provider policies decide about. */
const SEARCH_CATALOG = [
  { name: "Read", input_schema: { type: "object", properties: {} } },
  { name: "Grep", input_schema: { type: "object", properties: {} } },
  { name: "Glob", input_schema: { type: "object", properties: {} } },
  { name: "WebSearch", input_schema: { type: "object", properties: { query: { type: "string" } } } },
];

describe("Claude Codex compaction routing", () => {

  it("refuses compact events without the process token", async () => {
    const router = createAiGatewayRouter({
      readAuth,
      compactionStore: {} as any,
      compactionHookToken: "hook-token",
    });
    const res = response();
    await router.handle(ctx({
      res,
      pathname: `${BASE}/v1/compact-events`,
      rawBody: { hook_event_name: "PreCompact", session_id: "session", trigger: "auto" },
    }));
    expect(res.status).toBe(401);
  });
});

describe("caller credential", () => {
  it("rejects a request that carries no credential", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res }));

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Missing Anthropic credential" },
    });
  });

});

describe("upstream credential", () => {

  it("never echoes the subscription token back to the caller", async () => {
    const router = createAiGatewayRouter({ gateway: stubGateway(), readAuth });
    const res = response();
    await router.handle(ctx({ res, token: ANTHROPIC_CRED }));

    expect(`${JSON.stringify(res.headers)}${res.body}`).not.toContain(SUBSCRIPTION_TOKEN);
  });
});

describe("oversized skill payloads", () => {
  const LISTING = [
    "The following skills are available for use with the Skill tool:",
    "",
    "- agent-browser: Browser automation CLI for AI agents.",
    "- claude-api: Reference for the Claude API / Anthropic SDK.",
    "TRIGGER — read BEFORE opening the target file.",
  ].join("\n");
  // 4 chars/token puts this at 150_000 tokens, past the 54_400 one skill may take
  // from a 272_000-token window.
  const BODY = "Base directory for this skill: /tmp/bundled-skills/2.1.222/abc/claude-api\n\n"
    + "x".repeat(600_000);

  function sentText(request: AnthropicMessagesRequest | undefined, index: number): string {
    const content = request?.messages[index]?.content;
    if (typeof content === "string") return content;
    const block = content?.[0];
    return block && "text" in block && typeof block.text === "string" ? block.text : "";
  }

  it("withholds the body before the provider sees it, and delists the skill from then on", async () => {
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const listingTurn = { role: "user", content: [{ type: "text", text: LISTING }] };

    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-terra",
      messages: [listingTurn, { role: "user", content: [{ type: "text", text: BODY }] }],
    }));

    const first = streamSpy.mock.calls[0]?.[0];
    expect(sentText(first, 1)).toMatch(/^\[Fleet AI gateway withheld the "claude-api" skill/);
    expect(sentText(first, 1)).not.toContain("xxxx");
    // The listing loses the entry in the same request that withheld its body.
    expect(sentText(first, 0)).not.toContain("claude-api");
    expect(sentText(first, 0)).toContain("- agent-browser:");

    // A later turn on the same router never carries the entry at all.
    await router.handle(ctx({
      res: response(),
      token: ANTHROPIC_CRED,
      model: "claude-gateway--codex--gpt-5.6-terra",
      messages: [listingTurn],
    }));

    expect(sentText(streamSpy.mock.calls[1]?.[0], 0)).not.toContain("claude-api");
    expect(sentText(streamSpy.mock.calls[1]?.[0], 0)).toContain("- agent-browser:");
  });
});

// 선별은 광고 목록이 아니라 지출 계약이다. 디스커버리가 켠 모델만 내놓아도 실행 경로가 카탈로그
// 전체를 받아 주면, raw id를 아는 호출자가 사용자가 끈 모델로 그 구독을 그대로 쓴다.

describe("request body limit", () => {
  it("refuses a body past the limit with a 413 that does not arm reactive compaction", async () => {
    // "context window"가 들어간 413만 Claude Code의 압축을 무장시킨다(canonical/index.ts).
    // 큰 본문이 곧 창 초과는 아니므로 그 문구를 빌려 쓰지 않는다.
    const gateway = stubGateway();
    const streamSpy = vi.spyOn(gateway, "stream");
    const router = createAiGatewayRouter({ gateway, readAuth });
    const res = response();

    await router.handle(oversizedCtx(res, MAX_GATEWAY_REQUEST_BODY_BYTES));

    expect(res.status).toBe(413);
    expect(res.body).not.toContain("context window");
    expect(streamSpy).not.toHaveBeenCalled();
  });
});

function oversizedCtx(res: ResponseStub, limit: number): GatewayHttpHandlerContext {
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const req = {
    method: "POST",
    headers: { authorization: `Bearer ${ANTHROPIC_CRED}` },
    once: () => undefined,
    off: () => undefined,
    async *[Symbol.asyncIterator]() {
      for (let sent = 0; sent <= limit; sent += chunk.length) yield chunk;
    },
  };
  return { req, res, pathname: MESSAGES } as unknown as GatewayHttpHandlerContext;
}

describe("route surface", () => {

  it("rejects an unknown id reserved for the gateway instead of leaking it to Anthropic", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const router = createAiGatewayRouter({ fetch: fetchMock, readAuth });
    const res = response();
    await router.handle(ctx({
      res,
      token: ANTHROPIC_CRED,
      model: "claude-gateway--cursor--does-not-exist",
    }));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function createAiGatewayRouter(
  deps: Partial<AiGatewayRouteDeps> = {},
) {
  // readAuth/readCursorToken은 프로덕션에서 필수 주입이다. 테스트 래퍼는 자격증명 부재 스텁을
  // 기본값으로 두고, 각 테스트가 필요한 조달자만 덮어쓴다.
  return createCoreAiGatewayRouter({
    originator: "fleet-console",
    readAuth: () => null,
    readCursorToken: () => null,
    ...deps,
  });
}

function readAuth() {
  return { accessToken: SUBSCRIPTION_TOKEN, accountId: ACCOUNT_ID };
}

function stubGateway(onRequest?: (request: CanonicalResponseRequest) => void): AnthropicMessagesGateway {
  const adapter: AiGatewayAdapter = {
    async stream(request): Promise<AdapterResponse> {
      onRequest?.(request);
      return successfulAdapterResponse();
    },
  };
  return new AnthropicMessagesGateway(adapter);
}

function successfulAdapterResponse(): AdapterResponse {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    events: (async function* () {
      yield {
        type: "response.created",
        response: { id: "resp_stub", model: "gpt-5.5", usage: null },
      } as const;
      yield {
        type: "response.completed",
        response: {
          id: "resp_stub",
          model: "gpt-5.5",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      } as const;
    })(),
  };
}

interface ResponseStub {
  status: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: Uint8Array | string): boolean;
  end(body?: string): void;
  once(event: string, listener: () => void): void;
}

function response(): ResponseStub {
  const decoder = new TextDecoder();
  return {
    status: 0,
    headers: {},
    body: "",
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) {
      this.body += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      return true;
    },
    end(body) {
      if (body !== undefined) this.body += body;
    },
    once() {
      /* backpressure is never exercised by the stub writer */
    },
  };
}

function ctx(options: {
  readonly res: ResponseStub;
  readonly token?: string;
  readonly pathname?: string;
  readonly method?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly thinking?: Record<string, unknown>;
  readonly outputConfig?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown> | null;
  readonly messages?: ReadonlyArray<Record<string, unknown>>;
  readonly tools?: ReadonlyArray<Record<string, unknown>>;
  readonly toolChoice?: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rawBody?: unknown;
}): GatewayHttpHandlerContext {
  const payload = JSON.stringify(options.rawBody ?? {
    model: options.model ?? "claude-gateway--codex--gpt-5.6-sol",
    messages: options.messages ?? [{ role: "user", content: "Hello" }],
    max_tokens: 128,
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options.outputConfig ? { output_config: options.outputConfig } : {}),
    ...(options.metadata === null
      ? {}
      : { metadata: options.metadata ?? { user_id: "claude-session-test" } }),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    stream: true,
  });
  const req = {
    method: options.method ?? "POST",
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.apiKey === undefined ? {} : { "x-api-key": options.apiKey }),
      ...options.headers,
    },
    once: () => undefined,
    off: () => undefined,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload);
    },
  };
  return {
    req,
    res: options.res,
    pathname: options.pathname ?? MESSAGES,
  } as unknown as GatewayHttpHandlerContext;
}
