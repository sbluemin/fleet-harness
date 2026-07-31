import type {
  AdapterCallOptions,
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalError,
  CanonicalOutputItem,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CanonicalResponseSnapshot,
  CanonicalUsage
} from "./canonical.js";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
/** ChatGPT 구독으로 Codex가 호출하는 백엔드. Platform API와 다른 표면이다. */
export const CHATGPT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_MAX_UPSTREAM_BODY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 30_000;

// ChatGPT 백엔드는 Platform API가 받는 샘플링 파라미터를 400으로 거절한다.
// 실측으로 확정한 거부 목록. metadata는 "Unsupported parameter", 샘플링 필드는 400으로 돌아온다.
// instructions/tools/tool_choice/parallel_tool_calls는 허용된다.
const CHATGPT_UNSUPPORTED_FIELDS = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "stop",
  "user",
  "metadata",
] as const;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface OpenAIResponsesAdapterOptions {
  fetch?: FetchLike;
  maxBodyBytes?: number;
  idleTimeoutMs?: number;
  /** 기본은 Platform API. 구독 경로는 CHATGPT_CODEX_RESPONSES_URL을 넘긴다. */
  url?: string;
  /** 구독 경로가 요구하는 chatgpt-account-id 등 추가 헤더. */
  headers?: Readonly<Record<string, string>>;
  /** ChatGPT 백엔드가 거절하는 샘플링 필드를 제거한다. */
  dropSamplingParams?: boolean;
}

export class UpstreamBodyLimitError extends Error {
  constructor(readonly maxBodyBytes: number) {
    super(`OpenAI response exceeded ${maxBodyBytes} bytes`);
    this.name = "UpstreamBodyLimitError";
  }
}

export class UpstreamIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(`OpenAI response was idle for ${idleTimeoutMs}ms`);
    this.name = "UpstreamIdleTimeoutError";
  }
}

export class UpstreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamProtocolError";
  }
}

export class OpenAIResponsesAdapter implements AiGatewayAdapter {
  private readonly fetchImpl: FetchLike;
  private readonly maxBodyBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly url: string;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly dropSamplingParams: boolean;

  constructor(options: OpenAIResponsesAdapterOptions = {}) {
    this.url = options.url ?? OPENAI_RESPONSES_URL;
    this.extraHeaders = options.headers ?? {};
    this.dropSamplingParams = options.dropSamplingParams ?? false;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxBodyBytes = positiveInteger(
      options.maxBodyBytes ?? DEFAULT_MAX_UPSTREAM_BODY_BYTES,
      "maxBodyBytes"
    );
    this.idleTimeoutMs = positiveInteger(
      options.idleTimeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
      "idleTimeoutMs"
    );
  }

  async stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions
  ): Promise<AdapterResponse> {
    if (options.apiKey.length === 0) {
      throw new TypeError("apiKey must not be empty");
    }

    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(options.signal, controller);
    let response: Response;

    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          ...this.extraHeaders
        },
        body: JSON.stringify(this.dropSamplingParams ? forChatGptBackend(request) : request),
        signal: controller.signal
      });
    } catch (error) {
      unlinkAbort();
      throw error;
    }

    if (!response.ok) {
      if (process.env.FLEET_AI_GATEWAY_DEBUG === "1") {
        const payload = this.dropSamplingParams ? forChatGptBackend(request) : request;
        const roles = payload.input.map((item) => ("role" in item ? item.role : item.type));
        console.error(`[ai-gateway] upstream ${response.status} input roles=${JSON.stringify(roles)} keys=${JSON.stringify(Object.keys(payload))}`);
      }
      try {
        const body = await readBoundedBody(response.body, {
          controller,
          idleTimeoutMs: this.idleTimeoutMs,
          maxBodyBytes: this.maxBodyBytes
        });
        return {
          ok: false,
          status: response.status,
          headers: response.headers,
          body
        };
      } finally {
        unlinkAbort();
      }
    }

    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      events: parseOpenAIEventStream(response.body, {
        controller,
        idleTimeoutMs: this.idleTimeoutMs,
        maxBodyBytes: this.maxBodyBytes,
        onClose: unlinkAbort
      })
    };
  }
}

