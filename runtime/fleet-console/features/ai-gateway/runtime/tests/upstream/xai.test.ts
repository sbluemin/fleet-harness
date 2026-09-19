import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  XAI_CLI_CREDITS_URL,
  XAI_CLI_REFRESH_URL,
  XAI_CLI_CLIENT_VERSION,
  XAI_CLI_RESPONSES_URL,
  XAI_RESPONSES_URL,
  XAI_CLI_SETTINGS_URL,
  XaiResponsesAdapter,
  encodeAnthropicSse,
  fetchXaiUsage,
  parseXaiCredits,
  parseXaiPlan,
  resolveXaiCliAuth,
  resolveXaiCliCredentials,
  xaiCliAuthFilePath,
} from "../../src/index.js";
import type {
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CredentialResolverDeps,
} from "../../src/index.js";
import { wireLogFixture } from "../helpers/wire-log.js";

function xaiRequest(overrides: Partial<CanonicalResponseRequest> = {}): CanonicalResponseRequest {
  return {
    model: "grok-4.6",
    input: [{ type: "message", role: "user", content: "hi" }],
    stream: true,
    ...overrides,
  };
}

function xaiFrame(event: CanonicalResponseEvent | Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function xaiResponse(...frames: string[]): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function xaiSnapshot(id = "r1"): { id: string; model: string; usage: null } {
  return { id, model: "grok-4.6", usage: null };
}

async function collectXaiEvents(events: AsyncIterable<CanonicalResponseEvent>): Promise<CanonicalResponseEvent[]> {
  const collected: CanonicalResponseEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function collectEncodedBody(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of body) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

function parseEncodedSse(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .trim()
    .split(/\r?\n\r?\n/)
    .map((frameText) => {
      const lines = frameText.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (event === undefined || data === undefined) {
        throw new Error(`Invalid SSE frame: ${frameText}`);
      }
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

function controlledXaiResponse(): {
  response: Response;
  push: (chunk: string) => void;
  close: () => void;
  error: (reason: unknown) => void;
  wasCancelled: () => boolean;
} {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push(chunk) {
      streamController?.enqueue(encoder.encode(chunk));
    },
    close() {
      streamController?.close();
    },
    error(reason) {
      streamController?.error(reason);
    },
    wasCancelled() {
      return cancelled;
    },
  };
}

function functionCallAdded(id: string, outputIndex = 0): CanonicalResponseEvent {
  return {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { type: "function_call", id, call_id: id, name: "Read", arguments: "" },
  };
}

function functionCallDone(id: string, outputIndex = 0, argumentsValue = "{}"): CanonicalResponseEvent {
  return {
    type: "response.output_item.done",
    output_index: outputIndex,
    item: { type: "function_call", id, call_id: id, name: "Read", arguments: argumentsValue },
  };
}

function responseCompleted(id = "r1"): CanonicalResponseEvent {
  return { type: "response.completed", response: xaiSnapshot(id) };
}

function responseCreated(id = "r1"): CanonicalResponseEvent {
  return { type: "response.created", response: xaiSnapshot(id) };
}

function textDelta(delta: string): CanonicalResponseEvent {
  return { type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta };
}

function textDone(text: string): CanonicalResponseEvent {
  return { type: "response.output_text.done", item_id: "m1", output_index: 0, content_index: 0, text };
}

function argumentsDone(id: string, outputIndex = 0, value = "{}"): CanonicalResponseEvent {
  return { type: "response.function_call_arguments.done", item_id: id, output_index: outputIndex, arguments: value };
}

function argumentsDelta(id: string, outputIndex = 0, delta = "{}"): CanonicalResponseEvent {
  return { type: "response.function_call_arguments.delta", item_id: id, output_index: outputIndex, delta };
}

async function flushXaiStream(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function functionCallRequest(): CanonicalResponseRequest {
  return xaiRequest({
    tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
  });
}

function eventTypes(events: readonly CanonicalResponseEvent[]): string[] {
  return events.map((event) => event.type);
}

function deps(raw: string | null, env: NodeJS.ProcessEnv = {}): CredentialResolverDeps {
  return {
    platform: "linux",
    homedir: () => "/home/test",
    env,
    readBounded: vi.fn(async () => raw),
    execFile: vi.fn(async () => ""),
  };
}

function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

const WEEKLY_PERIOD = {
  type: "USAGE_PERIOD_TYPE_WEEKLY",
  start: "2026-08-10T00:00:00Z",
  end: "2026-08-17T00:00:00Z",
};

function creditsResponse(config: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ config }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function settingsResponse(plan: string, status = 200): Response {
  return new Response(JSON.stringify({ subscription_tier_display: plan }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refreshResponse(accessToken: string, expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Grok CLI credentials", () => {
  it("honors GROK_HOME and reads a fresh auth.x.ai entry", async () => {
    const credentialDeps = deps(JSON.stringify({
      "https://auth.x.ai::profile": {
        key: "access-token",
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-14T01:00:00Z",
        user_id: "user-1",
      },
    }), { GROK_HOME: "/custom/grok" });
    expect(xaiCliAuthFilePath(credentialDeps)).toBe("/custom/grok/auth.json");
    await expect(resolveXaiCliCredentials(credentialDeps, () => Date.parse("2026-08-14T00:00:00Z")))
      .resolves.toEqual({ accessToken: "access-token", expiresAt: Date.parse("2026-08-14T01:00:00Z"), userId: "user-1" });
  });

  it("rejects expired, wrong-issuer, and malformed entries", async () => {
    await expect(resolveXaiCliCredentials(deps(JSON.stringify({
      "https://auth.x.ai::profile": { key: "token", oidc_issuer: "https://auth.x.ai", expires_at: "2026-08-13T00:00:00Z" },
    })), () => Date.parse("2026-08-14T00:00:00Z"))).resolves.toBeNull();
    await expect(resolveXaiCliCredentials(deps(JSON.stringify({
      "https://auth.x.ai::profile": { key: "token", oidc_issuer: "https://evil.example" },
    })))).resolves.toBeNull();
  });
});

describe("Grok endpoint selection", () => {
  function refusal(status: number): Response {
    return new Response(JSON.stringify({ error: "nope" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function okStream(): Response {
    return xaiResponse(xaiFrame(responseCreated()), xaiFrame(textDelta("hi")), xaiFrame(responseCompleted()));
  }

  function overloadStream(): Response {
    return xaiResponse(xaiFrame({
      type: "error",
      code: null,
      message: "The model is currently at capacity due to high demand.",
    }));
  }

  it("uses the proxy by default, with the CLI identity the proxy gates on", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okStream());
    const response = await new XaiResponsesAdapter({ fetch: fetchMock, clientVersion: async () => "9.9.9" })
      .stream(xaiRequest(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    await collectXaiEvents(response.events);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(XAI_CLI_RESPONSES_URL);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(headers.get("x-grok-client-version")).toBe("9.9.9");
    expect(headers.get("x-grok-model-override")).toBe("grok-4.6");
  });

  // The two endpoints do not share a prompt cache, so a crossing re-prefills the whole
  // conversation. No upstream answer is worth that, and none of these reroute the turn.
  for (const status of [400, 401, 402, 404, 426, 429, 500]) {
    it(`returns ${status} from the chosen endpoint rather than crossing`, async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(refusal(status));
      const response = await new XaiResponsesAdapter({ fetch: fetchMock, endpoint: "direct" })
        .stream(xaiRequest(), { apiKey: "k" });
      expect(response.ok).toBe(false);
      if (response.ok) throw new Error("expected refusal");
      expect(response.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(XAI_RESPONSES_URL);
    });
  }
});

describe("Grok Responses stall watchdog", () => {

  it("fails a stream that stops emitting events while keepalive bytes keep arriving", async () => {
    vi.useFakeTimers();
    try {
      const controlled = controlledXaiResponse();
      const fetchMock = vi.fn<typeof fetch>(async () => controlled.response);
      const response = await new XaiResponsesAdapter({ fetch: fetchMock, semanticStallTimeoutMs: 100 })
        .stream(xaiRequest(), { apiKey: "k" });
      if (!response.ok) throw new Error("expected ok");
      const events = collectXaiEvents(response.events);
      const eventsExpectation = expect(events).rejects.toThrow("emitted no event for 100ms");
      controlled.push(xaiFrame(responseCreated()));
      controlled.push(xaiFrame(textDelta("partial")));
      await flushXaiStream();
      // Comments feed the byte-level idle watchdog without carrying an event; before the stall
      // clock existed this was enough to park the read indefinitely.
      await vi.advanceTimersByTimeAsync(60);
      controlled.push(": keepalive\n\n");
      await flushXaiStream();
      await vi.advanceTimersByTimeAsync(60);
      await eventsExpectation;
      expect(controlled.wasCancelled()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Grok Responses retry", () => {
  const CAPACITY_MESSAGE = "The model is currently at capacity due to high demand."
    + " Please try again in a few minutes, or use a higher service tier for priority processing:"
    + " https://docs.x.ai/developers/advanced-api-usage/priority-processing";

  function failed(type = "server_error", id = "r1"): CanonicalResponseEvent {
    return {
      type: "response.failed",
      response: { ...xaiSnapshot(id), error: { type, message: "secret marker" } },
    };
  }

  function messageAdded(id = "m1"): CanonicalResponseEvent {
    return {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id, role: "assistant" },
    };
  }

  function reasoning(delta = "thinking"): CanonicalResponseEvent {
    return {
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning-1",
      output_index: 0,
      delta,
    };
  }

  function socketTermination(): TypeError {
    const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    return new TypeError("terminated", { cause: socket });
  }

  /** Captured verbatim from `xai-responses.wire.event`: both class-bearing fields are empty. */
  function capacityFrame(message = CAPACITY_MESSAGE): string {
    return xaiFrame({ sequence_number: 0, type: "error", code: null, message, param: null });
  }

  it("does not retry server_error after text output commits the attempt", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(xaiResponse(
      xaiFrame(responseCreated()),
      xaiFrame(textDelta("partial")),
      xaiFrame(failed()),
    ));
    const response = await new XaiResponsesAdapter({ fetch: fetchMock }).stream(xaiRequest(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");

    await expect(collectXaiEvents(response.events)).resolves.toEqual([
      responseCreated(),
      textDelta("partial"),
      failed(),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
