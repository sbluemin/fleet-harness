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
} from "../../../canonical/index.js";
import {
  UpstreamProtocolError,
  linkAbortSignal,
  parseSseFrameFields,
  parseUpstreamSseStream,
  positiveInteger,
  readBoundedBody,
  type FetchLike,
  type UpstreamReadOptions,
} from "../../../transport/upstream-sse.js";
import { logRawWireEvent, wireLog } from "../../../transport/wire-log.js";
import { DEFAULT_XAI_ENDPOINT_PREFERENCE } from "../../../settings/index.js";
import type { XaiEndpointPreference } from "../../../settings/index.js";
import { XAI_CLI_FALLBACK_CLIENT_VERSION, xaiCliClientVersion } from "../cli-version.js";

/**
 * xAI's own Responses endpoint, reached with the SuperGrok subscription token.
 *
 * It is the shared standard-tier pool. Warm, it is the faster of the two — `response.created` at
 * ~0.69s median against the proxy's ~0.83s — but its tail is the whole problem: measured
 * 2026-08-20 with an identical body and credential, it answered five consecutive requests with
 * `{"type":"error","message":"The model is currently at capacity due to high demand..."}` at one
 * moment, and parked 10.6s and 68.7s before `response.created` at another. The proxy's worst
 * sample in the same interleaved run was 1.5s, which is why the proxy is the default.
 *
 * The endpoint is the user's setting ({@link XaiEndpointPreference}) and a turn never crosses to
 * the other one: the two do not share a prompt cache, so a crossing re-prefills the entire
 * conversation. Measured on a live 8-request session, the first request after a crossing served
 * 128 cached tokens of 30,067 and the first request back served 128 of 58,441, while requests
 * that stayed put settled at 0.88-0.98 — a cost no per-turn rerouting can earn back.
 *
 * The proxy remaps the model to its `-build` variant; this endpoint returns the model as asked.
 * Quota is drawn from the same subscription either way, and billing (`quota.ts`) is proxy-owned.
 */
export const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
/**
 * The Grok CLI's own chat proxy, and the default endpoint.
 *
 * It is what the official CLI talks to, so it is the path an xAI subscription is actually built
 * around: whether the direct endpoint accepts a subscription token depends on the account
 * (oh-my-pi#5978 reports `402 You have run out of credits or need a Grok subscription` from it on
 * an account whose official CLI works), while this one serves every subscription that CLI serves.
 */
export const XAI_CLI_RESPONSES_URL = "https://cli-chat-proxy.grok.com/v1/responses";
/**
 * Last-resort client version. The live number comes from the installed CLI — see
 * `../cli-version.ts`, which explains why this must not be the only source.
 */
export const XAI_CLI_CLIENT_VERSION = XAI_CLI_FALLBACK_CLIENT_VERSION;
const DEFAULT_XAI_RESPONSES_MAX_UPSTREAM_BODY_BYTES = 64 * 1024 * 1024;
/**
 * Longest the upstream may send no bytes at all before the read is abandoned.
 *
 * Calibrated against what the caller tolerates, not against how fast a short turn answers.
 * Claude Code's own byte-stream idle watchdog waits 300s, so anything tighter here converts a
 * turn the client was still willing to wait for into a failure the client never asked for.
 * Measured 2026-08-21 on a live session: 30s killed 20 turns whose upstream was simply thinking,
 * and the rate climbed through the session as the conversation grew and the gaps grew with it.
 */
const DEFAULT_XAI_RESPONSES_UPSTREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_XAI_RESPONSES_FUNCTION_CALL_TIMEOUT_MS = 30_000;
/**
 * Longest gap tolerated between two canonical events on one Grok CLI stream.
 *
 * The transport idle timeout watches bytes, so a proxy that keeps writing SSE comments while the
 * model produces nothing resets it forever. Wire captures show that exact shape: streams that fell
 * silent after `content_part.added` or mid `output_text.delta` and were still parked ten minutes
 * later. This clock exists to bound that hang.
 *
 * It was a minute, justified by healthy-turn gaps of p99 0.38s and 5.9s at worst. A live session
 * on 2026-08-21 falsified that number: it killed 9 turns of 70s to 165s whose only fault was a
 * quiet stretch while the model worked, and the failure rate climbed through the session as the
 * conversation grew and the thinking gaps grew with it. Those measurements came from short turns
 * and never saw a long one, so the headroom they claimed did not exist.
 *
 * Five minutes instead, taken from what the caller actually tolerates rather than from how fast a
 * short turn answers: Claude Code's own idle watchdog waits 300s. A bound tighter than the
 * client's converts a turn the client was still willing to wait for into a failure it never asked
 * for, and past the commit point that failure is unrecoverable at both layers.
 */
