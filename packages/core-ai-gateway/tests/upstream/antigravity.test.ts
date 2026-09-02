import { describe, expect, it, vi } from "vitest";

import {
  ANTIGRAVITY_LOAD_CODE_ASSIST_URL,
  ANTIGRAVITY_QUOTA_SUMMARY_URLS,
  ANTIGRAVITY_STREAM_URL,
  AntigravityGenerateContentAdapter,
  antigravityPlanLabel,
  antigravityUserAgent,
  buildAntigravityEnvelope,
  createAntigravitySignatureLedger,
  createToolNameCodec,
  createUpstreamGate,
  fetchAntigravityUsage,
  loadAntigravityCodeAssist,
  isAntigravitySignature,
  parseAntigravityKeychainValue,
  parseAntigravityQuotaSummary,
  resolveAntigravityAuth,
  resolveAntigravityModelSelection,
  sanitizeGeminiSchema,
  translateAntigravityStream,
} from "../../src/index.js";
import type {
  AntigravityFrame,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CredentialResolverDeps,
} from "../../src/index.js";

const ACCESS = "ya29.a0-access-token";
const REFRESH = "1//0-refresh-token";

function keychainValue(token: Record<string, unknown>): string {
  const payload = JSON.stringify({ token, auth_method: "consumer" });
  return `go-keyring-base64:${Buffer.from(payload, "utf8").toString("base64")}`;
}

