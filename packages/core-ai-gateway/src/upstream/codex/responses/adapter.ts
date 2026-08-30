import { createHash } from "node:crypto";

import type {
  AdapterCallOptions,
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalError,
  CanonicalOutputItem,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CanonicalResponseSnapshot,
  CanonicalToolChoice,
  CanonicalUsage,
  CanonicalWebSearchAction,
  CanonicalWebSearchCallOutputItem,
  CanonicalWebSearchSource
} from "../../../canonical/index.js";
import {
  UpstreamBodyLimitError,
  UpstreamIdleTimeoutError,
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

// 전송 계층은 upstream-sse.ts와 공유한다. 기존 배럴 소비자를 위해 그대로 재수출한다.
export { UpstreamBodyLimitError, UpstreamIdleTimeoutError, UpstreamProtocolError };
export type { FetchLike };

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
/** ChatGPT 구독으로 Codex가 호출하는 백엔드. Platform API와 다른 표면이다. */
export const CHATGPT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_MAX_UPSTREAM_BODY_BYTES = 64 * 1024 * 1024;
/**
 * Longest the upstream may send no bytes at all before the read is abandoned.
 *
 * Calibrated against what the caller tolerates, not against how fast a short turn answers.
 * Claude Code's own byte-stream idle watchdog waits 300s, so anything tighter here converts a
 * turn the client was still willing to wait for into a failure the client never asked for.
 * Measured 2026-08-21 on a live session: 30s killed 20 turns whose upstream was simply thinking,
 * and the rate climbed through the session as the conversation grew and the gaps grew with it.
 */
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 300_000;
const CODEX_RETRY_DELAY_MS = 200;

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

const CLAUDE_CODE_SUGGESTION_MODE_PREFIX =
  "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]";

/**
 * OpenAI Responses wire shapes. The canonical model keeps `native_tools` as a
 * provider-neutral list and `tool_choice` as a small closed union that has no member
 * for a hosted tool selector, so this adapter's outbound payload is its own honest
 * type rather than a reuse of `CanonicalResponseRequest`. `native_tools` never reaches
 * the wire: it is merged into `tools`/`tool_choice` below and dropped.
 */
interface OpenAIResponsesWireFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

/**
 * Live-probe confirmed (HTTP 200, one `web_search_call` with 17 sources): the OpenAI Responses
 * hosted web search filter accepts either `allowed_domains` or `blocked_domains`, mirroring
 * Anthropic's own mutually-exclusive pair. `max_uses` still has no confirmed wire field and is dropped.
 */
interface OpenAIResponsesWireWebSearchTool {
  type: "web_search";
  filters?: { allowed_domains: string[] } | { blocked_domains: string[] };
}

type OpenAIResponsesWireTool = OpenAIResponsesWireFunctionTool | OpenAIResponsesWireWebSearchTool;

type OpenAIResponsesWireToolChoice = CanonicalToolChoice | { type: "web_search" };

type OpenAIResponsesWireRequest = Omit<
  CanonicalResponseRequest,
  "tools" | "tool_choice" | "native_tools"
> & {
  tools?: OpenAIResponsesWireTool[];
  tool_choice?: OpenAIResponsesWireToolChoice;
  /** Requests extra output fields, e.g. `web_search_call.action.sources` for hosted web search results. */
  include?: string[];
  /** Prefix-cache identity for the ChatGPT backend. See {@link codexSessionIdentity}. */
  prompt_cache_key?: string;
};

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

export class OpenAIResponsesAdapter implements AiGatewayAdapter {
  readonly capabilities = { nativeTools: ["web_search"] } as const;
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

  /**
   * Headers a subclass derives from the request itself, merged over the constructor's.
   * The base Platform API surface derives none.
   */
  protected perRequestHeaders(_request: CanonicalResponseRequest): Record<string, string> {
    return {};
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
    const payload = forOpenAIResponsesBackend(request, this.dropSamplingParams);
    // Exact JSON body sent upstream, including each tool's `parameters` and any `strict` flag.
    wireLog("openai.wire.request", { url: this.url, payload });
    let response: Response;

    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          ...this.extraHeaders,
          ...this.perRequestHeaders(request)
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      unlinkAbort();
      throw error;
    }

    if (!response.ok) {
      if (process.env.FLEET_AI_GATEWAY_DEBUG === "1") {
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

export interface CodexResponsesAdapterOptions {
  /** ChatGPT subscription account id; sent as the `chatgpt-account-id` header. */
  accountId?: string;
  /** 구독 경로가 요구하는 추가 헤더(예: originator). */
  headers?: Readonly<Record<string, string>>;
  fetch?: FetchLike;
  maxBodyBytes?: number;
  idleTimeoutMs?: number;
}

/**
 * Codex subscription-backend Responses adapter.
 *
 * The ChatGPT backend rejects the Platform API's sampling parameters and requires
 * `store: false`, so this adapter always drops them and always talks to
 * CHATGPT_CODEX_RESPONSES_URL. It is the runtime's Codex composition point; the
 * generic OpenAIResponsesAdapter remains for the public OpenAI surface.
 */
export class CodexResponsesAdapter extends OpenAIResponsesAdapter {
  private readonly isMarkedFetchFailure: (error: unknown) => boolean;

  constructor(options: CodexResponsesAdapterOptions = {}) {
    const fetchFailureTracker = createCodexFetchFailureTracker(options.fetch ?? globalThis.fetch.bind(globalThis));
    super({
      url: CHATGPT_CODEX_RESPONSES_URL,
      dropSamplingParams: true,
      headers: {
        ...(options.accountId ? { "chatgpt-account-id": options.accountId } : {}),
        ...options.headers,
      },
      fetch: fetchFailureTracker.fetch,
      // `!== undefined` 여야 명시적 0이 상속된 positiveInteger 검증을 통과한다.
      ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    });
    this.isMarkedFetchFailure = fetchFailureTracker.isMarkedFailure;
  }

  protected override perRequestHeaders(request: CanonicalResponseRequest): Record<string, string> {
    const sessionId = codexSessionIdentity(request);
    return sessionId === undefined ? {} : { session_id: sessionId };
  }

  override async stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions,
  ): Promise<AdapterResponse> {
    // 호출자 signal을 내부 per-call 컨트롤러로 옮긴다. 초기 super.stream도 이 컨트롤러의
    // signal로 호출해야 retry 래퍼가 abort했을 때 대기 중인 초기 read까지 즉시 취소된다.
    // 호출자 abort는 link로 계속 전파되고, 성공 응답은 소비자가 반복을 시작하기 전에
    // abort되지 않는다 — 컨트롤러는 래퍼의 return/throw 또는 생성기 종료 시점에만 abort된다.
    const callController = new AbortController();
    const unlinkCallAbort = linkAbortSignal(options.signal, callController);
    const callOptions = { ...options, signal: callController.signal };

    // 최대 2회 호출 예산. fetch-level UND_ERR_SOCKET retry가 이 예산을 소모하면
    // stream-level retry는 허용하지 않아 3번째 호출을 막는다.
    let retryAvailable = true;

    let response: AdapterResponse;
    try {
      response = await super.stream(request, callOptions);
    } catch (error) {
      if (!isRetryableCodexFetchSocketTermination(error, callOptions.signal, this.isMarkedFetchFailure)) {
        unlinkCallAbort();
        throw error;
      }
      // fetch-level retry 전에 예산을 소모한다. 이 뒤로 도착한 응답 스트림은
      // retry 없이 원본 순서로만 노출된다.
      retryAvailable = false;
      wireLog("codex.retry.discarded", {
        reason: "socket_termination",
        phase: "fetch",
      });
      try {
        await abortableDelay(CODEX_RETRY_DELAY_MS, callOptions.signal);
        response = await super.stream(request, callOptions);
      } catch (retryError) {
        unlinkCallAbort();
        throw retryError;
      }
    }
    if (!response.ok) {
      unlinkCallAbort();
      return response;
    }
    return {
      ...response,
      events: retryCodexStream(response.events, async (retrySignal) => {
        await abortableDelay(CODEX_RETRY_DELAY_MS, retrySignal);
        const retried = await super.stream(request, { ...callOptions, signal: retrySignal });
        if (!retried.ok) {
          throw new UpstreamProtocolError(`Codex retry failed with status ${retried.status}`);
        }
        return retried.events;
      }, callController, unlinkCallAbort, retryAvailable),
    };
  }
}

function retryCodexStream(
  events: AsyncIterable<CanonicalResponseEvent>,
  retry: (signal: AbortSignal) => Promise<AsyncIterable<CanonicalResponseEvent>>,
  callController: AbortController,
  unlinkCallAbort: () => void,
  retryAvailable: boolean,
): AsyncIterable<CanonicalResponseEvent> {
  return {
    [Symbol.asyncIterator]() {
      const source = events[Symbol.asyncIterator]();
      const iterator = generateCodexRetryStream(source, retry, callController, unlinkCallAbort, retryAvailable);
      return {
        next: () => iterator.next(),
        return: async () => {
          // 초기 스트림과 진행 중인 retry(지연/fetch) 모두 이 컨트롤러의 signal로
          // 실행되므로 하나의 abort로 전부 취소된다. caller signal은 stream()에서
          // 이미 callController에 연결되어 있어 여기서 다시 전파할 필요가 없다.
          callController.abort();
          return await iterator.return(undefined);
        },
        throw: async (error?: unknown) => {
          callController.abort(error);
          return await iterator.throw(error);
        },
      };
    },
  };
}

async function* generateCodexRetryStream(
  source: AsyncIterator<CanonicalResponseEvent>,
  retry: (signal: AbortSignal) => Promise<AsyncIterable<CanonicalResponseEvent>>,
  callController: AbortController,
  unlinkCallAbort: () => void,
  retryAvailable: boolean,
): AsyncGenerator<CanonicalResponseEvent> {
  // retry 확정 전까지 response.created/reasoning을 보류한다. 이 lead 이벤트들은 Anthropic
  // 변환에서 message_start/thinking으로 즉시 발화되므로, retry가 r2로 전환된 뒤에도 r1 헤더
  // 아래 r2 본문이 뒤섞이지 않도록 커밋(committing) 또는 terminal 이벤트에서 한꺼번에
  // 내보낸다. retry가 확정되면 보류분을 버리고 두 번째 attempt만 atomic하게 노출한다.
  //
  // 취소는 stream()이 만든 per-call 컨트롤러 하나로 통일한다. 초기 스트림과 retry
  // (지연/fetch) 모두 이 signal로 실행되므로 return/throw가 abort하면 대기 중인 read도
  // 즉시 풀린다. 호출자 abort는 컨트롤러 연결을 통해 같은 경로로 전파된다.
  //
  // retryAvailable=false면 (fetch-level retry가 이미 예산을 소모) stream-level retry를
  // 금지한다. created/reasoning/message setup은 보류하다가 그대로 노출하고, retryable
  // response.failed/error는 retry/pending 없이 원래 순서로 terminal로 통과시킨다.
  const bufferedLead: CanonicalResponseEvent[] = [];
  let yielded = false;
  let committedOutput = false;
  let pendingProviderError: CanonicalResponseEvent | undefined;
  try {
    while (true) {
      let result: IteratorResult<CanonicalResponseEvent>;
      try {
        result = await source.next();
      } catch (error) {
        if (yielded || callController.signal.aborted === true || !isUndiciSocketTermination(error)) {
          throw error;
        }
        if (!retryAvailable) {
          // 예산이 없으면 보류 lead를 원래 순서대로 내보낸 뒤 소켓 에러를 전파한다.
          yield* bufferedLead;
          bufferedLead.length = 0;
          throw error;
        }
        // 아직 아무것도 노출하지 않았다면 r1 lead 버퍼를 폐기하고 재시도한다. 소켓
        // termination은 canonical 이벤트가 없으므로 phase만 남기는 payload-free 진단.
        wireLog("codex.retry.discarded", {
          reason: "socket_termination",
          phase: "pre_commit",
        });
        bufferedLead.length = 0;
        yield* await retry(callController.signal);
        return;
      }
      if (result.done) {
        // attempt가 terminal 없이 끝나면 보류했던 created/reasoning을 원래 순서대로
        // 내보내고 종료한다(호출측 변환은 미완료 스트림으로 처리한다).
        yield* bufferedLead;
        bufferedLead.length = 0;
        if (pendingProviderError !== undefined) {
          yield pendingProviderError;
        }
        return;
      }
      const event = result.value;
      if (retryAvailable && isRetryableCodexServerFailure(event, committedOutput, callController.signal)) {
        // 폐기되는 response.failed가 게이트웨이 wrapper에 도달하기 전에 버려지므로 이
        // seam에서 증거를 남긴다. 직전에 대기 중인 retryable error도 함께 버려진다면
        // 둘 다(쌍) 남기고, 아니면 response.failed 단독을 남긴다.
        wireLog("codex.retry.discarded", pendingProviderError === undefined
          ? { reason: "response.failed", event }
          : { reason: "error_failed_pair", events: [pendingProviderError, event] });
        await source.return?.();
        bufferedLead.length = 0;
        yield* await retry(callController.signal);
        return;
      }
      if (pendingProviderError !== undefined) {
        const matchesFailurePair = event.type === "response.failed"
          && isRetryableCodexProviderErrorType(event.response.error.type)
          && callController.signal.aborted !== true
          && !committedOutput;
        if (matchesFailurePair) {
          await source.return?.();
          bufferedLead.length = 0;
          yield* await retry(callController.signal);
          return;
        }
        // 실패 쌍이 아니라면 대기 중이던 error를 terminal로 확정하고 보류분을 먼저 내보낸다.
        yield* bufferedLead;
        bufferedLead.length = 0;
        yield pendingProviderError;
        pendingProviderError = undefined;
        yielded = true;
        committedOutput = true;
      }
      if (retryAvailable && isRetryableCodexProviderError(event, committedOutput, callController.signal)) {
        pendingProviderError = event;
        continue;
      }
      if (commitsCodexOutput(event)) {
        // 출력을 확정하는 이벤트에 도달했으므로 보류 lead를 원래 순서대로 방출한다.
        yield* bufferedLead;
        bufferedLead.length = 0;
        yielded = true;
        committedOutput = true;
        yield event;
      } else {
        bufferedLead.push(event);
      }
    }
  } finally {
    callController.abort();
    unlinkCallAbort();
    await source.return?.();
  }
}

function isRetryableCodexServerFailure(
  event: CanonicalResponseEvent,
  committedOutput: boolean,
  signal?: AbortSignal,
): boolean {
  return signal?.aborted !== true
    && !committedOutput
    && event.type === "response.failed"
    && isRetryableCodexProviderErrorType(event.response.error.type);
}

function isRetryableCodexProviderError(
  event: CanonicalResponseEvent,
  committedOutput: boolean,
  signal?: AbortSignal,
): boolean {
  return signal?.aborted !== true
    && !committedOutput
    && event.type === "error"
    && isRetryableCodexProviderErrorType(event.error.type);
}

function isRetryableCodexProviderErrorType(type: string): boolean {
  return type === "server_error"
    || type === "server_is_overloaded"
    || type === "service_unavailable_error";
}

/** 출력을 확정하는(그 뒤로 retry가 금지되는) 이벤트인지 판정한다. false면 lead 버퍼에 보류된다. */
function commitsCodexOutput(event: CanonicalResponseEvent): boolean {
  switch (event.type) {
    case "response.created":
    case "response.reasoning_summary_text.delta":
      return false;
    // output_item.added(message)는 메시지 아이템의 시작을 알리는 설정 이벤트일 뿐,
    // Anthropic 변환에서 caller-visible 출력을 만들지 않는다. server_error retry를
    // 막지 않도록 lead 버퍼에 보류한다. function_call/web_search 추가와 message done은
    // 기존대로 출력을 확정한다.
    case "response.output_item.added":
      return event.item.type !== "message";
    default:
      return true;
  }
}

function createCodexFetchFailureTracker(fetchImpl: FetchLike): {
  fetch: FetchLike;
  isMarkedFailure: (error: unknown) => boolean;
} {
  const fetchFailures = new WeakSet<object>();
  return {
    fetch: async (input, init) => {
      try {
        return await fetchImpl(input, init);
      } catch (error) {
        if (error !== null && typeof error === "object") {
          fetchFailures.add(error);
        }
        throw error;
      }
    },
    isMarkedFailure: (error: unknown) =>
      error !== null && typeof error === "object" && fetchFailures.has(error),
  };
}

function isRetryableCodexFetchSocketTermination(
  error: unknown,
  signal: AbortSignal | undefined,
  isMarkedFailure: (error: unknown) => boolean,
): boolean {
  return signal?.aborted !== true
    && isMarkedFailure(error)
    && isUndiciSocketTermination(error);
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

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finishResolve, delayMs);
    function cleanup(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finishReject);
    }
    function finishResolve(): void {
      cleanup();
      resolve();
    }
    function finishReject(): void {
      cleanup();
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", finishReject, { once: true });
  });
}

