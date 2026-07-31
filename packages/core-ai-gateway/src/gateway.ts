import { encodeAnthropicSse, translateAnthropicRequest } from "./anthropic.js";
import type {
  AnthropicMessagesRequest,
  TranslateAnthropicRequestOptions
} from "./anthropic.js";
import type { AiGatewayAdapter } from "./canonical.js";
import { OpenAIResponsesAdapter } from "./openai-responses-adapter.js";

export interface AnthropicGatewayCallOptions extends TranslateAnthropicRequestOptions {
  apiKey: string;
  signal?: AbortSignal;
}

export interface AnthropicGatewayResponse {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array>;
}

export class AnthropicMessagesGateway {
  constructor(private readonly adapter: AiGatewayAdapter = new OpenAIResponsesAdapter()) {}

  async stream(
    request: AnthropicMessagesRequest,
    options: AnthropicGatewayCallOptions
  ): Promise<AnthropicGatewayResponse> {
    const canonical = translateAnthropicRequest(request, {
      ...(options.model ? { model: options.model } : {}),
      ...(options.catalog ? { catalog: options.catalog } : {}),
    });
    const upstream = await this.adapter.stream(canonical, {
      apiKey: options.apiKey,
      signal: options.signal
    });

    if (!upstream.ok) {
      const translated = translateUpstreamError(upstream.body);
      const headers = new Headers(upstream.headers);
      if (translated.changed) {
        headers.set("content-type", "application/json");
        headers.set("content-length", String(translated.body.byteLength));
      }
      return {
        status: upstream.status,
        headers,
        body: oneChunk(translated.body)
      };
    }

    return {
      status: upstream.status,
      headers: new Headers({
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8"
      }),
      body: encodeAnthropicSse(upstream.events)
    };
  }
}

async function* oneChunk(body: Uint8Array): AsyncGenerator<Uint8Array> {
  yield body;
}

function translateUpstreamError(body: Uint8Array): {
  body: Uint8Array;
  changed: boolean;
} {
  const text = new TextDecoder().decode(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body, changed: false };
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) {
    return { body, changed: false };
  }
  if (parsed.type === "error") {
    return { body, changed: false };
  }
  if (typeof parsed.error.message !== "string") {
    return { body, changed: false };
  }

  const error = {
    ...parsed.error,
    type:
      typeof parsed.error.type === "string"
        ? parsed.error.type
        : typeof parsed.error.code === "string"
          ? parsed.error.code
          : "api_error",
    message: parsed.error.message
  };
  return {
    body: new TextEncoder().encode(JSON.stringify({ type: "error", error })),
    changed: true
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
