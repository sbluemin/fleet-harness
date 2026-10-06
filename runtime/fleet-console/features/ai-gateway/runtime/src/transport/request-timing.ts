import { nextEventBoundary, parseSseFrameFields } from "./upstream-sse.js";
import { createBoundedJsonlWriter } from "./bounded-jsonl.js";
import type { GatewayProxyResponse } from "../router/http.js";

export const DEFAULT_REQUEST_TIMING_JOURNAL_MAX_BYTES = 16 * 1024 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canCarryBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}

export interface GatewayRequestTimingRecord {
  /** t0: 메서드·호출자 자격 판정 뒤, body 읽기 전(router.ts). 소켓 도착 시각이 아니다. */
  readonly ts: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly route: "passthrough" | "translated" | "compaction" | "refused";
  readonly stream?: boolean;
  readonly tools?: boolean;
  readonly maxTokens?: number;
  readonly status?: number;
  readonly outcome: "ok" | "error" | "disconnect";
  readonly responseId?: string;
  readonly gate?: {
    readonly inFlight: number;
    readonly queued: number;
  };
  readonly upstreamCalls?: number;
  readonly ms: {
    readonly bodyRead?: number;
    readonly credential?: number;
    readonly upstreamStart?: number;
    readonly upstreamRestart?: number;
    readonly upstreamHeaders?: number;
    /** 응답 body 첫 chunk(제어 프레임일 수 있음)가 도착한 시각. */
    readonly upstreamFirstByte?: number;
    readonly downstreamHeaders?: number;
    readonly messageStart?: number;
    readonly thinkingBlockStart?: number;
    readonly contentBlockStart?: number;
    readonly contentBlockStop?: number;
    readonly firstDelta?: number;
    readonly end?: number;
  };
  readonly contentBlockKind?: "text" | "tool_use";
  readonly firstDeltaKind?: "thinking" | "text" | "tool_input";
  readonly upstreamChunksBeforeContent?: number;
  readonly keepalivesBeforeContent?: number;
}

export type GatewayRequestTimingSink = (record: GatewayRequestTimingRecord) => void;

export interface RequestTimingJournalOptions {
  readonly filePath: string;
  readonly maxBytes?: number;
}

export interface RequestTimingJournal {
  readonly write: GatewayRequestTimingSink;
  flush(): Promise<void>;
}

export function createRequestTimingJournal(
  options: RequestTimingJournalOptions,
): RequestTimingJournal {
  const writer = createBoundedJsonlWriter({
    filePath: options.filePath,
    maxBytes: options.maxBytes ?? DEFAULT_REQUEST_TIMING_JOURNAL_MAX_BYTES,
  });

  return {
    write: (record) => writer.write(record),
    flush: () => writer.flush(),
  };
}

export function ensureUuidSessionId(id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  const candidate = id.trim();
  return UUID_PATTERN.test(candidate) ? candidate : undefined;
}

function extractOrigin(input: string | URL | Request): string {
  try {
    if (typeof input === "string") return new URL(input).origin;
    if (input instanceof URL) return input.origin;
    if (typeof input === "object" && input !== null && "url" in input) {
      return new URL((input as { url: string }).url).origin;
    }
  } catch {}
  return "";
}

/**
 * Tracks request lifecycle milestones relative to t0 and serializes a timing record.
 * Internal to the ai-gateway router; not exported through public facade.
 */
export class RequestClock {
  /** t0: 메서드·호출자 자격 판정 뒤, body 읽기 전. 소켓 도착 시각이 아니다. */
  private readonly t0: number = Date.now();
  private readonly sink: GatewayRequestTimingSink;
  private readonly getGateStats?: (origin: string) => { inFlight: number; queued: number } | undefined;

  private sessionId?: string;
  private model?: string;
  private provider?: string;
  private route: "passthrough" | "translated" | "compaction" | "refused" = "refused";
  private stream?: boolean;
  private tools?: boolean;
  private maxTokens?: number;
  private status?: number;
  private outcome?: "ok" | "error" | "disconnect";
  private responseId?: string;
  private gate?: { inFlight: number; queued: number };
  private upstreamCalls = 0;
  private upstreamChunksBeforeContent = 0;
  private keepalivesBeforeContent = 0;
  private contentBlockKind?: "text" | "tool_use";
  private firstDeltaKind?: "thinking" | "text" | "tool_input";

  private bodyReadMs?: number;
  private credentialMs?: number;
  private upstreamStartMs?: number;
  private upstreamRestartMs?: number;
  private upstreamHeadersMs?: number;
  private upstreamFirstByteMs?: number;
  private downstreamHeadersMs?: number;
  private messageStartMs?: number;
  private thinkingBlockStartMs?: number;
  private contentBlockStartMs?: number;
  private contentBlockStopMs?: number;
  private firstDeltaMs?: number;
  private endMs?: number;

  private sseBuffer = "";
  private parsingDone = false;
  private targetContentBlockIndex?: number;
  private finished = false;

  constructor(
    sink: GatewayRequestTimingSink,
    getGateStats?: (origin: string) => { inFlight: number; queued: number } | undefined,
  ) {
    this.sink = sink;
    this.getGateStats = getGateStats;
  }