function forOpenAIResponsesBackend(
  request: CanonicalResponseRequest,
  dropSamplingParams: boolean,
): OpenAIResponsesWireRequest {
  const source = dropSamplingParams ? forChatGptBackend(request) : { ...request };
  const {
    tools: canonicalTools,
    tool_choice: canonicalToolChoice,
    native_tools: nativeTools,
    ...rest
  } = source;
  const payload: OpenAIResponsesWireRequest = { ...rest };

  // Canonical-only input fields must never reach the wire. The Responses API rejects an
  // unknown input property with a 400 that fails the entire request — observed as
  // `Unknown parameter: 'input[N].reasoning_content'` — so every item is stripped here
  // rather than at each producer. `reasoning_content` is replay metadata only the Chat
  // Completions path consumes; this backend takes reasoning back as its own items.
  payload.input = request.input.map((item) => {
    const wireType = (item as { type?: unknown }).type;
    if (wireType === "compaction" || wireType === "compaction_trigger") {
      return item;
    }
    if (item.type === "function_call_output") {
      const {
        is_error: _isError,
        tool_references: _toolReferences,
        ...wireItem
      } = item;
      return wireItem;
    }
    const { reasoning_content: _reasoningContent, ...wireItem } = item as CanonicalResponseRequest["input"][number] & {
      reasoning_content?: string;
    };
    return wireItem;
  });

  const wireTools: OpenAIResponsesWireTool[] = (canonicalTools ?? []).map((tool) => {
    const { defer_loading: _deferLoading, ...wireTool } = tool;
    // A schema outside strict mode's subset is rejected with a 400 that fails the whole
    // request, not just that tool, so an incompatible tool keeps its original schema and
    // forfeits the guarantee rather than taking every other tool down with it.
    if (!strictCompatible(wireTool.parameters)) return wireTool;
    return {
      ...wireTool,
      parameters: strictParameters(wireTool.parameters),
      strict: true,
    };
  });

  // native_tools is canonical-only: it must never reach the OpenAI wire body as-is.
  // Provider-owned web search is merged into `tools` as a hosted tool selector instead.
  let requiresHostedWebSearch = false;
  let hasHostedWebSearch = false;
  for (const nativeTool of nativeTools ?? []) {
    const webSearchTool: OpenAIResponsesWireWebSearchTool = { type: "web_search" };
    if (nativeTool.allowed_domains !== undefined && nativeTool.allowed_domains.length > 0) {
      webSearchTool.filters = { allowed_domains: [...nativeTool.allowed_domains] };
    } else if (nativeTool.blocked_domains !== undefined && nativeTool.blocked_domains.length > 0) {
      webSearchTool.filters = { blocked_domains: [...nativeTool.blocked_domains] };
    }
    // max_uses has no confirmed OpenAI Responses wire field. Dropping it here
    // (rather than inventing a shape) is deliberate; allowed/blocked_domains are anthropic's
    // own mutually-exclusive pair, so translateAnthropicTools rejects requests that set both.
    wireTools.push(webSearchTool);
    hasHostedWebSearch = true;
    if (nativeTool.required === true) {
      requiresHostedWebSearch = true;
    }
  }

  if (wireTools.length > 0) {
    payload.tools = wireTools;
  }

  if (requiresHostedWebSearch) {
    payload.tool_choice = { type: "web_search" };
  } else if (canonicalToolChoice !== undefined) {
    payload.tool_choice = canonicalToolChoice;
  }

  // Hosted web search only reports its sources when explicitly requested via `include`.
  // Without this, `response.output_item.done` for `web_search_call` arrives with no `action.sources`.
  if (hasHostedWebSearch) {
    const rawInclude = (source as { include?: unknown }).include;
    const existingInclude = Array.isArray(rawInclude)
      ? rawInclude.filter((entry): entry is string => typeof entry === "string")
      : [];
    payload.include = Array.from(new Set([...existingInclude, "web_search_call.action.sources"]));
  }

  return payload;
}