function credentialDeps(overrides: Partial<CredentialResolverDeps> = {}): CredentialResolverDeps {
  return {
    platform: "darwin",
    homedir: () => "/home/tester",
    env: {},
    readBounded: async () => null,
    execFile: async () => keychainValue({
      access_token: ACCESS,
      token_type: "Bearer",
      refresh_token: REFRESH,
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    ...overrides,
  };
}

function request(overrides: Partial<CanonicalResponseRequest> = {}): CanonicalResponseRequest {
  return {
    model: "gemini-3.7-flash-tiered",
    input: [{ type: "message", role: "user", content: "hi" }],
    stream: true,
    ...overrides,
  };
}

function envelopeFor(req: CanonicalResponseRequest) {
  return buildAntigravityEnvelope(req, {
    project: "model-aria-test",
    requestId: "agent-test",
    codec: createToolNameCodec(),
    ledger: createAntigravitySignatureLedger(),
  });
}

async function* frames(...values: AntigravityFrame[]): AsyncGenerator<AntigravityFrame> {
  for (const value of values) yield value;
}

function responseFrame(parts: unknown[], extra: Record<string, unknown> = {}): AntigravityFrame {
  return {
    response: {
      candidates: [{ content: { role: "model", parts } }],
      modelVersion: "gemini-3.7-flash",
      responseId: "resp-1",
      ...extra,
    },
  };
}

async function collect(events: AsyncIterable<CanonicalResponseEvent>): Promise<CanonicalResponseEvent[]> {
  const collected: CanonicalResponseEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

// A real blob: 436 base64 characters were observed on the live wire.
const SIGNATURE = "EsMCCsAC".padEnd(120, "AbC+/9=");

describe("antigravity credentials", () => {
  it("decodes the go-keyring envelope the CLI writes", () => {
    const parsed = parseAntigravityKeychainValue(keychainValue({
      access_token: ACCESS,
      refresh_token: REFRESH,
      expiry: "2026-08-22T15:14:03.075366+09:00",
    }));
    expect(parsed).toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: Date.parse("2026-08-22T15:14:03.075366+09:00"),
    });
  });

  it("accepts the looser shapes other Antigravity builds have written", () => {
    expect(parseAntigravityKeychainValue(JSON.stringify({ access_token: ACCESS }))?.accessToken).toBe(ACCESS);
    expect(parseAntigravityKeychainValue(`Bearer ${ACCESS}`)?.accessToken).toBe(ACCESS);
    expect(parseAntigravityKeychainValue(JSON.stringify({ oauth: { accessToken: ACCESS } }))?.accessToken).toBe(ACCESS);
    expect(parseAntigravityKeychainValue("   ")).toBeNull();
    expect(parseAntigravityKeychainValue("{not json")).toBeNull();
  });

  it("reports the credential the CLI owns as keychain-sourced", async () => {
    const result = await resolveAntigravityAuth(credentialDeps());
    expect(result).toMatchObject({ status: "ok", credentials: { accessToken: ACCESS, method: "keychain" } });
  });

  it("asks the vendor CLI to renew a lapsing token, then re-reads what it wrote", async () => {
    // Fleet holds no OAuth client: it runs `agy` and reads the store again.
    let renewed = false;
    const execFile = vi.fn(async (_file: string, _args: readonly string[]) => keychainValue({
      access_token: renewed ? "fresh" : "stale",
      refresh_token: REFRESH,
      expiry: new Date(Date.now() + (renewed ? 3_600_000 : 10_000)).toISOString(),
    }));
    const refreshVendorCredential = vi.fn(async () => {
      renewed = true;
    });
    const result = await resolveAntigravityAuth(
      credentialDeps({ execFile }),
      { refreshVendorCredential },
    );
    expect(result).toMatchObject({ status: "ok", credentials: { accessToken: "fresh" } });
    expect(refreshVendorCredential).toHaveBeenCalledTimes(1);
    // The keychain item is read either side of the renewal, and never written:
    // `agy` owns that value.
    expect(execFile.mock.calls.map((call) => call[0])).toEqual(["security", "security"]);
  });

  it("runs one renewal for concurrent callers rather than racing the credential store", async () => {
    const execFile = vi.fn(async (_file: string, _args: readonly string[]) => keychainValue({
      access_token: ACCESS,
      refresh_token: REFRESH,
      expiry: new Date(Date.now() + 10_000).toISOString(),
    }));
    let running = 0;
    let overlapped = false;
    const refreshVendorCredential = vi.fn(async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });
    const deps = credentialDeps({ execFile });
    await Promise.all([
      resolveAntigravityAuth(deps, { refreshVendorCredential }),
      resolveAntigravityAuth(deps, { refreshVendorCredential }),
      resolveAntigravityAuth(deps, { refreshVendorCredential }),
    ]);
    expect(overlapped).toBe(false);
    expect(refreshVendorCredential).toHaveBeenCalledTimes(1);
  });

  it("serves a healthy token without spawning the CLI at all", async () => {
    const execFile = vi.fn(async (_file: string, _args: readonly string[]) => keychainValue({
      access_token: ACCESS,
      refresh_token: REFRESH,
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
    }));
    const result = await resolveAntigravityAuth(credentialDeps({ execFile }));
    expect(result).toMatchObject({ status: "ok", credentials: { accessToken: ACCESS } });
    expect(execFile.mock.calls.map((call) => call[0])).toEqual(["security"]);
  });

  it("reports an unrenewable expired session as expired, and a missing item as signed out", async () => {
    // The CLI runs but cannot revive a dead session, so the store stays lapsed.
    const expired = await resolveAntigravityAuth(
      credentialDeps({
        execFile: async () => keychainValue({
          access_token: "stale",
          refresh_token: REFRESH,
          expiry: new Date(Date.now() - 1_000).toISOString(),
        }),
      }),
      { refreshVendorCredential: async () => undefined },
    );
    expect(expired).toEqual({ status: "expired" });

    const missing = await resolveAntigravityAuth(credentialDeps({
      execFile: async () => { throw new Error("The specified item could not be found in the keychain."); },
    }));
    expect(missing).toEqual({ status: "signed_out" });
  });

  it("never claims a platform the process is not running on", () => {
    expect(antigravityUserAgent("darwin", "arm64"))
      .toBe("antigravity/ide/2.5.5 (os_type=darwin; arch=arm64; aidev_client; auth_method=oauth)");
    expect(antigravityUserAgent("win32", "x64")).toContain("os_type=windows; arch=amd64");
  });

  it("reads the Windows Credential Manager item go-keyring wrote", async () => {
    // The Windows store takes arbitrary bytes, so `agy` leaves plain JSON there
    // with none of the `go-keyring-base64:` wrapping the other platforms need;
    // the base64 here is this reader's own transport off PowerShell's stdout.
    const payload = JSON.stringify({
      token: {
        access_token: ACCESS,
        refresh_token: REFRESH,
        expiry: new Date(Date.now() + 3_600_000).toISOString(),
      },
      auth_method: "consumer",
    });
    const execFile = vi.fn(
      async (_file: string, _args: readonly string[]) =>
        Buffer.from(payload, "utf8").toString("base64"),
    );
    const result = await resolveAntigravityAuth(credentialDeps({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execFile,
    }));
    expect(result).toMatchObject({ status: "ok", credentials: { accessToken: ACCESS } });

    const [file, args] = execFile.mock.calls[0]!;
    // Absolute path: PATH order must not choose which binary sees the secret.
    expect(file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(args[3] ?? "", "base64").toString("utf16le");
    expect(script).toContain("CredReadW");
    expect(script).toContain("gemini:antigravity");
  });

  it("treats an empty Credential Manager read as signed out", async () => {
    const execFile = vi.fn(async (_file: string, _args: readonly string[]) => "");
    const result = await resolveAntigravityAuth(credentialDeps({ platform: "win32", execFile }));
    expect(result).toEqual({ status: "signed_out" });
    // No SystemRoot to resolve against, so the bare name is the only fallback left.
    expect(execFile.mock.calls[0]?.[0]).toBe("powershell.exe");
  });
});

describe("antigravity quota", () => {
  const summary = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-weekly", window: "weekly", resetTime: "2026-08-29T05:54:25Z", remainingFraction: 0.4 },
          { bucketId: "gemini-5h", window: "5h", resetTime: "2026-08-22T10:54:25Z", remainingFraction: 1 },
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-weekly", resetTime: "2026-08-29T05:54:25Z", remainingFraction: 0 },
          { bucketId: "3p-5h", resetTime: "2026-08-22T10:54:25Z", remainingFraction: 0 },
        ],
      },
    ],
  };

  it("maps remainingFraction onto used percent, shortest cadence first", () => {
    const windows = parseAntigravityQuotaSummary(summary);
    expect(windows).toEqual([
      {
        id: "session",
        label: "Gemini",
        usedPercent: 0,
        resetsAt: Date.parse("2026-08-22T10:54:25Z"),
        period: expect.objectContaining({ durationMs: 18_000_000, durationBasis: "catalog" }),
      },
      {
        id: "weekly",
        label: "Gemini",
        usedPercent: 60,
        resetsAt: Date.parse("2026-08-29T05:54:25Z"),
        period: expect.objectContaining({ durationMs: 604_800_000, durationBasis: "catalog" }),
      },
    ]);
  });

  it("omits the pool no exposed model spends, so an exhausted 3p never reads as this provider's headroom", () => {
    const windows = parseAntigravityQuotaSummary(summary) ?? [];
    expect(windows.every((window) => window.label === "Gemini")).toBe(true);
  });

  it("accepts the `response`-wrapped envelope and drops only a bucket missing its fraction", () => {
    const wrapped = parseAntigravityQuotaSummary({
      response: { groups: [{ buckets: [
        { bucketId: "gemini-5h", remainingFraction: 0.25, resetTime: "2026-08-22T10:54:25Z" },
        { bucketId: "gemini-weekly", resetTime: "2026-08-29T05:54:25Z" },
        { bucketId: "unknown-bucket", remainingFraction: 0.5 },
      ] }] },
    });
    expect(wrapped).toEqual([expect.objectContaining({ id: "session", usedPercent: 75 })]);
    expect(parseAntigravityQuotaSummary({ nothing: true })).toBeNull();
  });

  it("reads the tier the account is on, never the upgrade Google is offering", () => {
    // Measured 2026-08-22: a free account reports currentTier free-tier beside a
    // paidTier of g1-pro-tier, which is the upgrade offer.
    expect(antigravityPlanLabel("free-tier")).toBe("Free");
    expect(antigravityPlanLabel("g1-pro-tier")).toBe("Pro");
    expect(antigravityPlanLabel("g1-ultra-tier")).toBe("Ultra");
    expect(antigravityPlanLabel("some-new-tier")).toBe("Some New");
    expect(antigravityPlanLabel(undefined)).toBeUndefined();
  });

  it("probes the daily host first and reports the current tier as the plan", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url === ANTIGRAVITY_LOAD_CODE_ASSIST_URL) {
        return new Response(JSON.stringify({
          currentTier: { id: "free-tier", name: "Antigravity" },
          paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
          cloudaicompanionProject: "model-aria-test",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(summary), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await fetchAntigravityUsage({
      credentials: credentialDeps(),
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => 1_000,
    });
    expect(result).toMatchObject({ status: "ok", method: "keychain", plan: "Free", fetchedAt: 1_000 });
    expect(seen[0]).toBe(ANTIGRAVITY_QUOTA_SUMMARY_URLS[0]);
  });

  it("passes a signed-out credential straight through without a network call", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchAntigravityUsage({
      credentials: credentialDeps({ execFile: async () => "" }),
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "signed_out" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("antigravity model selection", () => {
  it("spells Flash's rung as a request field and Pro's as a wire id", () => {
    expect(resolveAntigravityModelSelection("antigravity--gemini-3.7-flash", "medium"))
      .toEqual({ wireModelId: "gemini-3.7-flash-tiered", thinkingLevel: "medium" });
    expect(resolveAntigravityModelSelection("antigravity--gemini-3.1-pro", "low"))
      .toEqual({ wireModelId: "gemini-3.1-pro-low" });
  });

  it("never routes Pro's high rung to the id upstream refuses", () => {
    // `gemini-3.1-pro-high` answers INVALID_ARGUMENT and the upstream's own
    // deprecatedModelIds names `gemini-pro-agent` as its replacement.
    const high = resolveAntigravityModelSelection("antigravity--gemini-3.1-pro", "high");
    expect(high).toEqual({ wireModelId: "gemini-pro-agent" });
    expect(high.wireModelId).not.toBe("gemini-3.1-pro-high");
  });

  it("clamps a rung above the wire's vocabulary rather than sending one it refuses", () => {
    // thinkingLevel accepts low|medium|high only; minimal and max are both 400s.
    expect(resolveAntigravityModelSelection("antigravity--gemini-3.7-flash", "max"))
      .toEqual({ wireModelId: "gemini-3.7-flash-tiered", thinkingLevel: "high" });
    // A rung BELOW the ladder is refused rather than raised: the gateway never
    // silently spends more effort than the caller asked for, and the router turns
    // this into a 400 instead of a turn the user did not order.
    expect(() => resolveAntigravityModelSelection("antigravity--gemini-3.7-flash", "minimal"))
      .toThrow(/no supported reasoning effort at or below/);
    // Pro advertises low and high only, so medium clamps down to low.
    expect(resolveAntigravityModelSelection("antigravity--gemini-3.1-pro", "medium"))
      .toEqual({ wireModelId: "gemini-3.1-pro-low" });
  });

  it("leaves a model it does not own untouched", () => {
    expect(resolveAntigravityModelSelection("cursor--grok-4.6", "high"))
      .toEqual({ wireModelId: "cursor--grok-4.6" });
  });
});

describe("antigravity request wire", () => {
  it("wraps the Gemini body in the client envelope", () => {
    const envelope = envelopeFor(request({ instructions: "Be terse." }));
    expect(envelope).toMatchObject({
      model: "gemini-3.7-flash-tiered",
      userAgent: "antigravity",
      requestType: "agent",
      project: "model-aria-test",
    });
    expect(envelope.request.systemInstruction).toEqual({ role: "user", parts: [{ text: "Be terse." }] });
    expect(envelope.request.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(envelope.request.sessionId).toMatch(/^-\d+$/);
  });

  it("keeps one session id for one conversation and separates two", () => {
    const first = envelopeFor(request()).request.sessionId;
    const again = envelopeFor(request({
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "message", role: "assistant", content: "hello" },
      ],
    })).request.sessionId;
    const other = envelopeFor(request({
      input: [{ type: "message", role: "user", content: "different" }],
    })).request.sessionId;
    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  it("collapses a JSON Schema union type into Gemini's scalar type plus nullable", () => {
    // Gemini의 와이어는 OpenAPI라 `type`이 스칼라 하나여야 하고, 리스트를 받으면
    // 요청 전체를 400으로 거절한다("Proto field is not repeating, cannot start list").
    // 선택 인자를 `["string", "null"]`로 적는 클라이언트는 그 한 줄 때문에 도구를
    // 통째로 잃는다 — Grok Build 1.0.5의 내장 도구 26개가 그렇게 적는다.
    expect(sanitizeGeminiSchema({
      type: "object",
      properties: {
        timeout: { type: ["integer", "null"], description: "Seconds" },
        path: { type: ["string", "null"] },
        domains: { type: ["array", "null"], items: { type: "string" } },
        plain: { type: "string" },
      },
    })).toEqual({
      type: "object",
      properties: {
        timeout: { type: "integer", nullable: true, description: "Seconds" },
        path: { type: "string", nullable: true },
        domains: { type: "array", nullable: true, items: { type: "string" } },
        plain: { type: "string" },
      },
    });
  });

  it("keeps a union of two real types usable instead of refusing it", () => {
    // 두 실제 타입의 유니온은 이 와이어로 표현할 수 없다. 좁히는 쪽이 거절보다 낫다 —
    // 모델은 여전히 쓸 수 있는 인자를 받는다.
    expect(sanitizeGeminiSchema({ type: ["string", "number"] })).toEqual({ type: "string" });
    // null만 있는 유니온에는 남길 타입이 없다. 루트가 아닌 프로퍼티이므로 untyped로 둔다.
    expect(sanitizeGeminiSchema({ type: ["null"] })).toEqual({ nullable: true });
  });

  it("strips JSON Schema keys the wire refuses while keeping the shape", () => {
    expect(sanitizeGeminiSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "A path", format: "uri" },
        limit: { type: "number", format: "int32", default: 10 },
        items: { type: "array", items: { type: "string", additionalProperties: true } },
      },
    })).toEqual({
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "A path" },
        limit: { type: "number", format: "int32" },
        items: { type: "array", items: { type: "string" } },
      },
    });
  });

  it("lowers tuple arrays into the homogeneous item schema Gemini requires", () => {
    // ToolSearch's `where` is a tuple array. Dropping JSON Schema 2020-12's
    // `prefixItems` leaves its inner array with an empty `items`, so Gemini rejects the turn.
    const schema = sanitizeGeminiSchema({
      type: "object",
      properties: {
        query: {
          type: "object",
          properties: {
            where: {
              type: "array",
              items: {
                type: "array",
                prefixItems: [
                  { type: "string" },
                  { type: "string", enum: ["eq", "ne"] },
                  {},
                ],
                items: {},
              },
            },
          },
        },
      },
    });
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        query: {
          properties: {
            where: {
              type: "array",
              items: {
                type: "array",
                items: { anyOf: expect.any(Array) },
              },
            },
          },
        },
      },
    });
    const inner = ((schema.properties as Record<string, unknown>).query as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    const alternatives = ((inner.where.items as Record<string, unknown>).items as Record<string, unknown>)
      .anyOf as Record<string, unknown>[];
    expect(alternatives).toContainEqual({ type: "string", enum: ["eq", "ne"] });
    expect(alternatives).toContainEqual({ type: "string", nullable: true });
    expect(alternatives).toContainEqual(expect.objectContaining({ type: "array" }));

    // A concrete 2020-12 tail is part of the homogeneous approximation too; dropping either
    // side would incorrectly erase valid positional or additional values.
    expect(sanitizeGeminiSchema({
      type: "array",
      prefixItems: [{ type: "integer" }],
      items: { type: "string" },
    })).toEqual({
      type: "array",
      items: { anyOf: [{ type: "integer" }, { type: "string" }] },
    });
    expect(sanitizeGeminiSchema({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: false,
    })).toEqual({
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "integer" }] },
      maxItems: 2,
    });
    expect(sanitizeGeminiSchema({
      type: "array",
      items: [{ type: "string" }, { type: "integer" }],
      additionalItems: false,
      maxItems: 1,
    })).toEqual({
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "integer" }] },
      maxItems: 1,
    });
    expect(sanitizeGeminiSchema({
      type: "array",
      prefixItems: [{
        description: "value",
        anyOf: [
          { type: "string" },
          {},
          { description: "referenced", $ref: "#/$defs/value" },
        ],
      }],
      items: false,
    })).toMatchObject({
      type: "array",
      items: {
        anyOf: expect.arrayContaining([
          { type: "string" },
          { type: "string", nullable: true },
          expect.objectContaining({ type: "array" }),
        ]),
      },
      maxItems: 1,
    });
    expect(sanitizeGeminiSchema({ type: "array" })).toMatchObject({
      type: "array",
      items: {
        anyOf: expect.arrayContaining([
          { type: "string", nullable: true },
          expect.objectContaining({ type: "array" }),
        ]),
      },
    });
  });

  it("rewrites a tool name the wire cannot carry and restores it on the way back", () => {
    const codec = createToolNameCodec();
    const long = `mcp__${"server".repeat(12)}__create_issue`;
    const wire = codec.toWire(long);
    expect(wire.length).toBeLessThanOrEqual(64);
    expect(wire).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/);
    expect(codec.fromWire(wire)).toBe(long);
    // A name the wire already accepts is passed through untouched.
    expect(codec.toWire("Read")).toBe("Read");
    expect(codec.fromWire("Read")).toBe("Read");
  });

  it("replays the reasoning blob the client carried back onto its own call", () => {
    const envelope = envelopeFor(request({
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call", call_id: "call_1", name: "get_time", arguments: '{"zone":"UTC"}', reasoning_encrypted: SIGNATURE },
        { type: "function_call_output", call_id: "call_1", output: "12:00" },
      ],
    }));
    const [, model, result] = envelope.request.contents;
    expect(model?.parts[0]).toEqual({
      thoughtSignature: SIGNATURE,
      functionCall: { name: "get_time", args: { zone: "UTC" }, id: "call_1" },
    });
    // `functionResponse.name` must name the function; the canonical result item
    // carries only the call id, so it is repaired from the call.
    expect(result?.parts[0]?.functionResponse).toEqual({
      name: "get_time",
      response: { result: "12:00" },
      id: "call_1",
    });
  });

  it("recovers a blob from the ledger when the client dropped the thinking block", () => {
    const ledger = createAntigravitySignatureLedger();
    ledger.record("call_1", SIGNATURE);
    const envelope = buildAntigravityEnvelope(request({
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call", call_id: "call_1", name: "get_time", arguments: "{}" },
      ],
    }), { requestId: "agent-test", codec: createToolNameCodec(), ledger });
    expect(envelope.request.contents[1]?.parts[0]?.thoughtSignature).toBe(SIGNATURE);
  });

  it("refuses a foreign provider's reasoning id so the wire fails on the real cause", () => {
    expect(isAntigravitySignature(SIGNATURE)).toBe(true);
    for (const foreign of ["rs_68a1b2c3d4", "toolu_01ABCDEFGHIJKL", "fc_abcdef123456", "short", 42, undefined]) {
      expect(isAntigravitySignature(foreign)).toBe(false);
    }
    const envelope = envelopeFor(request({
      input: [{ type: "function_call", call_id: "c", name: "t", arguments: "{}", reasoning_encrypted: "rs_68a1b2c3d4ef" }],
    }));
    expect(envelope.request.contents[0]?.parts[0]?.thoughtSignature).toBeUndefined();
  });

  it("translates the tool catalog and tool choice", () => {
    const envelope = envelopeFor(request({
      tools: [{ type: "function", name: "Read", description: "Read a file", parameters: { type: "object", properties: {} } }],
      tool_choice: { type: "function", name: "Read" },
    }));
    expect(envelope.request.tools).toEqual([{ functionDeclarations: [
      { name: "Read", description: "Read a file", parameters: { type: "object", properties: {} } },
    ] }]);
    expect(envelope.request.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["Read"] },
    });
    // `auto` is the wire's own default; stating it would add a config no turn needs.
    expect(envelopeFor(request({ tool_choice: "auto" })).request.toolConfig).toBeUndefined();
    expect(envelopeFor(request({ tool_choice: "none" })).request.toolConfig)
      .toEqual({ functionCallingConfig: { mode: "NONE" } });
  });

  it("gives a free-form object the empty property map this wire needs", () => {
    // 클라이언트는 스키마를 못 적는 페이로드를 `{ type: "object" }`로 적는다 —
    // Grok Build의 `use_tool.tool_input`이 MCP 도구마다 달라지는 그 자리다. Gemini는
    // 그것을 "아무 객체"로 읽지 않고 요청을 통째로 거절하며, 그 거절은 필드 이름이 없는
    // "Request contains an invalid argument"라 무엇이 문제인지 말하지 않는다.
    expect(sanitizeGeminiSchema({ type: "object", description: "Free-form" }))
      .toEqual({ type: "object", description: "Free-form", properties: {} });
  });

  it("clamps an output request above the ceiling instead of letting the turn die", () => {
    // 창 크기와 출력 상한은 다른 수다: 이 모델의 카탈로그 창은 1M인데 출력은 64k에서 끊긴다.
    // 실측(2026-08-23): 65,536은 통과, 131,072는 400. 더 달라고 적은 클라이언트가 틀린 것이
    // 아니다 — Grok Build는 자기 설정에서 읽은 128,000을 매 턴 적어 보낸다.
    expect(envelopeFor(request({ max_output_tokens: 128_000 })).request.generationConfig.maxOutputTokens)
      .toBe(65_536);
    expect(envelopeFor(request({ max_output_tokens: 8_192 })).request.generationConfig.maxOutputTokens)
      .toBe(8_192);
  });

  it("sends no thinkingConfig for a model whose catalog entry declares no ladder", () => {
    // gpt-oss rejects thinkingConfig outright and Claude ignores it, so the gate
    // is the catalog ladder rather than the provider.
    expect(envelopeFor(request({ model: "gpt-oss-120b-medium" })).request.generationConfig)
      .toEqual({});
  });

  it("carries a base64 image inline and drops a URL the wire cannot fetch", () => {
    const envelope = envelopeFor(request({
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_image", image_url: "https://example.com/a.png" },
        ],
      }],
    }));
    expect(envelope.request.contents[0]?.parts).toEqual([
      { text: "look" },
      { inline_data: { mime_type: "image/png", data: "AAAA" } },
    ]);
  });
});