const DEFAULT_XAI_RESPONSES_SEMANTIC_STALL_TIMEOUT_MS = 300_000;
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
  "metadata" | "native_tools" | "tools" | "input"
> & {
  tools?: XaiWireTool[];
  input: XaiWireInputItem[];
  include?: string[];
};

/** The replayed reasoning item, which has no canonical input counterpart of its own. */
interface XaiWireReasoningItem {
  type: "reasoning";
  id?: string;
  summary: [];
  encrypted_content: string;
}

type XaiWireInputItem = XaiWireReasoningItem | Record<string, unknown>;

/**
 * Asks the wire to hand back the opaque reasoning blob so the next turn can replay it.
 *
 * Without it the model re-derives its own prior thinking after every tool round-trip. Measured
 * 2026-08-20 across three interleaved pairs on an otherwise identical two-turn conversation:
 * replaying the blob cost 32 reasoning tokens against 66 without it, and 47 output tokens
 * against 82.
 */
const XAI_REASONING_INCLUDE = "reasoning.encrypted_content";

export interface XaiResponsesAdapterOptions {
  fetch?: FetchLike;
  maxBodyBytes?: number;
  idleTimeoutMs?: number;
  functionCallTimeoutMs?: number;
  semanticStallTimeoutMs?: number;
  /** 구독 경로가 요구하는 추가 헤더. */
  headers?: Readonly<Record<string, string>>;
  /** The endpoint every turn uses. Absent is {@link DEFAULT_XAI_ENDPOINT_PREFERENCE}. */
  endpoint?: XaiEndpointPreference;
  /** Test seam for the installed Grok CLI version the proxy is told about. */
  clientVersion?: () => Promise<string>;
}

interface XaiEndpoint {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}


function directXaiEndpoint(): XaiEndpoint {
  return { url: XAI_RESPONSES_URL, headers: {} };
}

/**
 * The proxy's identity headers.
 *
 * `x-grok-client-version` is the only one it requires: measured 2026-08-20, omitting it is a
 * `426` naming the floor it wants, while `1.0.3` and `1.0.5` both pass and even
 * `x-xai-token-auth` turns out to be optional. The CLI additionally stamps
 * `x-grok-conv-id` / `req-id` / `session-id` / `agent-id` / `turn-idx` on every request; all
 * five were sent and then dropped in the same probe with no change in acceptance, and a 40-turn
 * A/B of `x-grok-conv-id` (2026-08-18) moved the prompt-cache hit rate not at all. They are
 * telemetry correlation for a client whose sessions Fleet does not own, so they are not sent.
 */
function proxyXaiEndpoint(model: string, clientVersion: string): XaiEndpoint {
  return {
    url: XAI_CLI_RESPONSES_URL,
    headers: {
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": clientVersion,
      "x-grok-model-override": model,
    },
  };
}

