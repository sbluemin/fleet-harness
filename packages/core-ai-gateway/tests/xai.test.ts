import { describe, expect, it, vi } from "vitest";

import {
  XAI_CLI_CLIENT_VERSION,
  XAI_CLI_CREDITS_URL,
  XAI_CLI_REFRESH_URL,
  XAI_CLI_RESPONSES_URL,
  XAI_CLI_SETTINGS_URL,
  XaiResponsesAdapter,
  fetchXaiUsage,
  parseXaiCredits,
  parseXaiPlan,
  resolveXaiCliAuth,
  resolveXaiCliCredentials,
  xaiCliAuthFilePath,
} from "../src/index.js";
import type {
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CredentialResolverDeps,
} from "../src/index.js";
import { wireLogFixture } from "./helpers/wire-log.js";

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

  it("silently refreshes a still-renewable token and persists the replacement", async () => {
    const auth = {
      "https://auth.x.ai::profile": {
        key: jwtWithExp(Math.floor(Date.parse("2026-08-14T00:04:00Z") / 1_000)),
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-14T00:04:00Z",
        refresh_token: "refresh-1",
        oidc_client_id: "client-1",
        user_id: "user-1",
      },
    };
    const credentialDeps = deps(JSON.stringify(auth));
    const writeAuthFile = vi.fn(async () => {});
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toBe(XAI_CLI_REFRESH_URL);
      return refreshResponse("fresh-token", 7_200);
    });
    const result = await resolveXaiCliAuth(credentialDeps, {
      now: () => Date.parse("2026-08-14T00:00:00Z"),
      fetch: fetchMock,
      writeAuthFile,
    });
    expect(result).toEqual({
      status: "ok",
      credentials: {
        accessToken: "fresh-token",
        expiresAt: Date.parse("2026-08-14T02:00:00Z"),
        userId: "user-1",
      },
    });
    expect(writeAuthFile).toHaveBeenCalledTimes(1);
    const written = writeAuthFile.mock.calls.at(0)?.at(1);
    expect(JSON.parse(String(written))["https://auth.x.ai::profile"]).toMatchObject({
      key: "fresh-token",
      refresh_token: "refresh-1",
      user_id: "user-1",
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(String(init?.body)).toContain("grant_type=refresh_token");
    expect(String(init?.body)).toContain("client_id=client-1");
    expect(String(init?.body)).toContain("refresh_token=refresh-1");
  });

  it("does not persist a refresh when the file owner already rotated the same entry", async () => {
    const original = {
      "https://auth.x.ai::profile": {
        key: jwtWithExp(Math.floor(Date.parse("2026-08-14T00:04:00Z") / 1_000)),
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-14T00:04:00Z",
        refresh_token: "refresh-1",
        user_id: "user-1",
      },
    };
    const rotated = {
      "https://auth.x.ai::profile": {
        key: "cli-newer-access",
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-14T02:00:00Z",
        refresh_token: "refresh-2",
        user_id: "user-1",
      },
    };
    let reads = 0;
    const credentialDeps = deps(JSON.stringify(original));
    const readBounded = vi.fn(async () => {
      reads += 1;
      return JSON.stringify(reads === 1 ? original : rotated);
    });
    const sequentialDeps: CredentialResolverDeps = { ...credentialDeps, readBounded };
    const writeAuthFile = vi.fn(async () => {});
    const result = await resolveXaiCliAuth(sequentialDeps, {
      now: () => Date.parse("2026-08-14T00:00:00Z"),
      fetch: vi.fn<typeof fetch>(async () => refreshResponse("fleet-stale-access", 7_200)),
      writeAuthFile,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.credentials.accessToken).toBe("fleet-stale-access");
    expect(writeAuthFile).not.toHaveBeenCalled();
  });

  it("reports expired when every renewable profile fails to refresh", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("invalid_grant", { status: 400 }));
    await expect(resolveXaiCliAuth(deps(JSON.stringify({
      "https://auth.x.ai::profile": {
        key: "stale",
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-13T00:00:00Z",
        refresh_token: "refresh-1",
      },
    })), {
      now: () => Date.parse("2026-08-14T00:00:00Z"),
      fetch: fetchMock,
    })).resolves.toEqual({ status: "expired" });
  });
});