describe("antigravity response stream", () => {
  const options = {
    codec: createToolNameCodec(),
    ledger: createAntigravitySignatureLedger(),
    model: "gemini-3.7-flash-tiered",
    callIdPrefix: "agent-fixed",
  };

  it("emits the reasoning item before the call it belongs to", async () => {
    const events = await collect(translateAntigravityStream(
      frames(
        responseFrame([{ thoughtSignature: SIGNATURE, functionCall: { name: "get_time", args: { zone: "UTC" }, id: "call_9" } }]),
        responseFrame([{ text: "" }], { usageMetadata: { promptTokenCount: 65, candidatesTokenCount: 16, thoughtsTokenCount: 45, totalTokenCount: 126 } }),
      ),
      { ...options, ledger: createAntigravitySignatureLedger() },
    ));
    const types = events.map((event) => event.type);
    const reasoningAt = events.findIndex(
      (event) => event.type === "response.output_item.done" && event.item.type === "reasoning",
    );
    const callAt = types.indexOf("response.output_item.added");
    expect(reasoningAt).toBeGreaterThanOrEqual(0);
    // Ordering is the contract: the encoder turns the reasoning item into a
    // thinking block, and the request translator pairs a thinking block with the
    // tool call that FOLLOWS it.
    expect(reasoningAt).toBeLessThan(callAt);
    const reasoning = events[reasoningAt];
    expect(reasoning).toMatchObject({ item: { type: "reasoning", encrypted_content: SIGNATURE } });
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        model: "gemini-3.7-flash",
        // Reasoning tokens are billed: candidatesTokenCount excludes them.
        usage: { input_tokens: 65, output_tokens: 61, reasoning_output_tokens: 45, total_tokens: 126 },
      },
    });
  });

  it("gives a parallel batch's second call no blob, matching what upstream issued", async () => {
    const events = await collect(translateAntigravityStream(
      frames(
        responseFrame([{ thoughtSignature: SIGNATURE, functionCall: { name: "a", args: {}, id: "call_1" } }]),
        responseFrame([{ functionCall: { name: "b", args: {}, id: "call_2" } }]),
      ),
      { ...options, ledger: createAntigravitySignatureLedger() },
    ));
    const reasoning = events.filter(
      (event) => event.type === "response.output_item.done" && event.item.type === "reasoning",
    );
    expect(reasoning).toHaveLength(1);
    const calls = events.filter(
      (event) => event.type === "response.output_item.added" && event.item.type === "function_call",
    );
    expect(calls).toHaveLength(2);
  });

  it("records issued blobs so a later turn can recover one the client dropped", async () => {
    const ledger = createAntigravitySignatureLedger();
    await collect(translateAntigravityStream(
      frames(responseFrame([{ thoughtSignature: SIGNATURE, functionCall: { name: "a", args: {}, id: "call_7" } }])),
      { ...options, ledger },
    ));
    expect(ledger.recall("call_7")).toBe(SIGNATURE);
    expect(ledger.recall("call_missing")).toBeUndefined();
  });

  it("splits visible text from hidden reasoning and ignores empty parts", async () => {
    const events = await collect(translateAntigravityStream(
      frames(
        responseFrame([{ text: "We ", thought: true }]),
        responseFrame([{ text: "compute.", thought: true }]),
        responseFrame([{ text: "" }]),
        responseFrame([{ text: "391" }], { candidates: undefined }),
        responseFrame([{ text: "391" }]),
      ),
      { ...options, ledger: createAntigravitySignatureLedger() },
    ));
    expect(events.filter((event) => event.type === "response.reasoning_summary_text.delta")
      .map((event) => event.delta)).toEqual(["We ", "compute."]);
    expect(events.filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta)).toEqual(["391"]);
  });

  it("reports an implicit prompt-cache hit, and reports nothing when the field is absent", async () => {
    // Measured 2026-08-22: a 30,534-token prompt repeated across requests came
    // back with cachedContentTokenCount 24,550 (80%). The cold request omits the
    // field entirely, which must stay absent rather than becoming a false zero.
    const warm = await collect(translateAntigravityStream(
      frames(responseFrame([{ text: "ok" }], {
        usageMetadata: {
          promptTokenCount: 30_534,
          candidatesTokenCount: 12,
          cachedContentTokenCount: 24_550,
          totalTokenCount: 30_546,
        },
      })),
      { ...options, ledger: createAntigravitySignatureLedger() },
    ));
    expect(warm.at(-1)).toMatchObject({
      type: "response.completed",
      response: { usage: { input_tokens: 30_534, cached_input_tokens: 24_550 } },
    });

    const cold = await collect(translateAntigravityStream(
      frames(responseFrame([{ text: "ok" }], {
        usageMetadata: { promptTokenCount: 30_534, candidatesTokenCount: 12, totalTokenCount: 30_546 },
      })),
      { ...options, ledger: createAntigravitySignatureLedger() },
    ));
    const done = cold.at(-1);
    expect(done?.type).toBe("response.completed");
    const usage = done?.type === "response.completed" ? done.response.usage : null;
    expect(usage).not.toBeNull();
    expect(usage).not.toHaveProperty("cached_input_tokens");
  });

  it("keeps a fabricated call id unique across turns so replayed results stay attributed", async () => {
    // `functionCall.id` is optional on this wire. When the upstream omits it, a
    // per-stream counter alone hands turn 2 the same id turn 1 used, and the
    // replayed history then labels the earlier call's result with the later
    // call's name.
    const idsFor = async (name: string, callIdPrefix: string): Promise<string[]> => {
      const events = await collect(translateAntigravityStream(
        frames(responseFrame([{ functionCall: { name, args: {} } }])),
        { ...options, ledger: createAntigravitySignatureLedger(), callIdPrefix },
      ));
      return events.flatMap((event) =>
        event.type === "response.output_item.added" && event.item.type === "function_call"
          ? [event.item.call_id]
          : []);
    };
    const [first] = await idsFor("read_file", "agent-turn-1");
    const [second] = await idsFor("write_file", "agent-turn-2");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);

    // The replayed history keeps each result on its own function.
    const envelope = buildAntigravityEnvelope(request({
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call", call_id: first!, name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: first!, output: "contents" },
        { type: "function_call", call_id: second!, name: "write_file", arguments: "{}" },
        { type: "function_call_output", call_id: second!, output: "written" },
      ],
    }), { requestId: "agent-test", codec: createToolNameCodec(), ledger: createAntigravitySignatureLedger() });
    const responses = envelope.request.contents
      .flatMap((content) => content.parts)
      .flatMap((part) => (part.functionResponse ? [part.functionResponse] : []));
    expect(responses.map((entry) => [entry.name, entry.response.result])).toEqual([
      ["read_file", "contents"],
      ["write_file", "written"],
    ]);
  });

  it("classifies the upstream error envelope rather than reporting a bare failure", async () => {
    const events = await collect(translateAntigravityStream(
      frames(
        responseFrame([{ text: "partial" }]),
        { error: { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } } },
      ),
      { ...options, ledger: createAntigravitySignatureLedger() },
    ));
    expect(events.at(-1)).toMatchObject({
      type: "response.failed",
      response: { error: { type: "rate_limit_error", message: "Quota exceeded" } },
    });
  });
});

