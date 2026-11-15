import { afterEach, describe, expect, it, vi } from "vitest";

import type { CanonicalResponseRequest } from "../../src/canonical/index.js";
import { createOpencodeGoAdapter } from "../../src/upstream/opencode-go/adapter.js";
import { OPENCODE_AUTH_PROVIDER_ID, OPENCODE_GO_MODELS_URL } from "../../src/upstream/opencode-go/coordinates.js";
import { validateOpencodeGoApiKey } from "../../src/upstream/opencode-go/probe.js";

// The two models this provider serves, each on the one wire the docs list for it. Endpoint,
// key, user agent, and session headers are covered at the router (tests/router/routes.test.ts).
const MODELS = [
  { id: "opencode--deepseek-v4.1-flash", model: "deepseek-v4.1-flash", wire: "chat-completions" },
  { id: "opencode--muse-spark-1.3-contributor", model: "muse-spark-1.3-contributor", wire: "responses" },
] as const;

function request(model: string, overrides: Partial<CanonicalResponseRequest> = {}): CanonicalResponseRequest {
  return {
    model,
    input: [{ type: "message", role: "user", content: "hi" }],
    stream: true,
    ...overrides,
  };
}

function done(): Response {
  return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenCode Go wires", () => {
  it.each(MODELS)("drops the tool patterns the $wire backend refuses and keeps the ones it reads", async (entry) => {
    const fetchMock = vi.fn<typeof fetch>(async () => done());
    await createOpencodeGoAdapter(entry, { fetch: fetchMock }).stream(request(entry.model, {
      tools: [{
        type: "function",
        name: "Artifact",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            // A backslash-digit escape: the backend refuses it, which fails the whole request.
            file_paths: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 1024, pattern: "^[^\\0]*$" },
            },
            asset_id: { type: "string", pattern: "^[0-9a-f]{32}$" },
          },
          required: ["file_paths", "asset_id"],
        },
      }],
      tool_choice: "auto",
    }), { apiKey: "k" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      tools: Array<{ parameters?: ToolParameters; function?: { parameters: ToolParameters } }>;
    };
    const properties = (body.tools[0]!.function?.parameters ?? body.tools[0]!.parameters)!.properties;
    expect(properties.file_paths!.items).not.toHaveProperty("pattern");
    expect(properties.file_paths!.items).toHaveProperty("maxLength", 1024);
    expect(properties.asset_id).toHaveProperty("pattern", "^[0-9a-f]{32}$");
  });
});

type ToolParameters = { properties: Record<string, Record<string, unknown>> };

describe("OpenCode Go key validation", () => {
  it("proves a key only by sending it, because the model listing is public", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => new Response("{}", {
      status: new Headers(init?.headers).get("authorization") === "Bearer good-key" ? 200 : 401,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateOpencodeGoApiKey({ providerId: OPENCODE_AUTH_PROVIDER_ID, apiKey: "good-key" }))
      .resolves.toEqual({ providerId: OPENCODE_AUTH_PROVIDER_ID, status: "success" });
    await expect(validateOpencodeGoApiKey({ providerId: OPENCODE_AUTH_PROVIDER_ID, apiKey: "expired-key" }))
      .resolves.toMatchObject({ status: "unauthorized" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([OPENCODE_GO_MODELS_URL, OPENCODE_GO_MODELS_URL]);

    // A keyless listing answers 200 and would prove nothing, so a blank key never leaves the process.
    fetchMock.mockClear();
    await expect(validateOpencodeGoApiKey({ providerId: OPENCODE_AUTH_PROVIDER_ID, apiKey: "  " }))
      .resolves.toMatchObject({ status: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