describe("Grok quota", () => {
  it("parses the weekly credits window", () => {
    expect(parseXaiCredits({ config: {
      creditUsagePercent: 42.4,
      currentPeriod: WEEKLY_PERIOD,
    } })).toMatchObject({
      status: "weekly",
      window: {
        id: "weekly",
        usedPercent: 42,
        resetsAt: Date.parse("2026-08-17T00:00:00Z"),
        period: { durationBasis: "upstream", startsAtBasis: "upstream" },
      },
    });
    expect(XAI_CLI_CREDITS_URL).toContain("billing?format=credits");
  });

  it("reads the Grok settings display string as the plan badge", () => {
    expect(parseXaiPlan({ subscription_tier_display: "SuperGrok" })).toBe("SuperGrok");
    expect(parseXaiPlan({ subscription_tier_display: "SuperGrok Plus" })).toBe("SuperGrok Plus");
    expect(parseXaiPlan({ subscription_tier_display: "SuperGrok Heavy" })).toBe("SuperGrok Heavy");
    expect(parseXaiPlan({ subscription_tier_display: "Bearer abc123" })).toBeUndefined();
    expect(XAI_CLI_SETTINGS_URL).toContain("/v1/settings");
  });

  it("treats an omitted creditUsagePercent as a genuine 0%", () => {
    // proto3 JSON drops zeros. OpenUsage documents the same shape: absent means 0, not drift.
    expect(parseXaiCredits({ config: { currentPeriod: WEEKLY_PERIOD } })).toMatchObject({
      status: "weekly",
      window: { id: "weekly", usedPercent: 0 },
    });
  });

  it("rejects a present non-finite usage percentage and accepts a non-weekly period as empty", () => {
    expect(parseXaiCredits({ config: { creditUsagePercent: Number.NaN, currentPeriod: WEEKLY_PERIOD } })).toBeNull();
    expect(parseXaiCredits({ config: {
      currentPeriod: { ...WEEKLY_PERIOD, type: "USAGE_PERIOD_TYPE_MONTHLY" },
    } })).toEqual({ status: "other" });
  });

  it("reads weekly credits with Grok CLI subscription headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === XAI_CLI_SETTINGS_URL) return settingsResponse("SuperGrok Heavy");
      return creditsResponse({
        creditUsagePercent: 42.4,
        currentPeriod: WEEKLY_PERIOD,
      });
    });
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
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(XAI_CLI_SETTINGS_URL);
    expect(result).toMatchObject({
      status: "ok",
      plan: "SuperGrok Heavy",
      windows: [{ id: "weekly", usedPercent: 42 }],
    });
  });

  it("returns an empty weekly window when proto-JSON omitted the 0% field", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => creditsResponse({ currentPeriod: WEEKLY_PERIOD }));
    await expect(fetchXaiUsage({
      credentials: deps(JSON.stringify({
        "https://auth.x.ai::profile": {
          key: "access-token",
          oidc_issuer: "https://auth.x.ai",
          expires_at: "2026-08-15T00:00:00Z",
        },
      })),
      fetch: fetchMock,
      now: () => Date.parse("2026-08-14T00:00:00Z"),
    })).resolves.toMatchObject({ status: "ok", windows: [{ id: "weekly", usedPercent: 0 }] });
  });

  it("refreshes once after a 401 and retries the credits request", async () => {
    const auth = {
      "https://auth.x.ai::profile": {
        key: "stale-token",
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-15T00:00:00Z",
        refresh_token: "refresh-1",
        user_id: "user-1",
      },
    };
    let creditsCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const href = String(url);
      if (href === XAI_CLI_CREDITS_URL) {
        creditsCalls += 1;
        if (creditsCalls === 1) return new Response("unauthorized", { status: 401 });
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-token");
        return creditsResponse({ creditUsagePercent: 7, currentPeriod: WEEKLY_PERIOD });
      }
      if (href === XAI_CLI_REFRESH_URL) return refreshResponse("fresh-token");
      if (href === XAI_CLI_SETTINGS_URL) return settingsResponse("SuperGrok Plus");
      throw new Error(`unexpected fetch ${href}`);
    });
    const result = await fetchXaiUsage({
      credentials: deps(JSON.stringify(auth)),
      fetch: fetchMock,
      now: () => Date.parse("2026-08-14T00:00:00Z"),
    });
    expect(result).toMatchObject({
      status: "ok",
      plan: "SuperGrok Plus",
      windows: [{ usedPercent: 7 }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps the usage snapshot when the settings plan call fails", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === XAI_CLI_SETTINGS_URL) return new Response("not found", { status: 404 });
      return creditsResponse({ creditUsagePercent: 11, currentPeriod: WEEKLY_PERIOD });
    });
    const result = await fetchXaiUsage({
      credentials: deps(JSON.stringify({
        "https://auth.x.ai::profile": {
          key: "access-token",
          oidc_issuer: "https://auth.x.ai",
          expires_at: "2026-08-15T00:00:00Z",
        },
      })),
      fetch: fetchMock,
      now: () => Date.parse("2026-08-14T00:00:00Z"),
    });
    expect(result).toMatchObject({ status: "ok", windows: [{ usedPercent: 11 }] });
    expect(result.status === "ok" ? result.plan : "missing").toBeUndefined();
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

describe("Grok Responses tool loading", () => {
  const tools = [
    { type: "function" as const, name: "ToolSearch", parameters: {}, defer_loading: true },
    { type: "function" as const, name: "deferred", parameters: {}, defer_loading: true },
    { type: "function" as const, name: "eager", parameters: {}, defer_loading: false },
  ];

  it("filters deferred tools only when ToolSearch is declared", () => {
    const adapter = new XaiResponsesAdapter();
    expect(adapter.wireTools(xaiRequest({ tools })).map((tool) => tool.name)).toEqual([
      "ToolSearch",
      "eager",
    ]);
    expect(adapter.wireTools(xaiRequest({
      tools: [{ ...tools[1] }, { ...tools[2] }],
    }))).toEqual([
      expect.objectContaining({ name: "deferred" }),
      expect.objectContaining({ name: "eager" }),
    ]);
  });

  it("restores only referenced deferred tools on continuation", () => {
    const adapter = new XaiResponsesAdapter();
    expect(adapter.wireTools(xaiRequest({
      tools: [...tools, { type: "function" as const, name: "unreferenced", parameters: {}, defer_loading: true }],
      input: [{ type: "function_call_output", call_id: "c", output: "ok", tool_references: ["deferred"] }],
    })).map((tool) => tool.name)).toEqual(["ToolSearch", "deferred", "eager"]);
  });

  it("does not treat near-match names as ToolSearch", () => {
    const adapter = new XaiResponsesAdapter();
    expect(adapter.wireTools(xaiRequest({
      tools: [{ ...tools[1], name: "ToolSearcher" }],
    }))).toEqual([expect.objectContaining({ name: "ToolSearcher" })]);
  });

  it("keeps an explicitly selected deferred tool", () => {
    const adapter = new XaiResponsesAdapter();
    expect(adapter.wireTools(xaiRequest({
      tools,
      tool_choice: { type: "function", name: "deferred" },
    })).map((tool) => tool.name)).toEqual(["ToolSearch", "deferred", "eager"]);
  });

  it("matches an unqualified selected leaf to a qualified declared tool", () => {
    const adapter = new XaiResponsesAdapter();
    expect(adapter.wireTools(xaiRequest({
      tools: [...tools.slice(0, 1), { ...tools[1], name: "mcp__deferred" }],
      tool_choice: { type: "function", name: "deferred" },
    })).map((tool) => tool.name)).toEqual(["ToolSearch", "mcp__deferred"]);
  });

  it("matches qualified selected and declared names by leaf", () => {
    const adapter = new XaiResponsesAdapter();
    expect(adapter.wireTools(xaiRequest({
      tools: [...tools.slice(0, 1), { ...tools[1], name: "mcp__deferred" }],
      tool_choice: { type: "function", name: "other__deferred" },
    })).map((tool) => tool.name)).toEqual(["ToolSearch", "mcp__deferred"]);
  });

  it("does not match a near-match leaf", () => {
    const adapter = new XaiResponsesAdapter();
    expect(adapter.wireTools(xaiRequest({
      tools: [...tools.slice(0, 1), { ...tools[1], name: "mcp__deferredExtra" }],
      tool_choice: { type: "function", name: "deferred" },
    })).map((tool) => tool.name)).toEqual(["ToolSearch"]);
  });

  it("omits tools from the payload when the request has no tools", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("data: [DONE]\\n\\n", { status: 200 }));
    await new XaiResponsesAdapter({ fetch: fetchMock }).stream(xaiRequest(), { apiKey: "k" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
  });

  it("uses the same canonical subset for wireTools and the serialized payload", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("data: [DONE]\\n\\n", { status: 200 }));
    const adapter = new XaiResponsesAdapter({ fetch: fetchMock });
    const request = xaiRequest({ tools, tool_choice: { type: "function", name: "deferred" } });
    await adapter.stream(request, { apiKey: "k" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { tools: Array<{ name: string }> };
    expect(body.tools.map((tool) => tool.name)).toEqual(adapter.wireTools(request)?.map((tool) => tool.name));
    expect(body.tools.every((tool) => !("defer_loading" in tool))).toBe(true);
  });
});

describe("Grok Responses adapter", () => {
  it("records the raw xAI event before canonical reasoning normalization", async () => {
    const wireLog = wireLogFixture("fleet-xai-wire-log-");
    try {
      const fetchMock = vi.fn<typeof fetch>(async () => xaiResponse(
        'event: response.reasoning_text.delta\ndata: {"item_id":"reasoning-xai","output_index":0,"delta":"checking"}\n\n',
      ));
      const response = await new XaiResponsesAdapter({ fetch: fetchMock }).stream(xaiRequest(), {
        apiKey: "xai-secret",
      });
      if (!response.ok) throw new Error("expected success");
      const events = await collectXaiEvents(response.events);

      expect(events).toEqual([{
        type: "response.reasoning_summary_text.delta",
        item_id: "reasoning-xai",
        output_index: 0,
        delta: "checking",
      }]);
      const raw = wireLog.read().filter((entry) => entry.event === "xai-responses.wire.event");
      expect(raw).toEqual([expect.objectContaining({
        payload: {
          event: "response.reasoning_text.delta",
          data: { item_id: "reasoning-xai", output_index: 0, delta: "checking" },
        },
      })]);
      expect(JSON.stringify(raw)).not.toContain("xai-secret");
    } finally {
      wireLog.cleanup();
    }
  });

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
