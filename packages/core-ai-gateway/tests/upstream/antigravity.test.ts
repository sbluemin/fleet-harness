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
});

describe("antigravity request wire", () => {

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
});

describe("antigravity adapter", () => {

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
});
