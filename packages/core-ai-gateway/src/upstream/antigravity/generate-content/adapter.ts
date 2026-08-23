import { randomUUID } from "node:crypto";

import type {
  AdapterCallOptions,
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalFunctionTool,
  CanonicalResponseRequest,
} from "../../../canonical/index.js";
import {
  linkAbortSignal,
  parseSseFrameFields,
  parseUpstreamSseStream,
  positiveInteger,
  readBoundedBody,
  type FetchLike,
  type UpstreamReadOptions,
} from "../../../transport/upstream-sse.js";
import { wireLog } from "../../../transport/wire-log.js";
import { ANTIGRAVITY_DAILY_API, antigravityUserAgent } from "../credentials.js";
import {
  createAntigravityCodeAssistCache,
  type AntigravityCodeAssistCache,
} from "../code-assist.js";
import {
  buildAntigravityEnvelope,
  createAntigravitySignatureLedger,
  createToolNameCodec,
  type AntigravitySignatureLedger,
} from "./wire.js";
import { parseAntigravityFrame, translateAntigravityStream } from "./stream.js";

/**
 * Cloud Code Assist's streaming turn endpoint.
 *
 * `?alt=sse` is what turns the RPC into an event stream; without it the same path
 * answers with one buffered JSON document.
 */
export const ANTIGRAVITY_STREAM_URL =
  `${ANTIGRAVITY_DAILY_API}/v1internal:streamGenerateContent?alt=sse`;

export const DEFAULT_ANTIGRAVITY_MAX_UPSTREAM_BODY_BYTES = 64 * 1024 * 1024;

/** Upstream statuses that mean "this credential", not "this request". */
const AUTH_REJECTION_STATUS: ReadonlySet<number> = new Set([401, 403]);

/**
 * Let go of a response nothing will read.
 *
 * The upstream gate holds a per-origin permit until the body ends, so a response
 * that is replaced rather than consumed holds its permit for the life of the
 * process. One abandoned rejection per renewal is enough to retire the ceiling
 * into a queue nothing leaves, and at `maxUpstreamInFlight: 1` the very retry
 * that abandoned it would wait behind its own permit until the queue times out.
 */
async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Longest the upstream may send nothing at all before the read is abandoned.
 *
 * Taken from what the caller tolerates rather than from how fast a short turn
 * answers: Claude Code's own byte-stream idle watchdog waits 300s, and a tighter
 * bound here converts a turn the client was still willing to wait for into a
 * failure it never asked for. This wire is quiet while the model thinks — a
 * high-effort Gemini turn spent 542 reasoning tokens before its first visible
 * byte — so the gap is real traffic, not a stall.
 */
export const DEFAULT_ANTIGRAVITY_UPSTREAM_IDLE_TIMEOUT_MS = 300_000;

export interface AntigravityGenerateContentAdapterOptions {
  readonly fetch?: FetchLike;
  readonly maxBodyBytes?: number;
  readonly idleTimeoutMs?: number;
  /** Overrides onboarding discovery; tests use it to avoid the extra round trip. */
  readonly project?: string;
  readonly codeAssist?: AntigravityCodeAssistCache;
  readonly signatureLedger?: AntigravitySignatureLedger;
  /**
   * Renew the subscription credential and return the fresh token.
   *
   * Cloud Code Assist can reject a token before the expiry the local store
   * records — a session revoked or rotated server-side. Without this the reader
   * keeps calling that same token healthy, so every turn fails until the
   * recorded expiry finally passes. The quota probe already retries behind a
   * forced renewal; this is the same contract for a turn.
   */
  readonly renewCredential?: () => Promise<string | null>;
}

/**
 * Antigravity's Cloud Code Assist wire.
 *
 * The backend is neither OpenAI-shaped nor Anthropic-shaped: it takes a Gemini
 * `generateContent` body wrapped in a client envelope that names the IDE, the
 * request type, and the billing project. That is why this provider gets an
 * adapter of its own rather than reusing the Responses or Chat Completions paths.
 */
export class AntigravityGenerateContentAdapter implements AiGatewayAdapter {
  readonly capabilities = {} as const;
  private readonly fetchImpl: FetchLike;
  private readonly maxBodyBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly project: string | undefined;
  private readonly codeAssist: AntigravityCodeAssistCache;
  private readonly ledger: AntigravitySignatureLedger;
  private readonly renewCredential: (() => Promise<string | null>) | undefined;

