import type {
  AdapterCallOptions,
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalError,
  CanonicalOutputItem,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CanonicalResponseSnapshot,
  CanonicalUsage,
} from "../../canonical/index.js";
import {
  UpstreamProtocolError,
  linkAbortSignal,
  parseSseFrameFields,
  parseUpstreamSseStream,
  positiveInteger,
  readBoundedBody,
  type FetchLike,
  type UpstreamReadOptions,
} from "../../transport/upstream-sse.js";
import { logRawWireEvent, wireLog } from "../../transport/wire-log.js";

/** Grok CLI 구독이 노출하는 Responses 네임스페이스 엔드포인트. */
export const XAI_CLI_RESPONSES_URL = "https://cli-chat-proxy.grok.com/v1/responses";
export const XAI_CLI_CLIENT_VERSION = "1.0.3";
export const DEFAULT_XAI_RESPONSES_MAX_UPSTREAM_BODY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_XAI_RESPONSES_UPSTREAM_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_XAI_RESPONSES_FUNCTION_CALL_TIMEOUT_MS = 30_000;
const XAI_RETRY_DELAY_MS = 200;

/**
 * Grok CLI's Responses wire accepts the canonical OpenAI-shaped request after
 * provider-neutral-only metadata is removed. Hosted tools are not advertised until
 * the CLI proxy contract is observed directly.
 *
 * Grok CLI owns this copy. Its Responses backend shares the OpenAI wire, but not
 * the Codex subscription surface: it has no ChatGPT-unsupported sampling-field branch,
 * no `store: false` requirement, and no `dropSamplingParams` option. Same wire does
 * not justify adapter reuse — duplication is deliberate.
 */
type XaiResponsesWireRequest = Omit<
  CanonicalResponseRequest,
  "metadata" | "native_tools" | "tools"
> & { tools?: XaiWireTool[] };

export interface XaiResponsesAdapterOptions {
  fetch?: FetchLike;
  maxBodyBytes?: number;
  idleTimeoutMs?: number;
  functionCallTimeoutMs?: number;
  /** 구독 경로가 요구하는 추가 헤더. */
  headers?: Readonly<Record<string, string>>;
}

export class XaiResponsesAdapter implements AiGatewayAdapter {
  readonly capabilities = {} as const;
  private readonly fetchImpl: FetchLike;
  private readonly isMarkedFetchFailure: (error: unknown) => boolean;
  private readonly maxBodyBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly functionCallTimeoutMs: number;
  private readonly url: string;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  constructor(options: XaiResponsesAdapterOptions = {}) {
    // Grok CLI 소유 어댑터는 이 네임스페이스 엔드포인트로 고정된다. 임의 엔드포인트
    // 오버라이드는 provider 어댑터를 다시 범용화하므로 옵션으로 노출하지 않는다.
    this.url = XAI_CLI_RESPONSES_URL;
    this.extraHeaders = options.headers ?? {};
    const fetchTracker = createXaiFetchFailureTracker(options.fetch ?? globalThis.fetch.bind(globalThis));
    this.fetchImpl = fetchTracker.fetch;
    this.isMarkedFetchFailure = fetchTracker.isMarkedFailure;
    this.maxBodyBytes = positiveInteger(
      options.maxBodyBytes ?? DEFAULT_XAI_RESPONSES_MAX_UPSTREAM_BODY_BYTES,
      "maxBodyBytes"
    );
    this.idleTimeoutMs = positiveInteger(
      options.idleTimeoutMs ?? DEFAULT_XAI_RESPONSES_UPSTREAM_IDLE_TIMEOUT_MS,
      "idleTimeoutMs"
    );
    this.functionCallTimeoutMs = positiveInteger(
      options.functionCallTimeoutMs ?? DEFAULT_XAI_RESPONSES_FUNCTION_CALL_TIMEOUT_MS,
      "functionCallTimeoutMs"
    );
  }

