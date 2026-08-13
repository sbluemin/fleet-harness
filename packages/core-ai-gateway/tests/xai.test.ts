import { describe, expect, it, vi } from "vitest";

import {
  XAI_CLI_CLIENT_VERSION,
  XAI_CLI_CREDITS_URL,
  XAI_CLI_RESPONSES_URL,
  XaiResponsesAdapter,
  fetchXaiUsage,
  parseXaiCredits,
  resolveXaiCliCredentials,
  xaiCliAuthFilePath,
} from "../src/index.js";
import type {
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CredentialResolverDeps,
} from "../src/index.js";

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

function controlledXaiResponse(): {
  response: Response;
  push: (chunk: string) => void;
  close: () => void;
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

function responseCompleted(): CanonicalResponseEvent {
  return { type: "response.completed", response: xaiSnapshot() };
}

function responseCreated(): CanonicalResponseEvent {
  return { type: "response.created", response: xaiSnapshot() };
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

  it("skips an expired profile when another active Grok CLI profile exists", async () => {
    await expect(resolveXaiCliCredentials(deps(JSON.stringify({
      "https://auth.x.ai::expired": {
        key: "expired-token",
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-13T00:00:00Z",
      },
      "https://auth.x.ai::active": {
        key: "active-token",
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-15T00:00:00Z",
      },
    })), () => Date.parse("2026-08-14T00:00:00Z"))).resolves.toMatchObject({
      accessToken: "active-token",
    });
  });
});

describe("Grok quota", () => {
  it("parses the weekly credits window", () => {
    expect(parseXaiCredits({ config: {
      creditUsagePercent: 42.4,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-10T00:00:00Z",
        end: "2026-08-17T00:00:00Z",
      },
    } })).toMatchObject({
      id: "weekly",
      usedPercent: 42,
      resetsAt: Date.parse("2026-08-17T00:00:00Z"),
      period: { durationBasis: "upstream", startsAtBasis: "upstream" },
    });
    expect(XAI_CLI_CREDITS_URL).toContain("billing?format=credits");
  });

  it("rejects a credits response without a finite usage percentage", () => {
    const period = {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-10T00:00:00Z",
      end: "2026-08-17T00:00:00Z",
    };
    expect(parseXaiCredits({ config: { currentPeriod: period } })).toBeNull();
    expect(parseXaiCredits({ config: { creditUsagePercent: Number.NaN, currentPeriod: period } })).toBeNull();
  });

  it("reads weekly credits with Grok CLI subscription headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ config: {
      creditUsagePercent: 42.4,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-10T00:00:00Z",
        end: "2026-08-17T00:00:00Z",
      },
    } }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await fetchXaiUsage({
      credentials: deps(JSON.stringify({
        "https://auth.x.ai::profile": {
          key: "access-token",
          oidc_issuer: "https://auth.x.ai",
          expires_at: "2026-08-15T00:00:00Z",
          user_id: "user-1",
        },
      })),
      fetch: fetchMock,
      now: () => Date.parse("2026-08-14T00:00:00Z"),
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(String(url)).toBe(XAI_CLI_CREDITS_URL);
    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(headers.get("x-userid")).toBe("user-1");
    expect(result).toMatchObject({ status: "ok", windows: [{ id: "weekly", usedPercent: 42 }] });
  });
});