/**
 * The ChatGPT backend's prefix cache is reached by request identity, not by the prefix alone.
 *
 * Measured against `gpt-5.6-luna` over three fresh ~7.9k-token prefixes replayed for eight
 * turns each (21 warm turns per arm): the bare request the gateway used to send hit the cache
 * on 8 of 21 turns, and adding `prompt_cache_key` alone changed nothing (8/21). Sending the
 * `session_id` request header moved it to 19/21 — the same rate as replaying codex-rs's whole
 * identity header set. So the sticky routing this backend performs keys on that header, and a
 * request without it is load-balanced away from the machine holding its own prefix.
 *
 * `prompt_cache_key` is sent alongside because it is the documented Responses field for this
 * purpose and codex-rs sends it; it simply is not what makes the difference here.
 *
 * The identity has to be the caller's conversation, not this adapter's lifetime — a gateway
 * builds one adapter per request. Claude Code's `metadata.user_id` is stable for a session and
 * is already the Cursor path's session source (`resolveCursorSessionIdentity`). A caller that
 * sends none keeps the un-pinned behavior rather than being handed a fresh identity per turn,
 * which would pin every turn to a different machine and be strictly worse than sending nothing.
 */
function codexSessionIdentity(request: CanonicalResponseRequest): string | undefined {
  const userId = request.metadata?.user_id?.trim();
  if (!userId) return undefined;
  const digest = createHash("sha256")
    .update("fleet:codex:claude-session:")
    .update(userId)
    .digest("hex");
  // UUID-shaped, as codex-rs's own `session_id` is. Deterministic, so the same conversation
  // reaches the same value across the per-request adapters a gateway constructs.
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

function forChatGptBackend(request: CanonicalResponseRequest): CanonicalResponseRequest {
  const copy: Record<string, unknown> = { ...request };
  for (const field of CHATGPT_UNSUPPORTED_FIELDS) {
    delete copy[field];
  }
  // Derived before `metadata` is dropped below: this backend rejects the field itself
  // ("Unsupported parameter"), but the caller identity inside it is what reaches the cache.
  const sessionId = codexSessionIdentity(request);
  if (sessionId !== undefined) {
    copy.prompt_cache_key = sessionId;
  }
  if (request.tool_choice === "none" || isClaudeCodeSuggestionMode(request)) {
    // 명시적 no-tools 요청과 Claude Code Suggestion turn은 이 stateless backend에 tool
    // metadata를 재전송하지 않는다. 전자는 caller의 정확한 선택이고 후자는 합법적인 tool action이 없다.
    delete copy.tools;
    delete copy.tool_choice;
    delete copy.native_tools;
    delete copy.parallel_tool_calls;
  }
  // 백엔드가 명시적으로 요구한다: 생략하면 400 "Store must be set to false".
  copy.store = false;
  return copy as unknown as CanonicalResponseRequest;
}

function isClaudeCodeSuggestionMode(request: CanonicalResponseRequest): boolean {
  const last = request.input.at(-1);
  return last?.type === "message"
    && last.role === "user"
    && typeof last.content === "string"
    && last.content.startsWith(CLAUDE_CODE_SUGGESTION_MODE_PREFIX);
}

type ReadOptions = UpstreamReadOptions;

function parseOpenAIEventStream(
  body: ReadableStream<Uint8Array> | null,
  options: ReadOptions & { onClose: () => void }
): AsyncGenerator<CanonicalResponseEvent> {
  return parseUpstreamSseStream(
    body,
    { ...options, missingBodyMessage: "OpenAI streaming response had no body" },
    parseEventFrame,
  );
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
      `OpenAI SSE contained invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  // Raw provider payload before the event-name type fallback and canonical filtering.
  logRawWireEvent("openai.wire.event", eventName, parsed);
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
    // Argument deltas are dropped: a partial JSON fragment cannot have its nulls stripped, and
    // forwarding raw fragments would let the client reassemble the un-stripped text. The `.done`
    // event below carries the whole argument object, which downstream treats as the remainder
    // when nothing was streamed ahead of it.
    case "response.function_call_arguments.delta":
      return undefined;
    case "response.function_call_arguments.done":
      return {
        type: value.type,
        item_id: string(value.item_id, "item_id"),
        output_index: number(value.output_index, "output_index"),
        arguments: stripNullArguments(string(value.arguments, "arguments"))
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
  // parent totals and total_tokens as their sum, but the ChatGPT subscription backend's
  // real envelopes have not been observed to guarantee that arithmetic. Reject only
  // malformed shape (wrong type / negative / non-finite) here; a self-inconsistent but
  // well-typed envelope is preserved as-is on the canonical event rather than failing the
  // whole response. reasoning_tokens/total_tokens never reach the Anthropic wire at all.
  // cached_tokens/cache_write_tokens do reach it when consistent with input_tokens, but the
  // Anthropic conversion layer (see toAnthropicCacheAwareUsage in anthropic.ts) falls back
  // to the authoritative parent input total with no cache breakdown when the two exceed it,
  // rather than inventing a read-over-write truncation priority.

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cached_input_tokens: cachedInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cache_write_input_tokens: cacheWriteInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoning_output_tokens: reasoningOutputTokens }),
    ...(totalTokens === undefined ? {} : { total_tokens: totalTokens })
  };
}

/**
 * OpenAI strict mode admits no optional property: every key must appear in `required`, and
 * "not provided" is expressed as an explicit null rather than omission.
 *
 * Without it the model fabricates values for omitted optional fields — empty strings for
 * free-form strings, an arbitrary member for enums — and those reach the client as real
 * arguments. A fabricated `Agent.model` silently overrides the subagent's pinned model, and a
 * fabricated `Read.pages` fails the call outright.
 *
 * `stripNullArguments` is the inverse: the nulls this transform makes representable are
 * removed again before the call reaches the client, restoring omission semantics.
 */
/**
 * Keywords known to survive strict mode. An allowlist rather than a denylist: an unknown
 * keyword is far more likely to be one strict rejects than one it accepts, and the cost is
 * asymmetric — an over-strict verdict costs a single tool its guarantee, while a wrong
 * permissive verdict costs the whole request a 400 that fails every tool with it.
 */
const STRICT_ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "anyOf",
  "$defs",
  "$ref",
  "description",
  "title",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  // Dropped by `strictSchema` before the schema reaches the wire.
  "$schema",
  "default",
  "format",
]);

/** Whether every subschema stays inside the subset strict mode accepts. */
function strictCompatible(schema: unknown): boolean {
  if (!isRecord(schema)) return true;

  for (const key of Object.keys(schema)) {
    if (!STRICT_ALLOWED_KEYWORDS.has(key)) return false;
  }
  // Strict mode requires every subschema to declare what it accepts.
  if (!("type" in schema) && !Array.isArray(schema.anyOf) && typeof schema.$ref !== "string") {
    return false;
  }
  // A free-form object cannot satisfy strict mode, which requires every key to be declared
  // with `additionalProperties: false`; an array must say what it holds.
  if (schema.type === "object" && !isRecord(schema.properties)) return false;
  if (schema.type === "array" && !isRecord(schema.items)) return false;

  if (isRecord(schema.properties)) {
    for (const value of Object.values(schema.properties)) {
      if (!strictCompatible(value)) return false;
    }
  }
  if (isRecord(schema.$defs)) {
    for (const value of Object.values(schema.$defs)) {
      if (!strictCompatible(value)) return false;
    }
  }
  if (isRecord(schema.items) && !strictCompatible(schema.items)) return false;
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) {
      if (!strictCompatible(branch)) return false;
    }
  }
  return true;
}

function strictParameters(schema: Record<string, unknown>): Record<string, unknown> {
  const converted = strictSchema(schema);
  return isRecord(converted) ? converted : schema;
}

function strictSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const next: Record<string, unknown> = { ...schema };

  // Metadata strict mode has no use for: `$schema` is a dialect marker it does not accept, and
  // `default` is meaningless once every property is required. `format` is validated against a
  // closed set of values strict mode enumerates — `uri` (WebFetch.url) is rejected with a
  // request-wide 400 — so the advisory hint is stripped rather than gambling the request on it.
  delete next.$schema;
  delete next.default;
  delete next.format;

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = next[key];
    if (Array.isArray(branches)) next[key] = branches.map(strictSchema);
  }
  if (isRecord(next.items)) next.items = strictSchema(next.items);
  if (isRecord(next.$defs)) {
    const rewrittenDefs: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(next.$defs)) {
      rewrittenDefs[name] = strictSchema(value);
    }
    next.$defs = rewrittenDefs;
  }

  const properties = next.properties;
  if (isRecord(properties)) {
    const required = new Set(
      Array.isArray(next.required)
        ? next.required.filter((name): name is string => typeof name === "string")
        : [],
    );
    const rewritten: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(properties)) {
      const child = strictSchema(value);
      rewritten[name] = required.has(name) ? child : nullableSchema(child);
    }
    next.properties = rewritten;
    next.required = Object.keys(rewritten);
    next.additionalProperties = false;
  }
  return next;
}

/**
 * Widens a schema so an explicit null is valid, which is how strict mode spells "absent".
 *
 * Naming that null in each property's description was measured and dropped: it changed
 * nothing. Under strict mode a model still supplies the default quoted in the description
 * rather than declining, and the instruction only grew the tool catalog. What strict does buy
 * is that a value the model was told not to send is now omittable at all — which is what
 * stopped `Agent.model` from overriding a pinned subagent model.
 */
function nullableSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const next: Record<string, unknown> = { ...schema };

  if (Array.isArray(next.enum) && !next.enum.includes(null)) {
    next.enum = [...next.enum, null];
  }
  if (Array.isArray(next.anyOf)) {
    next.anyOf = [...next.anyOf, { type: "null" }];
    return next;
  }
  const type = next.type;
  if (typeof type === "string") {
    if (type !== "null") next.type = [type, "null"];
  } else if (Array.isArray(type)) {
    if (!type.includes("null")) next.type = [...type, "null"];
  }
  return next;
}

/**
 * Removes the nulls strict mode requires, so the client sees an omitted argument rather than
 * an explicit null. Anthropic tool schemas treat absence — not null — as "not provided".
 */
function stripNullArguments(raw: string): string {
  if (raw.length === 0 || !raw.includes("null")) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!isRecord(parsed)) return raw;
  return JSON.stringify(withoutNulls(parsed));
}

function withoutNulls(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) continue;
    out[key] = withoutNullMembers(entry);
  }
  return out;
}

// strict 재작성의 정확한 역변환: 재작성이 표현 가능하게 만든 것은 객체 프로퍼티 위치의
// null뿐이므로 배열 속 객체까지 내려가 그 null만 제거하고, 배열 원소 자체의 null은
// 재작성이 만든 값이 아니라 모델이 실제로 보낸 데이터이므로 보존한다.
function withoutNullMembers(entry: unknown): unknown {
  if (isRecord(entry)) return withoutNulls(entry);
  if (Array.isArray(entry)) return entry.map(withoutNullMembers);
  return entry;
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
      arguments: typeof item.arguments === "string" ? stripNullArguments(item.arguments) : ""
    };
  }
  if (item.type === "compaction" || item.type === "compaction_summary") {
    return {
      type: "compaction",
      ...(typeof item.id === "string" ? { id: item.id } : {}),
      encrypted_content: string(item.encrypted_content, "item.encrypted_content"),
    };
  }
  if (item.type === "web_search_call") {
    const result: CanonicalWebSearchCallOutputItem = {
      id: string(item.id, "item.id"),
      type: "web_search_call"
    };
    if (typeof item.status === "string") {
      result.status = item.status;
    }
    const action = webSearchAction(item.action);
    if (action !== undefined) {
      result.action = action;
    }
    return result;
  }
  return undefined;
}

/** Parses the OpenAI live `web_search_call.action` shape leniently: unknown/missing fields are just omitted. */
function webSearchAction(value: unknown): CanonicalWebSearchAction | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  const action: CanonicalWebSearchAction = { type: value.type };
  if (typeof value.query === "string") {
    action.query = value.query;
  }
  if (Array.isArray(value.queries)) {
    const queries = value.queries.filter((entry): entry is string => typeof entry === "string");
    if (queries.length > 0) {
      action.queries = queries;
    }
  }
  if (typeof value.url === "string") {
    action.url = value.url;
  }
  if (typeof value.pattern === "string") {
    action.pattern = value.pattern;
  }
  const sources = webSearchSources(value.sources);
  if (sources !== undefined) {
    action.sources = sources;
  }
  return action;
}

/** Invalid or incomplete source entries are dropped, never fabricated with placeholder values. */
function webSearchSources(value: unknown): CanonicalWebSearchSource[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sources: CanonicalWebSearchSource[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.url !== "string" || entry.url.length === 0) {
      continue;
    }
    const source: CanonicalWebSearchSource = {
      type: typeof entry.type === "string" ? entry.type : "url",
      url: entry.url
    };
    if (typeof entry.title === "string" && entry.title.length > 0) {
      source.title = entry.title;
    }
    sources.push(source);
  }
  return sources.length > 0 ? sources : undefined;
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