  async stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions
  ): Promise<AdapterResponse> {
    if (options.apiKey.length === 0) {
      throw new TypeError("apiKey must not be empty");
    }

    // 호출자 signal과 초기/retry fetch 및 stream read를 하나의 per-call controller로 묶는다.
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(options.signal, controller);
    const payload = forXaiResponsesBackend(request, xaiWireTools(request));
    let retryAvailable = true;
    let response: AdapterResponse;

    try {
      response = await this.fetchResponse(request, options.apiKey, payload, controller);
    } catch (error) {
      if (!isRetryableXaiFetchSocket(error, controller.signal, this.isMarkedFetchFailure)) {
        unlinkAbort();
        throw error;
      }
      retryAvailable = false;
      wireLog("xai-responses.retry.discarded", {
        reason: "socket_termination",
        phase: "fetch",
      });
      try {
        await abortableXaiDelay(XAI_RETRY_DELAY_MS, controller.signal);
        response = await this.fetchResponse(request, options.apiKey, payload, controller);
      } catch (retryError) {
        unlinkAbort();
        throw retryError;
      }
    }

    if (!response.ok) {
      unlinkAbort();
      return response;
    }

    return {
      ...response,
      events: retryXaiEvents(response.events, async (signal) => {
        await abortableXaiDelay(XAI_RETRY_DELAY_MS, signal);
        const retried = await this.fetchResponse(request, options.apiKey, payload, controller);
        if (!retried.ok) {
          throw new UpstreamProtocolError(`xAI retry failed with status ${retried.status}`);
        }
        return retried.events;
      }, controller, unlinkAbort, retryAvailable),
    };
  }

  private async fetchResponse(
    request: CanonicalResponseRequest,
    apiKey: string,
    payload: XaiResponsesWireRequest,
    controller: AbortController,
  ): Promise<AdapterResponse> {
    // Exact JSON body sent on each attempt, including every tool's parameters and strict flag.
    wireLog("xai-responses.wire.request", { url: this.url, payload });
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": XAI_CLI_CLIENT_VERSION,
        "x-grok-model-override": request.model,
        ...this.extraHeaders
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      if (process.env.FLEET_AI_GATEWAY_DEBUG === "1") {
        const roles = payload.input.map((item) => ("role" in item ? item.role : item.type));
        console.error(`[ai-gateway] upstream ${response.status} input roles=${JSON.stringify(roles)} keys=${JSON.stringify(Object.keys(payload))}`);
      }
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
    }

    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      events: parseXaiEventStream(response.body, {
        controller,
        idleTimeoutMs: this.idleTimeoutMs,
        maxBodyBytes: this.maxBodyBytes,
        onClose: () => undefined
      }, this.functionCallTimeoutMs)
    };
  }

  wireTools(request: CanonicalResponseRequest): readonly NonNullable<CanonicalResponseRequest["tools"]>[number][] {
    return xaiWireTools(request) ?? [];
  }
}

function forXaiResponsesBackend(
  request: CanonicalResponseRequest,
  tools: readonly XaiWireTool[] | undefined = xaiWireTools(request),
): XaiResponsesWireRequest {
  const { metadata: _metadata, native_tools: _nativeTools, ...rest } = request;
  return {
    ...rest,
    input: request.input.map((item) => {
      if (item.type === "function_call_output") {
        const { is_error: _isError, tool_references: _toolReferences, ...wireItem } = item;
        return wireItem;
      }
      const { reasoning_content: _reasoningContent, ...wireItem } = item;
      return wireItem;
    }),
    ...(tools === undefined ? {} : { tools: [...tools] }),
  };
}

type XaiWireTool = Omit<NonNullable<CanonicalResponseRequest["tools"]>[number], "defer_loading">;

function xaiWireTools(request: CanonicalResponseRequest): XaiWireTool[] | undefined {
  if (request.tools === undefined) return undefined;
  const tools = request.tools;
  const toolSearchActive = tools.some((tool) => isToolSearchName(tool.name));
  const selectedName = request.tool_choice && typeof request.tool_choice === "object"
    ? request.tool_choice.name
    : undefined;
  const referencedNames = new Set(
    request.input.flatMap((item) => item.type === "function_call_output" ? item.tool_references ?? [] : []),
  );
  return tools
    .filter((tool) => !toolSearchActive || tool.defer_loading !== true
      || isToolSearchName(tool.name)
      || (selectedName !== undefined && toolNameMatches(tool.name, selectedName))
      || referencedNames.has(tool.name))
    .map(({ defer_loading: _deferLoading, ...tool }) => tool);
}

function toolLeafName(name: string): string {
  const separator = name.lastIndexOf("__");
  return separator === -1 ? name : name.slice(separator + 2);
}

function isToolSearchName(name: string): boolean {
  return toolLeafName(name).replace(/[_-]/g, "").toLowerCase() === "toolsearch";
}

function toolNameMatches(declaredName: string, selectedName: string): boolean {
  return declaredName === selectedName || toolLeafName(declaredName) === toolLeafName(selectedName);
}

type ReadOptions = UpstreamReadOptions;