describe("antigravity adapter", () => {
  it("posts the SSE envelope with the CLI's own credential", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }], modelVersion: "gemini-3.7-flash", responseId: "r" } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const adapter = new AntigravityGenerateContentAdapter({
      fetch: fetchImpl as never,
      project: "model-aria-test",
    });
    const result = await adapter.stream(request(), { apiKey: ACCESS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await collect(result.events);
    expect(calls[0]?.url).toBe(ANTIGRAVITY_STREAM_URL);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers["User-Agent"]).toContain("antigravity/ide/");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      userAgent: "antigravity",
      requestType: "agent",
      project: "model-aria-test",
    });
  });

  it("hands a rejected turn back as a failed response the gateway can translate", async () => {
    const body = JSON.stringify({ error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } });
    const adapter = new AntigravityGenerateContentAdapter({
      fetch: (async () => new Response(body, { status: 400 })) as never,
      project: "p",
    });
    const result = await adapter.stream(request(), { apiKey: ACCESS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(new TextDecoder().decode(result.body)).toBe(body);
  });

  it("renews the credential once when the upstream refuses it before the local expiry", async () => {
    // A session revoked server-side looks healthy to the local clock, so without
    // this every turn fails until the recorded expiry finally passes.
    const sent: string[] = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string>).Authorization);
      sent.push(auth);
      if (auth === `Bearer ${ACCESS}`) return new Response("{}", { status: 401 });
      return new Response(
        `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }], modelVersion: "gemini-3.7-flash", responseId: "r" } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const renewCredential = vi.fn(async () => "renewed-token");
    const adapter = new AntigravityGenerateContentAdapter({
      fetch: fetchImpl as never,
      project: "p",
      renewCredential,
    });
    const result = await adapter.stream(request(), { apiKey: ACCESS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await collect(result.events);
    expect(renewCredential).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([`Bearer ${ACCESS}`, "Bearer renewed-token"]);
  });

  it("does not spend a second turn when the renewal returns the same token", async () => {
    // A rejection that survives a fresh credential is about this request.
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 403 }));
    const renewCredential = vi.fn(async () => ACCESS);
    const adapter = new AntigravityGenerateContentAdapter({
      fetch: fetchImpl as never,
      project: "p",
      renewCredential,
    });
    const result = await adapter.stream(request(), { apiKey: ACCESS });
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(renewCredential).toHaveBeenCalledTimes(1);
  });

  it("leaves a non-auth failure alone rather than renewing a working credential", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
    const renewCredential = vi.fn(async () => "renewed-token");
    const adapter = new AntigravityGenerateContentAdapter({
      fetch: fetchImpl as never,
      project: "p",
      renewCredential,
    });
    const result = await adapter.stream(request(), { apiKey: ACCESS });
    expect(result.ok).toBe(false);
    expect(renewCredential).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("frees the origin permit it abandoned, so the retry is not queued behind itself", async () => {
    // The upstream gate holds a permit until the body ends. At a ceiling of one,
    // an abandoned rejection would make the retry wait behind its own permit —
    // so this passing at all is the proof the first body was released.
    const sseFrame = `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }], modelVersion: "gemini-3.7-flash", responseId: "r" } })}\n\n`;
    let attempt = 0;
    const gate = createUpstreamGate(
      (async (_input: unknown, init?: RequestInit) => {
        attempt += 1;
        if (String((init?.headers as Record<string, string>).Authorization) === `Bearer ${ACCESS}`) {
          // A real rejection carries a body, which is what holds the permit.
          return new Response(JSON.stringify({ error: { code: 401, message: "nope" } }), { status: 401 });
        }
        return new Response(sseFrame, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as never,
      { maxInFlight: 1, maxQueueWaitMs: 2_000 },
    );
    try {
      const adapter = new AntigravityGenerateContentAdapter({
        fetch: gate.fetch as never,
        project: "p",
        renewCredential: async () => "renewed-token",
      });
      const result = await adapter.stream(request(), { apiKey: ACCESS });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await collect(result.events);
      expect(attempt).toBe(2);
      // Both the discarded rejection and the consumed stream gave their permit back.
      expect(gate.stats().every((origin) => origin.inFlight === 0)).toBe(true);
    } finally {
      gate.dispose();
    }
  });

  it("frees the permit for a rejected onboarding read rather than leaking one per turn", async () => {
    const gate = createUpstreamGate(
      (async () => new Response(JSON.stringify({ error: "denied" }), { status: 403 })) as never,
      { maxInFlight: 1, maxQueueWaitMs: 2_000 },
    );
    try {
      // Onboarding failures are deliberately not cached, so a leak here would be
      // one permit per turn; three consecutive reads completing proves otherwise.
      for (let i = 0; i < 3; i += 1) {
        expect(await loadAntigravityCodeAssist(gate.fetch as never, ACCESS)).toEqual({});
      }
      expect(gate.stats().every((origin) => origin.inFlight === 0)).toBe(true);
    } finally {
      gate.dispose();
    }
  });

  it("keeps its ledger across turns so one round trip can recover its own blob", async () => {
    const adapter = new AntigravityGenerateContentAdapter({
      fetch: (async () => new Response(
        `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ thoughtSignature: SIGNATURE, functionCall: { name: "get_time", args: {}, id: "call_5" } }] } }], modelVersion: "gemini-3.7-flash", responseId: "r" } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as never,
      project: "p",
    });
    const first = await adapter.stream(request(), { apiKey: ACCESS });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await collect(first.events);

    const captured: string[] = [];
    const replayAdapter = adapter as unknown as { fetchImpl: unknown };
    void replayAdapter;
    const second = new AntigravityGenerateContentAdapter({
      fetch: (async (_input: unknown, init?: RequestInit) => {
        captured.push(String(init?.body));
        return new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as never,
      project: "p",
      // The ledger is what carries the blob; reuse it the way the router does.
      signatureLedger: (adapter as unknown as { ledger: ReturnType<typeof createAntigravitySignatureLedger> }).ledger,
    });
    const result = await second.stream(request({
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "function_call", call_id: "call_5", name: "get_time", arguments: "{}" },
      ],
    }), { apiKey: ACCESS });
    if (result.ok) await collect(result.events).catch(() => undefined);
    expect(captured[0]).toContain(SIGNATURE);
  });
});