export class XaiResponsesAdapter implements AiGatewayAdapter {
  readonly capabilities = {} as const;
  private readonly fetchImpl: FetchLike;
  private readonly isMarkedFetchFailure: (error: unknown) => boolean;
  private readonly maxBodyBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly functionCallTimeoutMs: number;
  private readonly semanticStallTimeoutMs: number;
  private readonly endpointPreference: XaiEndpointPreference;
  private readonly clientVersion: () => Promise<string>;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  constructor(options: XaiResponsesAdapterOptions = {}) {
    // 엔드포인트 후보는 고정이다. 임의 오버라이드는 provider 어댑터를 다시 범용화하므로
    // 옵션으로 노출하지 않는다.
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
    this.semanticStallTimeoutMs = positiveInteger(
      options.semanticStallTimeoutMs ?? DEFAULT_XAI_RESPONSES_SEMANTIC_STALL_TIMEOUT_MS,
      "semanticStallTimeoutMs"
    );
    this.endpointPreference = options.endpoint ?? DEFAULT_XAI_ENDPOINT_PREFERENCE;
    this.clientVersion = options.clientVersion ?? (() => xaiCliClientVersion());
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
    const tools = xaiWireTools(request);
    let payload = forXaiResponsesBackend(request, tools);
    /**
     * A replayed blob the wire refuses is not survivable: fed a corrupted `encrypted_content`
     * it answers 200 and then closes the stream having emitted nothing at all — no error frame,
     * no `response.created`, measured 2026-08-20. Since only the provider can read the blob, a
     * damaged one is undetectable before sending, so the recovery is to drop the replay and
     * reopen. Once dropped it stays dropped for this turn.
     */
    let replayAvailable = replaysXaiReasoning(request);
    /**
     * Two budgets, deliberately not one.
     *
     * A socket that dies while the request is still being written and a stream that dies after
     * the upstream accepted it are different faults with different causes — a stale pooled
     * connection versus an upstream that gave up mid-turn. Sharing one budget meant the first
     * one to fire disarmed the other, so a request that survived a stale socket on the second
     * dial then had no attempt left when its stream dropped. Spending each where it belongs
     * costs at most one extra dial per turn and is the difference between a recovered turn and
     * an `API mid response error` at the client.
     */
    let fetchRetryAvailable = true;
    let streamRetryAvailable = true;
    let response: AdapterResponse;

    // 엔드포인트는 설정이 정한 하나뿐이다. 턴 도중이든 턴 사이든 다른 쪽으로 넘어가지 않는다 —
    // 두 엔드포인트는 프롬프트 캐시를 공유하지 않아 한 번 건널 때마다 대화 전체를 다시 프리필한다.
    const endpoint = this.endpointPreference === "cli-proxy"
      ? await this.proxyEndpoint(payload.model)
      : directXaiEndpoint();

    try {
      response = await this.fetchResponse(options.apiKey, payload, controller, endpoint);
    } catch (error) {
      if (
        !fetchRetryAvailable
        || !isRetryableXaiFetchSocket(error, controller.signal, this.isMarkedFetchFailure)
      ) {
        unlinkAbort();
        throw error;
      }
      fetchRetryAvailable = false;
      wireLog("xai-responses.retry.discarded", {
        reason: "socket_termination",
        phase: "fetch",
      });
      try {
        await abortableXaiDelay(XAI_RETRY_DELAY_MS, controller.signal);
        response = await this.fetchResponse(options.apiKey, payload, controller, endpoint);
      } catch (retryError) {
        unlinkAbort();
        throw retryError;
      }
    }

    if (!response.ok) {
      unlinkAbort();
      return response;
    }

    const reopen = async (signal: AbortSignal, reason: string): Promise<AsyncIterable<CanonicalResponseEvent>> => {
      if (reason === "empty_stream" && replayAvailable) {
        replayAvailable = false;
        payload = forXaiResponsesBackend(request, tools, false);
        wireLog("xai-responses.reasoning.replay_dropped", { reason });
        await abortableXaiDelay(XAI_RETRY_DELAY_MS, signal);
        const withoutReplay = await this.fetchResponse(options.apiKey, payload, controller, endpoint);
        if (!withoutReplay.ok) {
          throw new UpstreamProtocolError(`xAI retry failed with status ${withoutReplay.status}`);
        }
        return withoutReplay.events;
      }
      // The delay is also the window in which a caller that closed the stream can still stop the
      // reopen, so it is paid before any reattempt.
      await abortableXaiDelay(XAI_RETRY_DELAY_MS, signal);
      const retried = await this.fetchResponse(options.apiKey, payload, controller, endpoint);
      if (!retried.ok) {
        throw new UpstreamProtocolError(`xAI retry failed with status ${retried.status}`);
      }
      return retried.events;
    };

    return {
      ...response,
      events: retryXaiEvents(
        response.events,
        reopen,
        controller,
        unlinkAbort,
        streamRetryAvailable,
        () => replayAvailable,
      ),
    };
  }

  /** The proxy endpoint, with the installed CLI's version resolved for its gate. */
  private async proxyEndpoint(model: string): Promise<XaiEndpoint> {
    return proxyXaiEndpoint(model, await this.clientVersion());
  }