function retryXaiEvents(
  events: AsyncIterable<CanonicalResponseEvent>,
  retry: (signal: AbortSignal) => Promise<AsyncIterable<CanonicalResponseEvent>>,
  controller: AbortController,
  unlinkAbort: () => void,
  retryAvailable: boolean,
): AsyncIterable<CanonicalResponseEvent> {
  return {
    [Symbol.asyncIterator]() {
      const source = events[Symbol.asyncIterator]();
      const iterator = generateXaiRetryEvents(source, retry, controller, unlinkAbort, retryAvailable);
      return {
        next: () => iterator.next(),
        return: async () => {
          controller.abort();
          return iterator.return(undefined);
        },
        throw: async (error?: unknown) => {
          controller.abort(error);
          return iterator.throw(error);
        },
      };
    },
  };
}

async function* generateXaiRetryEvents(
  source: AsyncIterator<CanonicalResponseEvent>,
  retry: (signal: AbortSignal) => Promise<AsyncIterable<CanonicalResponseEvent>>,
  controller: AbortController,
  unlinkAbort: () => void,
  retryAvailable: boolean,
): AsyncGenerator<CanonicalResponseEvent> {
  // Anthropic 변환이 message_start/thinking을 즉시 발화하므로 commit 전 lead만 보류한다.
  const lead: CanonicalResponseEvent[] = [];
  let committed = false;
  let normalCompletion = false;
  let pendingError: Extract<CanonicalResponseEvent, { type: "error" }> | undefined;

  try {
    while (true) {
      let result: IteratorResult<CanonicalResponseEvent>;
      try {
        result = await source.next();
      } catch (error) {
        if (committed || controller.signal.aborted || !isUndiciSocketTermination(error)) {
          throw error;
        }
        if (!retryAvailable) {
          yield* lead;
          throw error;
        }
        wireLog("xai-responses.retry.discarded", {
          reason: "socket_termination",
          phase: "pre_commit",
        });
        await source.return?.();
        lead.length = 0;
        yield* await retry(controller.signal);
        return;
      }

      if (result.done) {
        yield* lead;
        if (pendingError !== undefined) {
          yield pendingError;
        }
        normalCompletion = true;
        return;
      }

      const event = result.value;
      if (retryAvailable && !committed && isRetryableXaiFailure(event)) {
        if (event.type === "response.failed") {
          const errorTypes = pendingError === undefined
            ? [event.response.error.type]
            : [pendingError.error.type, event.response.error.type];
          wireLog("xai-responses.retry.discarded", pendingError === undefined
            ? { reason: "response.failed", errorTypes }
            : { reason: "error_failed_pair", errorTypes });
          await source.return?.();
          lead.length = 0;
          yield* await retry(controller.signal);
          return;
        }
        pendingError = event;
        continue;
      }

      if (pendingError !== undefined) {
        yield* lead;
        lead.length = 0;
        yield pendingError;
        pendingError = undefined;
        committed = true;
      }

      if (commitsXaiOutput(event)) {
        yield* lead;
        lead.length = 0;
        committed = true;
        yield event;
      } else {
        lead.push(event);
      }
    }
  } finally {
    if (!normalCompletion && !controller.signal.aborted) {
      controller.abort();
    }
    unlinkAbort();
    await source.return?.();
  }
}

function isRetryableXaiFailure(event: CanonicalResponseEvent): event is
  Extract<CanonicalResponseEvent, { type: "response.failed" | "error" }> {
  return (event.type === "response.failed" && isRetryableXaiErrorType(event.response.error.type))
    || (event.type === "error" && isRetryableXaiErrorType(event.error.type));
}

function isRetryableXaiErrorType(type: string): boolean {
  return type === "server_error"
    || type === "server_is_overloaded"
    || type === "service_unavailable_error";
}

function commitsXaiOutput(event: CanonicalResponseEvent): boolean {
  if (event.type === "response.created" || event.type === "response.reasoning_summary_text.delta") {
    return false;
  }
  if (event.type === "response.output_item.added" && event.item.type === "message") {
    return false;
  }
  return true;
}

function createXaiFetchFailureTracker(fetchImpl: FetchLike): {
  fetch: FetchLike;
  isMarkedFailure: (error: unknown) => boolean;
} {
  const failures = new WeakSet<object>();
  return {
    fetch: async (input, init) => {
      try {
        return await fetchImpl(input, init);
      } catch (error) {
        if (error !== null && typeof error === "object") {
          failures.add(error);
        }
        throw error;
      }
    },
    isMarkedFailure: (error) => error !== null && typeof error === "object" && failures.has(error),
  };
}