function forChatGptBackend(request: CanonicalResponseRequest): CanonicalResponseRequest {
  const copy: Record<string, unknown> = { ...request };
  for (const field of CHATGPT_UNSUPPORTED_FIELDS) {
    delete copy[field];
  }
  // 백엔드가 명시적으로 요구한다: 생략하면 400 "Store must be set to false".
  copy.store = false;
  return copy as unknown as CanonicalResponseRequest;
}

interface ReadOptions {
  controller: AbortController;
  idleTimeoutMs: number;
  maxBodyBytes: number;
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  options: ReadOptions
): Promise<Uint8Array> {
  if (body === null) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await readWithIdleTimeout(reader, options);
      if (result.done) {
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > options.maxBodyBytes) {
        const error = new UpstreamBodyLimitError(options.maxBodyBytes);
        options.controller.abort(error);
        throw error;
      }
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bodyBytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bodyBytes;
}

async function* parseOpenAIEventStream(
  body: ReadableStream<Uint8Array> | null,
  options: ReadOptions & { onClose: () => void }
): AsyncGenerator<CanonicalResponseEvent> {
  if (body === null) {
    options.onClose();
    throw new UpstreamProtocolError("OpenAI streaming response had no body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let byteLength = 0;
  try {
    while (true) {
      const result = await readWithIdleTimeout(reader, options);
      if (result.done) {
        buffer += decoder.decode();
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > options.maxBodyBytes) {
        const error = new UpstreamBodyLimitError(options.maxBodyBytes);
        options.controller.abort(error);
        throw error;
      }
      buffer += decoder.decode(result.value, { stream: true });

      let boundary = nextEventBoundary(buffer);
      while (boundary !== undefined) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseEventFrame(frame);
        if (event !== undefined) {
          yield event;
        }
        boundary = nextEventBoundary(buffer);
      }
    }

    if (buffer.trim().length > 0) {
      const event = parseEventFrame(buffer);
      if (event !== undefined) {
        yield event;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    options.onClose();
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: ReadOptions
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = <T>(callback: (value: T) => void, value: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      options.controller.signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = (): void => {
      const reason =
        options.controller.signal.reason instanceof Error
          ? options.controller.signal.reason
          : new DOMException("The operation was aborted", "AbortError");
      void reader.cancel(reason).catch(() => undefined);
      finish(reject, reason);
    };
    const timeout = setTimeout(() => {
      const error = new UpstreamIdleTimeoutError(options.idleTimeoutMs);
      options.controller.abort(error);
    }, options.idleTimeoutMs);

    options.controller.signal.addEventListener("abort", abort, { once: true });
    if (options.controller.signal.aborted) {
      abort();
      return;
    }

    reader.read().then(
      (result) => {
        finish(resolve, result);
      },
      (error: unknown) => {
        finish(reject, error);
      }
    );
  });
}

function nextEventBoundary(buffer: string): { index: number; length: number } | undefined {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match === null ? undefined : { index: match.index, length: match[0].length };
}

function parseEventFrame(frame: string): CanonicalResponseEvent | undefined {
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      data.push(value);
    }
  }

  if (data.length === 0 || data.join("\n") === "[DONE]") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch (error) {
    throw new UpstreamProtocolError(
      `OpenAI SSE contained invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (isRecord(parsed) && typeof parsed.type !== "string" && eventName !== undefined) {
    parsed = { ...parsed, type: eventName };
  }
  return canonicalEvent(parsed);
}

function canonicalEvent(value: unknown): CanonicalResponseEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new UpstreamProtocolError("OpenAI SSE event was not an object with a type");
  }

  switch (value.type) {
    case "response.created":
      return { type: value.type, response: responseSnapshot(value.response) };
    case "response.content_part.added": {
      const part = record(value.part, "response.content_part.added.part");
      if (part.type !== "output_text") {
        return undefined;
      }
      return {
        type: value.type,
        item_id: string(value.item_id, "item_id"),
        output_index: number(value.output_index, "output_index"),
        content_index: number(value.content_index, "content_index"),
        part: {
          type: "output_text",
          text: typeof part.text === "string" ? part.text : ""
        }
      };
    }
    case "response.output_text.delta":
      return {
        type: value.type,
        item_id: string(value.item_id, "item_id"),
        output_index: number(value.output_index, "output_index"),
        content_index: number(value.content_index, "content_index"),
        delta: string(value.delta, "delta")
      };
    case "response.output_text.done":
      return {
        type: value.type,
        item_id: string(value.item_id, "item_id"),
        output_index: number(value.output_index, "output_index"),
        content_index: number(value.content_index, "content_index"),
        text: string(value.text, "text")
      };
    case "response.output_item.added":
    case "response.output_item.done": {
      const item = outputItem(value.item);
      if (item === undefined) {
        return undefined;
      }
      return {
        type: value.type,
        output_index: number(value.output_index, "output_index"),
        item
      };
    }
    case "response.function_call_arguments.delta":
      return {
        type: value.type,
        item_id: string(value.item_id, "item_id"),
        output_index: number(value.output_index, "output_index"),
        delta: string(value.delta, "delta")
      };
    case "response.function_call_arguments.done":
      return {
        type: value.type,
        item_id: string(value.item_id, "item_id"),
        output_index: number(value.output_index, "output_index"),
        arguments: string(value.arguments, "arguments")
      };
    case "response.completed":
      return { type: value.type, response: responseSnapshot(value.response) };
    case "response.failed": {
      const response = record(value.response, "response.failed.response");
      return {
        type: value.type,
        response: {
          ...responseSnapshot(response),
          error: canonicalError(response.error)
        }
      };
    }
    case "error":
      return { type: "error", error: canonicalError(value.error ?? value) };
    default:
      return undefined;
  }
}

function responseSnapshot(value: unknown): CanonicalResponseSnapshot {
  const response = record(value, "response");
  return {
    id: string(response.id, "response.id"),
    model: string(response.model, "response.model"),
    usage: response.usage === null || response.usage === undefined ? null : usage(response.usage)
  };
}

function usage(value: unknown): CanonicalUsage {
  const parsed = record(value, "usage");
  return {
    input_tokens: number(parsed.input_tokens, "usage.input_tokens"),
    output_tokens: number(parsed.output_tokens, "usage.output_tokens")
  };
}

function outputItem(value: unknown): CanonicalOutputItem | undefined {
  const item = record(value, "item");
  if (item.type === "message") {
    return {
      id: string(item.id, "item.id"),
      type: "message",
      role: "assistant"
    };
  }
  if (item.type === "function_call") {
    const id = string(item.id, "item.id");
    return {
      id,
      type: "function_call",
      call_id: typeof item.call_id === "string" ? item.call_id : id,
      name: string(item.name, "item.name"),
      arguments: typeof item.arguments === "string" ? item.arguments : ""
    };
  }
  return undefined;
}

function canonicalError(value: unknown): CanonicalError {
  const error = record(value, "error");
  const message = string(error.message, "error.message");
  const type =
    typeof error.type === "string" && error.type !== "error"
      ? error.type
      : typeof error.code === "string"
        ? error.code
        : "api_error";
  return { type, message };
}

function linkAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (signal === undefined) {
    return () => undefined;
  }
  const abort = (): void => controller.abort(signal.reason);
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new UpstreamProtocolError(`${name} must be an object`);
  }
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new UpstreamProtocolError(`${name} must be a string`);
  }
  return value;
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UpstreamProtocolError(`${name} must be a number`);
  }
  return value;
}