  private async fetchResponse(
    apiKey: string,
    payload: XaiResponsesWireRequest,
    controller: AbortController,
    endpoint: XaiEndpoint,
  ): Promise<AdapterResponse> {
    // Exact JSON body sent on each attempt, including every tool's parameters and strict flag.
    wireLog("xai-responses.wire.request", { url: endpoint.url, payload });
    const response = await this.fetchImpl(endpoint.url, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        // 직결 엔드포인트는 bearer 토큰만 보고 모델은 payload에서 읽는다. CLI 신원 헤더는
        // 프록시로 폴백할 때만 실린다.
        ...endpoint.headers,
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
      }, this.functionCallTimeoutMs, this.semanticStallTimeoutMs)
    };
  }

  wireTools(request: CanonicalResponseRequest): readonly NonNullable<CanonicalResponseRequest["tools"]>[number][] {
    return xaiWireTools(request) ?? [];
  }
}

function forXaiResponsesBackend(
  request: CanonicalResponseRequest,
  tools: readonly XaiWireTool[] | undefined = xaiWireTools(request),
  replayReasoning = true,
): XaiResponsesWireRequest {
  const { metadata: _metadata, native_tools: _nativeTools, ...rest } = request;
  const input: XaiWireInputItem[] = [];
  for (const item of request.input) {
    if (item.type === "function_call_output") {
      const { is_error: _isError, tool_references: _toolReferences, ...wireItem } = item;
      input.push(wireItem);
      continue;
    }
    const {
      reasoning_content: _reasoningContent,
      reasoning_encrypted: encrypted,
      reasoning_id: reasoningId,
      ...wireItem
    } = item;
    // The blob belongs to the turn that produced this item, so it is replayed as its own item
    // immediately before it — the position the wire emitted it in, and the one a prefix cache
    // can match byte for byte.
    if (replayReasoning && encrypted !== undefined && encrypted.length > 0) {
      input.push({
        type: "reasoning",
        ...(reasoningId === undefined ? {} : { id: reasoningId }),
        summary: [],
        encrypted_content: encrypted,
      });
    }
    input.push(wireItem);
  }
  return {
    ...rest,
    input,
    // Only asked for when a reply could carry one: on a turn that replays nothing the include
    // is inert, and on a retry that dropped the replay it must not invite a fresh blob back.
    ...(replayReasoning ? { include: [XAI_REASONING_INCLUDE] } : {}),
    ...(tools === undefined ? {} : { tools: [...tools] }),
  };
}