describe("Grok Responses function-call assembly", () => {
  it("emits a function call atomically only after output_item.done", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => xaiResponse(
      xaiFrame(responseCreated()),
      xaiFrame(functionCallAdded("call-1")),
      xaiFrame(argumentsDone("call-1", 0, '{"path":"a.ts"}')),
      xaiFrame(functionCallDone("call-1", 0, '{"path":"a.ts"}')),
      xaiFrame(responseCompleted()),
    ));
    const response = await new XaiResponsesAdapter({ fetch: fetchMock }).stream(functionCallRequest(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    const events = await collectXaiEvents(response.events);
    expect(eventTypes(events)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const addedIndex = events.findIndex((event) => event.type === "response.output_item.added");
    const doneIndex = events.findIndex((event) => event.type === "response.output_item.done");
    expect(addedIndex).toBeLessThan(doneIndex);
    expect(events[1]).toMatchObject({ type: "response.output_item.added", item: { id: "call-1" } });
  });

  it("does not emit an added call when response.completed arrives first", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => xaiResponse(
      xaiFrame(functionCallAdded("call-1")),
      xaiFrame(responseCompleted()),
    ));
    const response = await new XaiResponsesAdapter({ fetch: fetchMock }).stream(functionCallRequest(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    await expect(collectXaiEvents(response.events)).rejects.toThrow("response.completed arrived before");
  });

  it("reports EOF while a function call is pending", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => xaiResponse(xaiFrame(functionCallAdded("call-1"))));
    const response = await new XaiResponsesAdapter({ fetch: fetchMock }).stream(functionCallRequest(), { apiKey: "k" });
    if (!response.ok) throw new Error("expected ok");
    await expect(collectXaiEvents(response.events)).rejects.toThrow("stream ended before");
  });

  it("times out a pending call despite keepalive and unrelated canonical events", async () => {
    vi.useFakeTimers();
    try {
      const controlled = controlledXaiResponse();
      const fetchMock = vi.fn<typeof fetch>(async () => controlled.response);
      const response = await new XaiResponsesAdapter({ fetch: fetchMock, functionCallTimeoutMs: 20 }).stream(functionCallRequest(), { apiKey: "k" });
      if (!response.ok) throw new Error("expected ok");
      const events = collectXaiEvents(response.events);
      const eventsExpectation = expect(events).rejects.toThrow("assembly exceeded 20ms");
      controlled.push(xaiFrame(functionCallAdded("call-1")));
      await flushXaiStream();
      controlled.push(": keepalive\n\n");
      controlled.push(xaiFrame(textDelta("still alive")));
      await flushXaiStream();
      await vi.advanceTimersByTimeAsync(20);
      await eventsExpectation;
      expect(controlled.wasCancelled()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives staggered parallel calls independent full deadlines", async () => {
    vi.useFakeTimers();
    try {
      const controlled = controlledXaiResponse();
      const fetchMock = vi.fn<typeof fetch>(async () => controlled.response);
      const response = await new XaiResponsesAdapter({ fetch: fetchMock, functionCallTimeoutMs: 50 }).stream(functionCallRequest(), { apiKey: "k" });
      if (!response.ok) throw new Error("expected ok");
      const events = collectXaiEvents(response.events);
      controlled.push(xaiFrame(functionCallAdded("call-1", 0)));
      await flushXaiStream();
      await vi.advanceTimersByTimeAsync(30);
      controlled.push(xaiFrame(functionCallAdded("call-2", 1)));
      controlled.push(xaiFrame(functionCallDone("call-1", 0)));
      await flushXaiStream();
      controlled.push(xaiFrame(functionCallDone("call-2", 1)));
      controlled.push(xaiFrame(responseCompleted()));
      controlled.close();
      await expect(events).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "response.output_item.done", output_index: 1 }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("caller abort cancels the upstream read and leaves no pending timer", async () => {
    vi.useFakeTimers();
    try {
      const controlled = controlledXaiResponse();
      const fetchMock = vi.fn<typeof fetch>(async () => controlled.response);
      const caller = new AbortController();
      const response = await new XaiResponsesAdapter({ fetch: fetchMock, functionCallTimeoutMs: 100 }).stream(functionCallRequest(), { apiKey: "k", signal: caller.signal });
      if (!response.ok) throw new Error("expected ok");
      const events = collectXaiEvents(response.events);
      controlled.push(xaiFrame(functionCallAdded("call-1")));
      await flushXaiStream();
      caller.abort(new Error("caller stopped"));
      await expect(events).rejects.toThrow("caller stopped");
      expect(controlled.wasCancelled()).toBe(true);
      await vi.advanceTimersByTimeAsync(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves text-only streaming unchanged and preserves normal completion lifecycle", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => xaiResponse(
      xaiFrame(responseCreated()),
      xaiFrame(textDelta("hi")),
      xaiFrame(textDone("hi")),
      xaiFrame(responseCompleted()),
    ));
    const caller = new AbortController();
    const response = await new XaiResponsesAdapter({ fetch: fetchMock }).stream(xaiRequest(), { apiKey: "k", signal: caller.signal });
    if (!response.ok) throw new Error("expected ok");
    await expect(collectXaiEvents(response.events)).resolves.toEqual([
      responseCreated(),
      textDelta("hi"),
      textDone("hi"),
      responseCompleted(),
    ]);
    expect(caller.signal.aborted).toBe(false);
  });

  it("requires a positive function-call timeout option", () => {
    expect(() => new XaiResponsesAdapter({ functionCallTimeoutMs: 0 })).toThrow("functionCallTimeoutMs must be a positive integer");
    expect(() => new XaiResponsesAdapter({ functionCallTimeoutMs: -1 })).toThrow("functionCallTimeoutMs must be a positive integer");
    expect(() => new XaiResponsesAdapter({ functionCallTimeoutMs: 1.5 })).toThrow("functionCallTimeoutMs must be a positive integer");
  });
});

describe("Grok Responses adapter", () => {
  it("uses the CLI proxy with subscription and model headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("data: [DONE]\n\n", { status: 200 }));
    const request: CanonicalResponseRequest = {
      model: "grok-4.6",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
      metadata: { user_id: "caller-metadata" },
    };
    await new XaiResponsesAdapter({ fetch: fetchMock }).stream(request, { apiKey: "session-token" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(String(url)).toBe(XAI_CLI_RESPONSES_URL);
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(headers.get("x-grok-client-version")).toBe(XAI_CLI_CLIENT_VERSION);
    expect(headers.get("x-grok-model-override")).toBe("grok-4.6");
    expect(body).toMatchObject({
      model: "grok-4.6",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
    });
    expect(body).not.toHaveProperty("metadata");
  });
});
