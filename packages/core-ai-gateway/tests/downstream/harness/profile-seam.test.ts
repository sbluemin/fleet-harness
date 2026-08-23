import { describe, expect, it } from "vitest";

import {
  AnthropicMessagesGateway,
  createAiGatewayRouter,
  findGatewayModel,
} from "../../../src/index.js";
import type {
  AdapterResponse,
  AiGatewayAdapter,
  GatewayModel,
} from "../../../src/index.js";
import type { GatewayHarnessProfile } from "../../../src/downstream/harness/contract.js";
import { claudeCodeHarnessProfile } from "../../../src/downstream/harness/claude-code/profile.js";
import type { GatewayHttpHandlerContext } from "../../../src/router/types.js";

/**
 * The seam a second harness arrives through.
 *
 * Nothing in the package ships a second profile yet — Grok Build's folder is still a
 * placeholder — so this file is where the contract is proven serveable by a client that
 * answers every field differently from Claude Code. Without it the profile indirection
 * would only ever be exercised by its own default, which proves nothing.
 */
const BASE = "/plugins/terminal/ai-gateway";
const MESSAGES = `${BASE}/v1/messages`;

/** A client that speaks the same wire and shares none of Claude Code's dialect. */
const bareHarness: GatewayHarnessProfile = {
  id: "test-bare-client",
  wire: "anthropic-messages",
  // Opens with its first real request — no liveness probe.
  probePaths: [],
  // Any non-empty credential: a per-model API key the client's own config file carries.
  acceptsCredential: (credential) => credential.length > 0,
  findModel: (id, catalog) => findGatewayModel(id, catalog),
  buildModelList: (models: readonly GatewayModel[]) => ({
    models: models.map((model) => ({ id: model.id, context_window: model.contextWindow ?? null })),
  }),
  sanitizeRequest: (request) => request,
  // Reads the provider's real window from its own config, so it is metered unprojected.
  transientErrorStatus: 503,
};

describe("gateway harness profile seam", () => {
  it("serves a client that shares none of Claude Code's dialect", async () => {
    const router = createAiGatewayRouter({
      originator: "test",
      harness: bareHarness,
      readAuth: () => ({ accessToken: "chatgpt-token", accountId: "account" }),
      readCursorToken: () => null,
      gateway: stubGateway(),
    });

    // A bare catalog id and a credential with no `sk-ant-` prefix are both accepted.
    const res = response();
    await router.handle(ctx({ res, token: "grok-local-key", model: "codex--gpt-5.6-sol" }));
    expect(res.status).toBe(200);

    // 221k of a 272k window reaches the client as 221k, not rescaled onto a 200k coordinate.
    const started = res.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; message?: { usage?: { input_tokens?: number } } })
      .find((frame) => frame.type === "message_start");
    expect(started?.message?.usage?.input_tokens).toBe(221_000);
  });

  it("answers discovery in the client's own payload shape", async () => {
    const router = createAiGatewayRouter({
      originator: "test",
      harness: bareHarness,
      readAuth: () => null,
      readCursorToken: () => null,
    });

    const res = response();
    await router.handle(ctx({ res, token: "grok-local-key", pathname: `${BASE}/v1/models` }));

    const payload = JSON.parse(res.body) as { models?: ReadonlyArray<{ id: string }> };
    expect(payload.models?.length).toBeGreaterThan(0);
    // The Claude id grammar is one client's spelling, not the catalog's.
    expect(payload.models?.every((entry) => !entry.id.startsWith("claude-gateway--"))).toBe(true);
  });

  it("declines a probe path the client never dials", async () => {
    const router = createAiGatewayRouter({
      originator: "test",
      harness: bareHarness,
      readAuth: () => null,
      readCursorToken: () => null,
    });

    const res = response();
    const handled = await router.handle(ctx({ res, pathname: `${BASE}/api/hello` }));
    expect(handled).toBe(false);
    expect(res.headersSent).toBe(false);
  });

  it("keeps Claude Code as the default when a host names no client", async () => {
    const router = createAiGatewayRouter({
      originator: "test",
      readAuth: () => null,
      readCursorToken: () => null,
      gateway: stubGateway(),
    });

    // The default profile still answers Claude Code's probe...
    const probe = response();
    expect(await router.handle(ctx({ res: probe, pathname: `${BASE}/api/hello` }))).toBe(true);
    expect(probe.status).toBe(200);

    // ...and still refuses a credential Claude Code would never send.
    const refused = response();
    await router.handle(ctx({ res: refused, token: "grok-local-key" }));
    expect(refused.status).toBe(401);
  });

  it("declares Claude Code's own answers on its profile", () => {
    expect(claudeCodeHarnessProfile.probePaths).toEqual(["/api/hello"]);
    expect(claudeCodeHarnessProfile.acceptsCredential("sk-ant-oat01-caller")).toBe(true);
    expect(claudeCodeHarnessProfile.acceptsCredential("grok-local-key")).toBe(false);
    expect(claudeCodeHarnessProfile.usageProjection?.(undefined)).toBeTypeOf("function");
    expect(bareHarness.usageProjection).toBeUndefined();
  });
});

function stubGateway(): AnthropicMessagesGateway {
  const adapter: AiGatewayAdapter = {
    async stream(): Promise<AdapterResponse> {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        events: (async function* () {
          yield {
            type: "response.created",
            response: {
              id: "resp_stub",
              model: "gpt-5.6-sol",
              usage: { input_tokens: 221_000, output_tokens: 0 },
            },
          } as const;
          yield {
            type: "response.completed",
            response: {
              id: "resp_stub",
              model: "gpt-5.6-sol",
              usage: { input_tokens: 221_000, output_tokens: 1 },
            },
          } as const;
        })(),
      };
    },
  };
  return new AnthropicMessagesGateway(adapter);
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
  readonly model?: string;
}): GatewayHttpHandlerContext {
  const payload = JSON.stringify({
    model: options.model ?? "codex--gpt-5.6-sol",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 128,
    stream: true,
  });
  const req = {
    method: "POST",
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
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