  constructor(options: AntigravityGenerateContentAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.maxBodyBytes = options.maxBodyBytes === undefined
      ? DEFAULT_ANTIGRAVITY_MAX_UPSTREAM_BODY_BYTES
      : positiveInteger(options.maxBodyBytes, "maxBodyBytes");
    this.idleTimeoutMs = options.idleTimeoutMs === undefined
      ? DEFAULT_ANTIGRAVITY_UPSTREAM_IDLE_TIMEOUT_MS
      : positiveInteger(options.idleTimeoutMs, "idleTimeoutMs");
    this.project = options.project;
    this.codeAssist = options.codeAssist ?? createAntigravityCodeAssistCache();
    // The ledger outlives one turn on purpose: it is the fallback for a client
    // that dropped the thinking block carrying a call's signature.
    this.ledger = options.signatureLedger ?? createAntigravitySignatureLedger();
    this.renewCredential = options.renewCredential;
  }

  async stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions,
  ): Promise<AdapterResponse> {
    const controller = new AbortController();
    const unlink = linkAbortSignal(options.signal, controller);
    const codec = createToolNameCodec();
    // Onboarding is cached and single-flight; a failed read leaves the field off
    // the envelope, which the wire accepts (verified 2026-08-22).
    const project = this.project
      ?? (await this.codeAssist.read(this.fetchImpl as typeof fetch, options.apiKey, controller.signal)).projectId;
    const envelope = buildAntigravityEnvelope(request, {
      ...(project === undefined ? {} : { project }),
      requestId: `agent-${randomUUID()}`,
      codec,
      ledger: this.ledger,
    });
    // Payload-free counters. `replayedSignatures` against `replayableCalls` is the
    // only way to see the one failure this wire punishes hardest: a `functionCall`
    // replayed without the blob upstream issued for it is a hard 400, and without
    // this the log would show a failed turn with no visible cause. The blobs
    // themselves are never recorded — only how many of the calls that needed one
    // actually carried one.
    const replayable = envelope.request.contents.flatMap((content) =>
      content.role === "model" ? content.parts.filter((part) => part.functionCall !== undefined) : []);
    wireLog("antigravity.wire.request", {
      url: ANTIGRAVITY_STREAM_URL,
      model: envelope.model,
      hasProject: project !== undefined,
      contents: envelope.request.contents.length,
      replayableCalls: replayable.length,
      replayedSignatures: replayable.filter((part) => part.thoughtSignature !== undefined).length,
      tools: envelope.request.tools?.[0].functionDeclarations.length ?? 0,
      toolConfig: envelope.request.toolConfig,
      generationConfig: envelope.request.generationConfig,
    });

    const body = JSON.stringify(envelope);
    const send = (token: string): Promise<Response> => this.fetchImpl(ANTIGRAVITY_STREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
        "User-Agent": antigravityUserAgent(),
      },
      body,
      signal: controller.signal,
    });

    let response: Response;
    try {
      response = await send(options.apiKey);
      // One retry, and only behind a token the renewal actually changed: a
      // rejection that survives a fresh credential is about this request, and
      // re-sending it would spend a second turn to learn the same thing.
      if (AUTH_REJECTION_STATUS.has(response.status) && this.renewCredential) {
        const renewed = await this.renewCredential().catch(() => null);
        if (renewed && renewed !== options.apiKey) {
          wireLog("antigravity.wire.auth_retry", { status: response.status });
          await discardResponseBody(response);
          response = await send(renewed);
        }
      }
    } catch (error) {
      unlink();
      throw error;
    }

    const readOptions: UpstreamReadOptions = {
      controller,
      idleTimeoutMs: this.idleTimeoutMs,
      maxBodyBytes: this.maxBodyBytes,
    };

    if (!response.ok) {
      try {
        return {
          ok: false,
          status: response.status,
          headers: response.headers,
          body: await readBoundedBody(response.body, readOptions),
        };
      } finally {
        unlink();
      }
    }

    const frames = parseUpstreamSseStream(response.body, {
      ...readOptions,
      onClose: unlink,
      missingBodyMessage: "Antigravity response had no body",
    }, (frame) => parseAntigravityFrame(parseSseFrameFields(frame).data));

    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      events: translateAntigravityStream(frames, {
        codec,
        ledger: this.ledger,
        model: request.model,
        // The envelope's own request id is already unique per request.
        callIdPrefix: envelope.requestId,
      }),
    };
  }

  /**
   * Every declared tool is serialized: this wire has no deferred-loading contract
   * to honour, so the pre-flight estimate measures exactly what is sent.
   */
  wireTools(request: CanonicalResponseRequest): readonly CanonicalFunctionTool[] {
    return request.tools ?? [];
  }
}
