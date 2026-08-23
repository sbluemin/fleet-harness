import { describe, expect, it } from "vitest";

import { AnthropicMessagesGateway, createAiGatewayRouter } from "../../../../src/index.js";
import type { AdapterResponse, AiGatewayAdapter } from "../../../../src/index.js";
import { grokBuildHarnessProfile } from "../../../../src/downstream/harness/grok-build/profile.js";
import type { GatewayHttpHandlerContext } from "../../../../src/router/types.js";

/**
 * 두 하네스가 한 마운트를 함께 쓰는 자리.
 *
 * 라우터는 호출자를 판정하지 않는다 — 클라이언트가 자기 base URL에 적어 넣은 경로 조각을
 * 읽을 뿐이다. 이 파일이 그 계약과, Grok Build 프로필이 Claude Code와 다르게 답하는
 * 자리들을 함께 고정한다.
 */
const BASE = "/ai-gateway";
const CLAUDE_MESSAGES = `${BASE}/v1/messages`;
const GROK_MESSAGES = `${BASE}/grok/v1/messages`;
const GROK_MODEL = "grok-build-gateway--codex--gpt-5-6-sol";

describe("grok build harness selector", () => {
  it("routes the selector segment to grok and leaves the bare mount on Claude Code", async () => {
    const router = grokRouter();

    // Grok Build의 자격증명은 `sk-ant-` 접두가 없다. 선택자 경로에서는 통과하고…
    const grok = response();
    await router.handle(ctx({ res: grok, pathname: GROK_MESSAGES, model: GROK_MODEL, token: "eyJ0eXAiOiJKV1Qi" }));
    expect(grok.status).toBe(200);

    // …같은 자격증명이 기본 마운트에서는 거절된다. 기본 하네스는 여전히 Claude Code다.
    const claude = response();
    await router.handle(ctx({ res: claude, pathname: CLAUDE_MESSAGES, model: GROK_MODEL, token: "eyJ0eXAiOiJKV1Qi" }));
    expect(claude.status).toBe(401);
  });

  it("keeps a mount path that merely contains the selector name on the default harness", async () => {
    // 선택자는 엔드포인트 접미 **바로 앞** 조각이다. 마운트 경로에 같은 이름이 들어 있어도
    // 그 자리가 아니면 선택자가 아니다 — 아니면 호스트가 마운트를 옮기는 순간 하네스가 바뀐다.
    const router = grokRouter();
    const res = response();
    await router.handle(ctx({
      res,
      pathname: "/plugins/grok/ai-gateway/v1/messages",
      model: GROK_MODEL,
      token: "eyJ0eXAiOiJKV1Qi",
    }));
    expect(res.status).toBe(401);
  });

  it("falls to the default harness for a segment that names an inherited property", async () => {
    // 선택자 조회를 평범한 객체 인덱싱으로 하면 `toString` 같은 프로토타입 키가 함수로 잡히고,
    // 바로 다음 자격증명 검사에서 `acceptsCredential is not a function`으로 요청 처리가 죽는다.
    // 문서화된 동작은 "등록되지 않은 조각이면 기본 하네스"이므로, 여기서는 Claude Code가 답해야 한다.
    const router = grokRouter();
    const res = response();
    await router.handle(ctx({
      res,
      pathname: `${BASE}/toString/v1/messages`,
      model: GROK_MODEL,
      token: "eyJ0eXAiOiJKV1Qi",
    }));
    // 기본 하네스는 이 자격증명을 자기 것으로 인정하지 않는다 — 죽는 대신 401이다.
    expect(res.status).toBe(401);
  });

  it("refuses grok's own built-in model id instead of relaying it to Anthropic", async () => {
    // Grok Build는 세션마다 제목 생성 보조 턴을 같은 base_url로 보내는데, 그 턴의 모델 id는
    // 커스텀 모델이 아니라 내장 `grok-4.6`이고 본문에는 사용자 질의 원문이 들어 있다.
    // 중계를 허용하면 그 본문이 사용자가 고르지 않은 목적지로 나간다.
    const router = grokRouter();
    const res = response();
    await router.handle(ctx({ res, pathname: GROK_MESSAGES, model: "grok-4.6", token: "eyJ0eXAiOiJKV1Qi" }));
    expect(res.status).toBe(400);
    expect(res.body).toContain("Unknown AI gateway model");
  });

  it("carries the client's session header into the identity every upstream reads", async () => {
    // Cursor는 이 값이 없으면 요청을 거절하고, Codex는 sticky routing을 잃는다.
    const seen: Array<Record<string, unknown> | undefined> = [];
    const router = grokRouter(recordingGateway(seen));

    const res = response();
    await router.handle(ctx({
      res,
      pathname: GROK_MESSAGES,
      model: GROK_MODEL,
      token: "eyJ0eXAiOiJKV1Qi",
      headers: { "x-grok-session-id": "01a02cea-2ab6-7fd2-8500-a16d6aebb55e" },
    }));

    expect(res.status).toBe(200);
    expect(seen[0]?.user_id).toBe("01a02cea-2ab6-7fd2-8500-a16d6aebb55e");
  });

  it("never overwrites an identity the request body already carried", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const router = grokRouter(recordingGateway(seen));

    const res = response();
    await router.handle(ctx({
      res,
      pathname: GROK_MESSAGES,
      model: GROK_MODEL,
      token: "eyJ0eXAiOiJKV1Qi",
      headers: { "x-grok-session-id": "from-header" },
      metadata: { user_id: "from-body" },
    }));

    expect(seen[0]?.user_id).toBe("from-body");
  });

  it("treats the empty header grok sends before a session exists as no identity", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const router = grokRouter(recordingGateway(seen));

    const res = response();
    await router.handle(ctx({
      res,
      pathname: GROK_MESSAGES,
      model: GROK_MODEL,
      token: "eyJ0eXAiOiJKV1Qi",
      headers: { "x-grok-session-id": "", "x-grok-conv-id": "" },
    }));

    expect(res.status).toBe(200);
    expect(seen[0]?.user_id).toBeUndefined();
  });

  it("meters the provider's real window instead of Claude Code's coordinate", async () => {
    const router = grokRouter();
    const res = response();
    await router.handle(ctx({ res, pathname: GROK_MESSAGES, model: GROK_MODEL, token: "eyJ0eXAiOiJKV1Qi" }));

    const started = res.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; message?: { usage?: { input_tokens?: number } } })
      .find((frame) => frame.type === "message_start");
    // 272k 창의 221k가 그대로 221k로 간다. Claude 좌표로 접으면 약 0.637배가 된다.
    expect(started?.message?.usage?.input_tokens).toBe(221_000);
  });

  it("answers grok discovery on the selector path and Claude discovery on the bare mount", async () => {
    const router = grokRouter();

    const grok = response();
    await router.handle(ctx({ res: grok, pathname: `${BASE}/grok/v1/models`, token: "eyJ0eXAiOiJKV1Qi" }));
    const grokList = JSON.parse(grok.body) as { data: ReadonlyArray<{ id: string }> };
    expect(grokList.data.every((entry) => entry.id.startsWith("grok-build-gateway--"))).toBe(true);

    const claude = response();
    await router.handle(ctx({ res: claude, pathname: `${BASE}/v1/models`, token: "sk-ant-fleet-local" }));
    const claudeList = JSON.parse(claude.body) as { data: ReadonlyArray<{ id: string }> };
    expect(claudeList.data.every((entry) => entry.id.startsWith("claude-gateway--"))).toBe(true);
  });

  it("declares grok's own answers on its profile", () => {
    expect(grokBuildHarnessProfile.probePaths).toEqual([]);
    expect(grokBuildHarnessProfile.acceptsCredential("eyJ0eXAiOiJKV1Qi")).toBe(true);
    expect(grokBuildHarnessProfile.acceptsCredential("")).toBe(false);
    expect(grokBuildHarnessProfile.relaysUnmatchedModel("anything")).toBe(false);
    // 투영이 없다는 것이 이 프로필의 요점이다.
    expect(grokBuildHarnessProfile.usageProjection).toBeUndefined();
    expect(grokBuildHarnessProfile.passthroughProjection).toBeUndefined();
    // 재시도 예산은 실측 전까지 비워 둔다 — Claude Code의 목록을 복사하지 않는다.
    expect(grokBuildHarnessProfile.retryableStatus).toBeUndefined();
  });
});