/** Whether this request would replay any reasoning blob at all. */
function replaysXaiReasoning(request: CanonicalResponseRequest): boolean {
  return request.input.some((item) =>
    item.type !== "function_call_output"
    && typeof item.reasoning_encrypted === "string"
    && item.reasoning_encrypted.length > 0);
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

/** Reopen the turn upstream. `reason` selects the recovery, not just the log line. */
type XaiReopen = (
  signal: AbortSignal,
  reason: "retryable_failure" | "empty_stream",
) => Promise<AsyncIterable<CanonicalResponseEvent>>;

function retryXaiEvents(
  events: AsyncIterable<CanonicalResponseEvent>,
  retry: XaiReopen,
  controller: AbortController,
  unlinkAbort: () => void,
  retryAvailable: boolean,
  replayAvailable: () => boolean,
): AsyncIterable<CanonicalResponseEvent> {
  return {
    [Symbol.asyncIterator]() {
      const source = events[Symbol.asyncIterator]();
      const iterator = generateXaiRetryEvents(
        source,
        retry,
        controller,
        unlinkAbort,
        retryAvailable,
        replayAvailable,
      );
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
  retry: XaiReopen,
  controller: AbortController,
  unlinkAbort: () => void,
  retryAvailable: boolean,
  replayAvailable: () => boolean,
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
        yield* await retry(controller.signal, "retryable_failure");
        return;
      }

      if (result.done) {
        // A held error that no `response.failed` ever joined, on a stream that then closed
        // without committing a byte: the turn produced nothing, so the pair it was waiting for
        // is never coming. Measured on xAI's capacity refusal, which arrives as a lone `error`
        // frame and ends the stream — holding it here surfaced a retryable overload untried.
        if (pendingError !== undefined) {
          wireLog("xai-responses.retry.discarded", {
            reason: "error_stream_end",
            errorTypes: [pendingError.error.type],
          });
          lead.length = 0;
          yield* await retry(controller.signal, "retryable_failure");
          return;
        }
        // A stream that closed without committing a byte and without saying why is the shape a
        // rejected reasoning replay produces. Dropping the replay is the only lever that
        // changes the outcome, so it is the only case worth reopening for.
        if (!committed && replayAvailable()) {
          wireLog("xai-responses.retry.discarded", { reason: "empty_stream" });
          lead.length = 0;
          yield* await retry(controller.signal, "empty_stream");
          return;
        }
        yield* lead;
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
          yield* await retry(controller.signal, "retryable_failure");
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
    || type === "service_unavailable_error"
    || type === XAI_OVERLOADED_ERROR_TYPE;
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
  functionCallTimeoutMs: number,
  semanticStallTimeoutMs: number,
): AsyncGenerator<CanonicalResponseEvent> {
  return assembleXaiFunctionCalls(
    parseUpstreamSseStream(
      body,
      { ...options, missingBodyMessage: "Grok CLI streaming response had no body" },
      parseEventFrame,
    ),
    options.controller,
    functionCallTimeoutMs,
    semanticStallTimeoutMs,
  );
}

interface PendingXaiFunctionCall {
  readonly added: Extract<CanonicalResponseEvent, { type: "response.output_item.added" }>;
  readonly deadlineAt: number;
  argumentsDone?: Extract<CanonicalResponseEvent, { type: "response.function_call_arguments.done" }>;
  /** Fragments absorbed from the wire. Never forwarded — the salvage below is their only reader. */
  argumentsBuffer: string;
}

/** The deadline elapsed with calls still pending; the caller decides whether they can be salvaged. */
const XAI_ASSEMBLY_DEADLINE = Symbol("xai-assembly-deadline");

async function* assembleXaiFunctionCalls(
  source: AsyncIterable<CanonicalResponseEvent>,
  controller: AbortController,
  timeoutMs: number,
  semanticStallTimeoutMs: number,
): AsyncGenerator<CanonicalResponseEvent> {
  const iterator = source[Symbol.asyncIterator]();
  const pending = new Map<string, PendingXaiFunctionCall>();
  let snapshot: CanonicalResponseSnapshot | undefined;
  let completedNormally = false;
  // The stall clock starts at the first read, so a proxy that accepts the request and then never
  // writes an event is bounded too — not only one that goes quiet mid-turn.
  let lastEventAt = Date.now();
  let lastEventType: string | undefined;
  try {
    while (true) {
      const callDeadlineAt = earliestXaiFunctionCallDeadline(pending);
      const stallDeadlineAt = lastEventAt + semanticStallTimeoutMs;
      const callDeadlineFirst = callDeadlineAt !== undefined && callDeadlineAt <= stallDeadlineAt;
      const result = await nextXaiEventBeforeDeadline(
        iterator,
        Math.min(stallDeadlineAt, callDeadlineAt ?? Number.POSITIVE_INFINITY),
      );
      if (result === XAI_ASSEMBLY_DEADLINE) {
        if (callDeadlineFirst) {
          yield* salvageXaiPendingCalls(
            pending,
            snapshot,
            `function call assembly exceeded ${timeoutMs}ms`,
            controller,
          );
          completedNormally = true;
          return;
        }
        yield* failXaiSemanticStall(
          pending,
          snapshot,
          semanticStallTimeoutMs,
          lastEventType,
          controller,
        );
        completedNormally = true;
        return;
      }
      lastEventAt = Date.now();
      if (result.done) {
        if (pending.size > 0) {
          yield* salvageXaiPendingCalls(
            pending,
            snapshot,
            "stream ended before function call output_item.done",
            controller,
          );
        }
        completedNormally = true;
        return;
      }

      const event = result.value;
      lastEventType = event.type;
      if (event.type === "response.created") {
        snapshot = event.response;
      }
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
          argumentsBuffer: "",
        });
        continue;
      }
      if (event.type === "response.function_call_arguments.delta") {
        // Absorbed, never forwarded: a partial fragment cannot be reassembled safely by the
        // client, and only the salvage below reads the buffer. A fragment for a call this
        // stream never opened is dropped exactly as before.
        const call = pending.get(xaiFunctionCallKey(event.output_index, event.item_id));
        if (call !== undefined) {
          call.argumentsBuffer += event.delta;
        }
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

/**
 * Grok CLI has been measured delivering a function call's complete argument object in a single
 * `arguments.delta` and then never sending `arguments.done` or `output_item.done` — the stream
 * simply stops. Failing the whole turn there discards a tool call the model demonstrably
 * finished writing, so a pending call whose absorbed buffer parses as a complete JSON object is
 * closed out and the turn is sealed. Anything short of that is still the protocol error it was:
 * a truncated fragment cannot be told apart from a call the model was still writing.
 */
async function* salvageXaiPendingCalls(
  pending: Map<string, PendingXaiFunctionCall>,
  snapshot: CanonicalResponseSnapshot | undefined,
  reason: string,
  controller: AbortController,
): AsyncGenerator<CanonicalResponseEvent> {
  const salvageable = [...pending.values()].every(
    (call) => completeXaiArguments(call) !== undefined,
  );
  if (snapshot === undefined || !salvageable) {
    const error = incompleteXaiFunctionCall(reason);
    controller.abort(error);
    throw error;
  }

  wireLog("xai-responses.function_call.salvaged", {
    reason,
    calls: pending.size,
  });
  // The upstream read is parked on a stream that stopped writing. Releasing it here is what
  // lets this attempt unwind at all — the failure path aborts for the same reason.
  controller.abort(incompleteXaiFunctionCall(reason));

  for (const [key, call] of pending) {
    const args = completeXaiArguments(call) ?? "";
    // Pending entries are created only for function_call items; keep that runtime
    // invariant visible after CanonicalOutputItem gains another opaque item type.
    if (call.added.item.type !== "function_call") continue;
    const item = { ...call.added.item, arguments: args } as typeof call.added.item;
    yield call.added;
    yield {
      type: "response.function_call_arguments.done",
      item_id: call.added.item.id,
      output_index: call.added.output_index,
      arguments: args,
    };
    yield { type: "response.output_item.done", output_index: call.added.output_index, item };
    pending.delete(key);
  }
  // The client-facing encoder requires a terminal frame, and usage is genuinely unknown here.
  yield { type: "response.completed", response: { ...snapshot, usage: null } };
}

/**
 * The stream went quiet without a terminal frame. A pending function call is still worth the
 * salvage rule above — the model may have finished writing it — but a turn with nothing pending
 * has only a partial answer to show for itself, and sealing that as `response.completed` would
 * present a truncated reply as a finished one. Failing is the honest outcome there.
 */
async function* failXaiSemanticStall(
  pending: Map<string, PendingXaiFunctionCall>,
  snapshot: CanonicalResponseSnapshot | undefined,
  semanticStallTimeoutMs: number,
  lastEventType: string | undefined,
  controller: AbortController,
): AsyncGenerator<CanonicalResponseEvent> {
  const reason = `upstream emitted no event for ${semanticStallTimeoutMs}ms`;
  wireLog("xai-responses.stream.stalled", {
    semanticStallTimeoutMs,
    pendingFunctionCalls: pending.size,
    lastEvent: lastEventType ?? null,
  });
  if (pending.size > 0) {
    yield* salvageXaiPendingCalls(pending, snapshot, reason, controller);
    return;
  }
  const error = xaiSemanticStallError(reason);
  // The upstream read is parked on a stream that stopped writing; aborting is what unwinds it.
  controller.abort(error);
  throw error;
}

function xaiSemanticStallError(reason: string): UpstreamProtocolError {
  return new UpstreamProtocolError(`Grok CLI ${reason}`);
}

/** The absorbed buffer, or the streamed `.done` payload, only when it is a complete JSON object. */
function completeXaiArguments(call: PendingXaiFunctionCall): string | undefined {
  const candidate = call.argumentsDone?.arguments ?? call.argumentsBuffer;
  if (candidate.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? candidate : undefined;
}

async function nextXaiEventBeforeDeadline(
  iterator: AsyncIterator<CanonicalResponseEvent>,
  deadlineAt: number,
): Promise<IteratorResult<CanonicalResponseEvent> | typeof XAI_ASSEMBLY_DEADLINE> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    return XAI_ASSEMBLY_DEADLINE;
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
      new Promise<typeof XAI_ASSEMBLY_DEADLINE>((resolve) => {
        timeout = setTimeout(() => {
          resolve(XAI_ASSEMBLY_DEADLINE);
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

/**
 * Grok's end-of-sequence marker, which this wire emits as ordinary assistant text
 * rather than as a control frame.
 *
 * Measured on a live turn: after the answer's own message item closed, the stream
 * opened a second message whose entire text was this marker, and it reached the
 * client as visible output. It is stripped from every text field rather than only
 * from a lone one, because a marker the model did not mean as prose is not prose
 * wherever it lands.
 *
 * The strip is per event. A marker split across two deltas would survive it, which
 * has not been observed — the upstream tokenizer emits it whole — and buffering the
 * text stream to cover that would cost every turn for a shape none has produced.
 */
const XAI_EOS_SENTINEL = "<|eos|>";

function withoutXaiSentinel(text: string): string {
  return text.includes(XAI_EOS_SENTINEL) ? text.split(XAI_EOS_SENTINEL).join("") : text;
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
          text: typeof part.text === "string" ? withoutXaiSentinel(part.text) : ""
        }
      };
    }
    case "response.output_text.delta": {
      const delta = withoutXaiSentinel(string(value.delta, "delta"));
      if (delta.length === 0) {
        return undefined;
      }
      return {
        type: value.type,
        item_id: string(value.item_id, "item_id"),
        output_index: number(value.output_index, "output_index"),
        content_index: number(value.content_index, "content_index"),
        delta
      };
    }
    case "response.output_text.done":
      return {
        type: value.type,
        item_id: string(value.item_id, "item_id"),
        output_index: number(value.output_index, "output_index"),
        content_index: number(value.content_index, "content_index"),
        text: withoutXaiSentinel(string(value.text, "text"))
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
    // Fragments still never reach the client — the assembler absorbs them and the `.done`
    // event carries the complete argument object. They are decoded rather than discarded
    // because this proxy has been measured ending a stream with the whole argument object
    // delivered as fragments and no terminal frame; the buffer is that turn's only copy.
    case "response.function_call_arguments.delta":
      return {
        type: value.type,
        item_id: string(value.item_id, "item_id"),
        output_index: number(value.output_index, "output_index"),
        delta: string(value.delta, "delta"),
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
  // The reasoning item is surfaced for one reason: its `encrypted_content`, which the client
  // carries back so the next turn does not re-derive this turn's thinking. The summary text is
  // already streamed as reasoning deltas, so nothing else here needs to reach the client.
  if (item.type === "reasoning") {
    const encrypted = typeof item.encrypted_content === "string" && item.encrypted_content.length > 0
      ? item.encrypted_content
      : undefined;
    if (encrypted === undefined) return undefined;
    return {
      id: typeof item.id === "string" ? item.id : "",
      type: "reasoning",
      encrypted_content: encrypted,
    };
  }
  return undefined;
}


/**
 * Anthropic's own name for the overload class, which the client-facing encoder forwards verbatim.
 *
 * A capacity refusal reaches this adapter with both class-bearing fields empty — measured as
 * `{"type":"error","code":null,"message":"The model is currently at capacity due to high
 * demand..."}` — so the projection below used to synthesize `api_error` and the class was gone
 * before `isRetryableXaiErrorType` ever saw it: an overload the retry path exists to absorb was
 * indistinguishable from a malformed request. The message is the only surviving discriminator,
 * so it is read here, at the one site that decides the class, rather than at each consumer.
 *
 * Naming it in Anthropic's vocabulary rather than xAI's earns the second half: when the single
 * retry also fails, the client is handed an error its own backoff recognizes instead of a flat
 * `api_error` that ends the turn.
 */
const XAI_OVERLOADED_ERROR_TYPE = "overloaded_error";
/** Deliberately narrow: a false positive costs one extra pre-commit attempt, nothing more. */
const XAI_CAPACITY_MESSAGE = /\bat capacity\b|\boverloaded\b/i;

function canonicalError(value: unknown): CanonicalError {
  const error = record(value, "error");
  const message = string(error.message, "error.message");
  return { type: xaiErrorType(error, message), message };
}

/** An upstream-declared class always wins; the message is consulted only where none was sent. */
function xaiErrorType(error: Record<string, unknown>, message: string): string {
  if (typeof error.type === "string" && error.type !== "error") return error.type;
  if (typeof error.code === "string") return error.code;
  return XAI_CAPACITY_MESSAGE.test(message) ? XAI_OVERLOADED_ERROR_TYPE : "api_error";
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
