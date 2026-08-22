import { randomUUID } from "node:crypto";

import type {
  AdapterCallOptions,
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalFunctionTool,
  CanonicalResponseRequest,
} from "../../canonical/index.js";
import {
  linkAbortSignal,
  parseSseFrameFields,
  parseUpstreamSseStream,
  positiveInteger,
  readBoundedBody,
  type FetchLike,
  type UpstreamReadOptions,
} from "../../transport/upstream-sse.js";
import { wireLog } from "../../transport/wire-log.js";
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

    let response: Response;
    try {
      response = await this.fetchImpl(ANTIGRAVITY_STREAM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${options.apiKey}`,
          "User-Agent": antigravityUserAgent(),
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
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