  elapsedMs(): number {
    return Math.max(0, Date.now() - this.t0);
  }

  markBodyRead(): void {
    if (this.bodyReadMs === undefined) {
      this.bodyReadMs = this.elapsedMs();
    }
  }

  markCredential(): void {
    if (this.credentialMs === undefined) {
      this.credentialMs = this.elapsedMs();
    }
  }

  setRequestBody(
    body: {
      model?: string;
      stream?: boolean;
      tools?: unknown;
      max_tokens?: unknown;
    },
    requestedModel?: string,
    sessionIdCandidate?: string,
  ): void {
    const sid = ensureUuidSessionId(sessionIdCandidate);
    if (sid) this.sessionId = sid;
    if (requestedModel) {
      this.model = requestedModel;
    } else if (typeof body.model === "string") {
      this.model = body.model;
    }
    this.stream = body.stream === true;
    this.tools = Array.isArray(body.tools) && body.tools.length > 0;
    if (typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)) {
      this.maxTokens = body.max_tokens;
    }
  }

  setRoute(route: "passthrough" | "translated" | "compaction" | "refused"): void {
    this.route = route;
  }

  setTarget(target: { id?: string; provider?: string }): void {
    if (target.provider) this.provider = target.provider;
    if (target.id) this.model = target.id;
  }

  wrapFetch(fetchImpl: typeof fetch): typeof fetch {
    return async (input, init) => {
      this.upstreamCalls += 1;
      const isFirstCall = this.upstreamCalls === 1;
      if (isFirstCall) {
        this.upstreamStartMs = this.elapsedMs();
        if (this.getGateStats) {
          const origin = extractOrigin(input);
          const stats = this.getGateStats(origin);
          if (stats) this.gate = stats;
        }
      } else {
        this.upstreamRestartMs = this.elapsedMs();
      }

      const res = await fetchImpl(input, init);

      if (isFirstCall) {
        this.upstreamHeadersMs = this.elapsedMs();
      }

      if (res.body !== null && canCarryBody(res.status) && typeof res.body.getReader === "function") {
        let firstChunk = true;
        const reader = res.body.getReader();
        const wrappedStream = new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            try {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              if (firstChunk) {
                firstChunk = false;
                if (this.upstreamFirstByteMs === undefined) {
                  this.upstreamFirstByteMs = this.elapsedMs();
                }
              }
              if (this.contentBlockStartMs === undefined) {
                this.upstreamChunksBeforeContent += 1;
              }
              controller.enqueue(value);
            } catch (err) {
              controller.error(err);
              throw err;
            }
          },
          cancel: (reason) => reader.cancel(reason),
        });

        return new Response(wrappedStream, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }

      return res;
    };
  }

  observe(res: GatewayProxyResponse): void {
    const originalWriteHead = res.writeHead.bind(res);
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.writeHead = (status: number, headers: Record<string, string>) => {
      if (this.downstreamHeadersMs === undefined) {
        this.downstreamHeadersMs = this.elapsedMs();
        this.status = status;
      }
      return originalWriteHead(status, headers);
    };

    const decoder = new TextDecoder();

    res.write = (chunk: Uint8Array): boolean => {
      if (!this.parsingDone) {
        try {
          const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
          this.processDownstreamText(text);
        } catch {
          // Ignore parsing errors
        }
      }
      return originalWrite(chunk);
    };

    res.end = (body?: string) => {
      if (!this.parsingDone && body) {
        try {
          this.processDownstreamText(body);
        } catch {}
      }
      return originalEnd(body);
    };
  }

  private processDownstreamText(text: string): void {
    this.sseBuffer += text;
    let boundary = nextEventBoundary(this.sseBuffer);
    while (boundary !== undefined) {
      const frame = this.sseBuffer.slice(0, boundary.index);
      this.sseBuffer = this.sseBuffer.slice(boundary.index + boundary.length);
      this.processSseFrame(frame);
      if (this.parsingDone) {
        this.sseBuffer = "";
        break;
      }
      boundary = nextEventBoundary(this.sseBuffer);
    }
  }

  private processSseFrame(frame: string): void {
    const lines = frame.split(/\r\n|\n|\r/);
    const isComment = lines.some((line) => line.trimStart().startsWith(":"));
    if (isComment) {
      if (this.contentBlockStartMs === undefined) {
        this.keepalivesBeforeContent += 1;
      }
      return;
    }

    const fields = parseSseFrameFields(frame);
    if (!fields.event) return;

    if (fields.event === "message_start") {
      if (this.messageStartMs === undefined) {
        this.messageStartMs = this.elapsedMs();
      }
      if (fields.data) {
        try {
          const parsed = JSON.parse(fields.data);
          if (typeof parsed?.message?.id === "string") {
            this.responseId = parsed.message.id;
          }
        } catch {}
      }
      return;
    }

    if (fields.event === "content_block_start") {
      if (fields.data) {
        try {
          const parsed = JSON.parse(fields.data);
          const type = parsed?.content_block?.type;
          if ((type === "thinking" || type === "redacted_thinking") && this.thinkingBlockStartMs === undefined) {
            this.thinkingBlockStartMs = this.elapsedMs();
          } else if ((type === "text" || type === "tool_use") && this.contentBlockStartMs === undefined) {
            this.contentBlockStartMs = this.elapsedMs();
            this.contentBlockKind = type;
            if (typeof parsed?.index === "number") {
              this.targetContentBlockIndex = parsed.index;
            }
          }
        } catch {}
      }
      return;
    }

    if (fields.event === "content_block_delta") {
      if (this.firstDeltaMs === undefined && fields.data) {
        try {
          const parsed = JSON.parse(fields.data);
          const delta = parsed?.delta;
          if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
            this.firstDeltaMs = this.elapsedMs();
            this.firstDeltaKind = "thinking";
          } else if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            this.firstDeltaMs = this.elapsedMs();
            this.firstDeltaKind = "text";
          } else if ((delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json.length > 0) ||
                     (typeof delta?.partial_json === "string" && delta.partial_json.length > 0)) {
            this.firstDeltaMs = this.elapsedMs();
            this.firstDeltaKind = "tool_input";
          }
        } catch {}
      }
      return;
    }

    if (fields.event === "content_block_stop") {
      if (this.contentBlockStartMs !== undefined && this.contentBlockStopMs === undefined) {
        let isTarget = true;
        if (fields.data) {
          try {
            const parsed = JSON.parse(fields.data);
            if (typeof parsed?.index === "number" && this.targetContentBlockIndex !== undefined) {
              isTarget = parsed.index === this.targetContentBlockIndex;
            }
          } catch {}
        }
        if (isTarget) {
          this.contentBlockStopMs = this.elapsedMs();
        }
      }
      if (this.firstDeltaMs !== undefined && this.contentBlockStopMs !== undefined) {
        this.parsingDone = true;
      }
    }
  }

  finish(outcome: "ok" | "error" | "disconnect" = "ok", statusOverride?: number): void {
    if (this.finished) return;
    this.finished = true;
    this.endMs = this.elapsedMs();
    if (statusOverride !== undefined && this.status === undefined) {
      this.status = statusOverride;
    }
    const isHttpError = typeof this.status === "number" && this.status >= 400;
    this.outcome = outcome === "ok" && isHttpError ? "error" : outcome;

    const record: GatewayRequestTimingRecord = {
      ts: new Date(this.t0).toISOString(),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.provider ? { provider: this.provider } : {}),
      route: this.route,
      ...(this.stream !== undefined ? { stream: this.stream } : {}),
      ...(this.tools !== undefined ? { tools: this.tools } : {}),
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
      outcome: this.outcome,
      ...(this.responseId ? { responseId: this.responseId } : {}),
      ...(this.gate ? { gate: this.gate } : {}),
      ...(this.upstreamCalls > 0 ? { upstreamCalls: this.upstreamCalls } : {}),
      ms: {
        ...(this.bodyReadMs !== undefined ? { bodyRead: this.bodyReadMs } : {}),
        ...(this.credentialMs !== undefined ? { credential: this.credentialMs } : {}),
        ...(this.upstreamStartMs !== undefined ? { upstreamStart: this.upstreamStartMs } : {}),
        ...(this.upstreamRestartMs !== undefined ? { upstreamRestart: this.upstreamRestartMs } : {}),
        ...(this.upstreamHeadersMs !== undefined ? { upstreamHeaders: this.upstreamHeadersMs } : {}),
        ...(this.upstreamFirstByteMs !== undefined ? { upstreamFirstByte: this.upstreamFirstByteMs } : {}),
        ...(this.downstreamHeadersMs !== undefined ? { downstreamHeaders: this.downstreamHeadersMs } : {}),
        ...(this.messageStartMs !== undefined ? { messageStart: this.messageStartMs } : {}),
        ...(this.thinkingBlockStartMs !== undefined ? { thinkingBlockStart: this.thinkingBlockStartMs } : {}),
        ...(this.contentBlockStartMs !== undefined ? { contentBlockStart: this.contentBlockStartMs } : {}),
        ...(this.contentBlockStopMs !== undefined ? { contentBlockStop: this.contentBlockStopMs } : {}),
        ...(this.firstDeltaMs !== undefined ? { firstDelta: this.firstDeltaMs } : {}),
        ...(this.endMs !== undefined ? { end: this.endMs } : {}),
      },
      ...(this.contentBlockKind ? { contentBlockKind: this.contentBlockKind } : {}),
      ...(this.firstDeltaKind ? { firstDeltaKind: this.firstDeltaKind } : {}),
      ...(this.upstreamChunksBeforeContent > 0
        ? { upstreamChunksBeforeContent: this.upstreamChunksBeforeContent }
        : {}),
      ...(this.keepalivesBeforeContent > 0
        ? { keepalivesBeforeContent: this.keepalivesBeforeContent }
        : {}),
    };

    try {
      this.sink(record);
    } catch {
      // Deliberately swallow sink errors so logging failure never affects response
    }
  }
}