function grokRouter(gateway: AnthropicMessagesGateway = stubGateway()) {
  return createAiGatewayRouter({
    originator: "test",
    harnesses: { grok: grokBuildHarnessProfile },
    readAuth: () => ({ accessToken: "chatgpt-token", accountId: "account" }),
    readCursorToken: () => null,
    gateway,
  });
}

function recordingGateway(sink: Array<Record<string, unknown> | undefined>): AnthropicMessagesGateway {
  const adapter: AiGatewayAdapter = {
    async stream(request): Promise<AdapterResponse> {
      sink.push(request.metadata as Record<string, unknown> | undefined);
      return streamedResponse();
    },
  };
  return new AnthropicMessagesGateway(adapter);
}

function stubGateway(): AnthropicMessagesGateway {
  const adapter: AiGatewayAdapter = {
    async stream(): Promise<AdapterResponse> {
      return streamedResponse();
    },
  };
  return new AnthropicMessagesGateway(adapter);
}

function streamedResponse(): AdapterResponse {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    events: (async function* () {
      yield {
        type: "response.created",
        response: { id: "resp_stub", model: "gpt-5.6-sol", usage: { input_tokens: 221_000, output_tokens: 0 } },
      } as const;
      yield {
        type: "response.completed",
        response: { id: "resp_stub", model: "gpt-5.6-sol", usage: { input_tokens: 221_000, output_tokens: 1 } },
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
  readonly pathname: string;
  readonly token?: string;
  readonly model?: string;
  readonly headers?: Record<string, string>;
  readonly metadata?: Record<string, unknown>;
}): GatewayHttpHandlerContext {
  const payload = JSON.stringify({
    model: options.model ?? GROK_MODEL,
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 128,
    stream: true,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
  const req = {
    method: "POST",
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...options.headers,
    },
    once: () => undefined,
    off: () => undefined,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload);
    },
  };
  return { req, res: options.res, pathname: options.pathname } as unknown as GatewayHttpHandlerContext;
}