function isRetryableXaiFetchSocket(
  error: unknown,
  signal: AbortSignal,
  isMarkedFailure: (error: unknown) => boolean,
): boolean {
  return !signal.aborted && isMarkedFailure(error) && isUndiciSocketTermination(error);
}

function isUndiciSocketTermination(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth <= 4; depth += 1) {
    if (current === null || typeof current !== "object" || seen.has(current)) {
      return false;
    }
    seen.add(current);
    if ((current as { code?: unknown }).code === "UND_ERR_SOCKET") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function abortableXaiDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(onResolve, delayMs);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    function onResolve(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseXaiEventStream(
  body: ReadableStream<Uint8Array> | null,
  options: ReadOptions & { onClose: () => void },
  functionCallTimeoutMs: number
): AsyncGenerator<CanonicalResponseEvent> {
  return assembleXaiFunctionCalls(
    parseUpstreamSseStream(
      body,
      { ...options, missingBodyMessage: "Grok CLI streaming response had no body" },
      parseEventFrame,
    ),
    options.controller,
    functionCallTimeoutMs,
  );
}

interface PendingXaiFunctionCall {
  readonly added: Extract<CanonicalResponseEvent, { type: "response.output_item.added" }>;
  readonly deadlineAt: number;
  argumentsDone?: Extract<CanonicalResponseEvent, { type: "response.function_call_arguments.done" }>;
}

async function* assembleXaiFunctionCalls(
  source: AsyncIterable<CanonicalResponseEvent>,
  controller: AbortController,
  timeoutMs: number,
): AsyncGenerator<CanonicalResponseEvent> {
  const iterator = source[Symbol.asyncIterator]();
  const pending = new Map<string, PendingXaiFunctionCall>();
  let completedNormally = false;
  try {
    while (true) {
      const deadlineAt = earliestXaiFunctionCallDeadline(pending);
      const result = deadlineAt === undefined
        ? await iterator.next()
        : await nextXaiEventBeforeDeadline(iterator, deadlineAt, controller, timeoutMs);
      if (result.done) {
        if (pending.size > 0) {
          throw incompleteXaiFunctionCall("stream ended before function call output_item.done");
        }
        completedNormally = true;
        return;
      }

      const event = result.value;
      if (event.type === "response.completed" && pending.size > 0) {
        throw incompleteXaiFunctionCall("response.completed arrived before function call output_item.done");
      }
      if (event.type === "response.output_item.added" && event.item.type === "function_call") {
        const key = xaiFunctionCallKey(event.output_index, event.item.id);
        pending.set(key, {
          added: event,
          // Each call gets a full timeout from its own added event. Waiting uses the
          // earliest active deadline, so a later parallel call is never shortened by
          // an earlier call's age.
          deadlineAt: Date.now() + timeoutMs,
        });
        continue;
      }
      if (event.type === "response.function_call_arguments.done") {
        const call = pending.get(xaiFunctionCallKey(event.output_index, event.item_id));
        if (call !== undefined) {
          call.argumentsDone = event;
          continue;
        }
      }
      if (event.type === "response.output_item.done" && event.item.type === "function_call") {
        const key = xaiFunctionCallKey(event.output_index, event.item.id);
        const call = pending.get(key);
        if (call !== undefined) {
          pending.delete(key);
          yield call.added;
          if (call.argumentsDone !== undefined) {
            yield call.argumentsDone;
          } else if (event.item.arguments.length > 0) {
            yield {
              type: "response.function_call_arguments.done",
              item_id: event.item.id,
              output_index: event.output_index,
              arguments: event.item.arguments,
            };
          }
          yield event;
          continue;
        }
      }
      yield event;
    }
  } finally {
    // The outer retry seam owns per-call cancellation. Closing this attempt must release
    // only its source: a retry closes attempt one before reusing the same controller for
    // attempt two, while outer return/throw and terminal errors abort the controller.
    const returned = iterator.return?.();
    if (returned !== undefined) {
      await returned.catch(() => undefined);
    }
  }
}

function earliestXaiFunctionCallDeadline(
  pending: ReadonlyMap<string, PendingXaiFunctionCall>,
): number | undefined {
  let earliest: number | undefined;
  for (const call of pending.values()) {
    if (earliest === undefined || call.deadlineAt < earliest) {
      earliest = call.deadlineAt;
    }
  }
  return earliest;
}

async function nextXaiEventBeforeDeadline(
  iterator: AsyncIterator<CanonicalResponseEvent>,
  deadlineAt: number,
  controller: AbortController,
  timeoutMs: number,
): Promise<IteratorResult<CanonicalResponseEvent>> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    const error = incompleteXaiFunctionCall(`function call assembly exceeded ${timeoutMs}ms`);
    controller.abort(error);
    throw error;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const next = iterator.next();
  // A timeout wins the race by design, but aborting the upstream reader rejects
  // this losing read shortly afterwards. Consume that rejection so timeout
  // cleanup never leaks an unhandled promise.
  void next.catch(() => undefined);
  try {
    return await Promise.race([
      next,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = incompleteXaiFunctionCall(`function call assembly exceeded ${timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function incompleteXaiFunctionCall(reason: string): UpstreamProtocolError {
  return new UpstreamProtocolError(`Grok CLI ${reason}`);
}

function xaiFunctionCallKey(outputIndex: number, itemId: string): string {
  return `${outputIndex}:${itemId}`;
}

function parseEventFrame(frame: string): CanonicalResponseEvent | undefined {
  const { event: eventName, data } = parseSseFrameFields(frame);
  if (data.length === 0 || data === "[DONE]") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new UpstreamProtocolError(
      `Grok CLI SSE contained invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  // Raw provider payload before the event-name type fallback and canonical filtering.
  logRawWireEvent("xai-responses.wire.event", eventName, parsed);
  if (isRecord(parsed) && typeof parsed.type !== "string" && eventName !== undefined) {
    parsed = { ...parsed, type: eventName };
  }
  return canonicalEvent(parsed);
}

function canonicalEvent(value: unknown): CanonicalResponseEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new UpstreamProtocolError("Grok CLI SSE event was not an object with a type");
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
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta":
      return {
        type: "response.reasoning_summary_text.delta",
        item_id: string(value.item_id, "item_id"),
        output_index: number(value.output_index, "output_index"),
        delta: string(value.delta, "delta")
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
    // Hold argument fragments until the Grok CLI proxy's partial-JSON behavior is observed.
    // The `.done` event carries the complete argument object, which downstream treats as the
    // remainder when nothing was streamed ahead of it.
    case "response.function_call_arguments.delta":
      return undefined;
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
  const inputTokens = number(parsed.input_tokens, "usage.input_tokens");
  const outputTokens = number(parsed.output_tokens, "usage.output_tokens");

  const inputDetails = optionalRecord(parsed.input_tokens_details, "usage.input_tokens_details");
  const cachedInputTokens = inputDetails === undefined
    ? undefined
    : optionalNonNegativeNumber(inputDetails.cached_tokens, "usage.input_tokens_details.cached_tokens");
  const cacheWriteInputTokens = inputDetails === undefined
    ? undefined
    : optionalNonNegativeNumber(inputDetails.cache_write_tokens, "usage.input_tokens_details.cache_write_tokens");

  const outputDetails = optionalRecord(parsed.output_tokens_details, "usage.output_tokens_details");
  const reasoningOutputTokens = outputDetails === undefined
    ? undefined
    : optionalNonNegativeNumber(outputDetails.reasoning_tokens, "usage.output_tokens_details.reasoning_tokens");

  const totalTokens = optionalNonNegativeNumber(parsed.total_tokens, "usage.total_tokens");

  // cached_tokens/cache_write_tokens/reasoning_tokens are documented as subsets of their
  // parent totals and total_tokens as their sum, but upstream envelopes have not been
  // observed to guarantee that arithmetic. Reject only malformed shape (wrong type /
  // negative / non-finite) here; a self-inconsistent but well-typed envelope is preserved
  // as-is on the canonical event rather than failing the whole response. The Anthropic
  // conversion layer falls back to the authoritative parent input total when the two
  // exceed it, rather than inventing a read-over-write truncation priority.

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cached_input_tokens: cachedInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cache_write_input_tokens: cacheWriteInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoning_output_tokens: reasoningOutputTokens }),
    ...(totalTokens === undefined ? {} : { total_tokens: totalTokens })
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new UpstreamProtocolError(`${name} must be an object`);
  }
  return value;
}

/** Optional nested detail object. Absent or null means the field was never reported. */
function optionalRecord(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return record(value, name);
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

/** Optional finite nonnegative detail count. Absent or null means the field was never reported. */
function optionalNonNegativeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new UpstreamProtocolError(`${name} must be a finite nonnegative number`);
  }
  return value;
}
