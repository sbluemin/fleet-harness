import { EventEmitter } from "node:events";
import http2 from "node:http2";

import { fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONNECT_FLAG_COMPRESSED,
  CONNECT_FLAG_END_STREAM,
  CursorAdapter,
  encodeConnectFrame,
  resetCursorWireModelMemory,
} from "../../../../src/index.js";
import type {
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CursorDiagnosticEvent,
} from "../../../../src/index.js";
import { AgentServerMessageSchema } from "../../../../src/upstream/cursor/native/generated/cursor-agent-protobuf.js";

afterEach(() => resetCursorWireModelMemory());

/**
 * Cursor's rejections arrive as HTTP status codes and malformed bodies, not as protobuf. Every
 * case here used to reach the caller as a successful, empty assistant turn: a JSON error body's
 * first byte reads as Connect frame flags and its next four as a ~577 MB frame length, so the
 * decoder buffered it forever, produced no frame, and the stream end completed the turn.
 */
describe("Cursor upstream rejection", () => {
  it("forwards a non-2xx Run as a failed adapter response carrying Cursor's own body", async () => {
    const body = Buffer.from(JSON.stringify({ error: { message: "expired" } }), "utf8");
    const events: CursorDiagnosticEvent[] = [];
    const response = await runCursorTransport({
      head: { ":status": 401, "content-type": "application/json" },
      chunks: [body],
      diagnostics: (event) => events.push(event),
    });

    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("unreachable");
    expect(response.status).toBe(401);
    expect(Buffer.from(response.body).toString("utf8")).toBe(body.toString("utf8"));
    expect(response.headers.get("content-type")).toBe("application/json");
    // Length and encoding headers describe Cursor's framing of a body this gateway re-emits.
    expect(response.headers.get("content-length")).toBeNull();
    expect(events.filter((event) => event.event === "transport.response")).toEqual([
      expect.objectContaining({ event: "transport.response", status: 401 }),
    ]);
    expect(turnFinish(events)).toEqual(
      expect.objectContaining({ outcome: "upstream_status", status: 401 }),
    );
  });

  it("fails when the stream ends before Cursor answers with a response head", async () => {
    const events: CursorDiagnosticEvent[] = [];
    await expect(runCursorTransport({
      head: null,
      chunks: [],
      diagnostics: (event) => events.push(event),
    })).rejects.toThrow(/ended before a response/);
    expect(turnFinish(events)).toEqual(expect.objectContaining({
      outcome: "response_head_error",
      error: "no_response_head",
    }));
  });

  it("honors a caller abort raised while the response head is still outstanding", async () => {
    // The live Run that observes `options.signal` does not exist yet in this window, so the
    // gate observes it directly; otherwise a disconnected client leaves the Run open upstream.
    const events: CursorDiagnosticEvent[] = [];
    const harness = cursorTransportHarness({
      quiet: true,
      chunks: [],
      diagnostics: (event) => events.push(event),
    });
    const controller = new AbortController();
    const pending = harness.run(controller.signal);
    await waitFor(() => harness.stream.writes.length > 0);
    controller.abort(new Error("client disconnected"));

    await expect(pending).rejects.toThrow(/cancelled by caller/);
    expect(harness.stream.closeCode).toBe(http2.constants.NGHTTP2_CANCEL);
    expect(harness.sessionClosed).toBeGreaterThan(0);
    expect(turnFinish(events)).toEqual(expect.objectContaining({
      outcome: "response_head_error",
      error: "caller_abort",
    }));
  });
});

/**
 * What Node hands a `response` listener is `IncomingHttpHeaders & IncomingHttpStatusHeader`,
 * an intersection no object literal satisfies: `:status` is a number and the header dictionary's
 * index signature is not. These fixtures state the bytes on the wire instead.
 */
type CursorResponseHeaders = Record<string, string | number>;

interface CursorTransportScript {
  /** `null` models a stream that dies before Cursor answers with response headers. */
  readonly head?: CursorResponseHeaders | null;
  readonly chunks: readonly Buffer[];
  /** Emit nothing at all after the request write, modelling an upstream that never answers. */
  readonly quiet?: boolean;
  /** Deliver the head and any chunks but never end the body, modelling a stalled rejection. */
  readonly stall?: boolean;
  readonly diagnostics?: (event: CursorDiagnosticEvent) => void;
}

const CONNECT_HEAD: CursorResponseHeaders = {
  ":status": 200,
  "content-type": "application/connect+proto",
};

function cursorTransportHarness(script: CursorTransportScript) {
  const stream = new ScriptedCursorStream({
    ...script,
    head: script.head === undefined ? CONNECT_HEAD : script.head,
  });
  let sessionClosed = 0;
  const session = Object.assign(new EventEmitter(), {
    request: () => stream,
    close: () => {
      sessionClosed += 1;
    },
  });
  const adapter = new CursorAdapter({
    connect: (() => session as unknown as http2.ClientHttp2Session) as typeof http2.connect,
    idleTimeoutMs: 1_000,
    clientHeartbeatMs: 1_000,
    toolFinalizeGraceMs: 0,
    ...(script.diagnostics ? { diagnostics: script.diagnostics } : {}),
  });
  return {
    adapter,
    stream,
    get sessionClosed() {
      return sessionClosed;
    },
    run: (signal?: AbortSignal) => adapter.stream(request(), {
      apiKey: "cursor-test-token",
      ...(signal ? { signal } : {}),
    }),
  };
}

async function runCursorTransport(script: CursorTransportScript) {
  return cursorTransportHarness(script).run();
}

/** `turn.finish` carries the outcome; later transport events still arrive after it. */
function turnFinish(events: readonly CursorDiagnosticEvent[]): CursorDiagnosticEvent | undefined {
  return events.find((event) => event.event === "turn.finish");
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Cursor test state");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

async function drain(
  events: AsyncIterable<CanonicalResponseEvent>,
): Promise<CanonicalResponseEvent[]> {
  const collected: CanonicalResponseEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function serverFrame(value: JsonValue): Buffer {
  return encodeConnectFrame(
    toBinary(AgentServerMessageSchema, fromJson(AgentServerMessageSchema, value)),
  );
}

function endStreamFrame(payload: unknown): Buffer {
  return encodeConnectFrame(Buffer.from(JSON.stringify(payload), "utf8"), CONNECT_FLAG_END_STREAM);
}

function request(): CanonicalResponseRequest {
  return {
    model: "default",
    instructions: "Answer briefly.",
    input: [{ type: "message", role: "user", content: "Say hello." }],
    metadata: { user_id: "claude-session-transport-rejection" },
    stream: true,
  };
}

class ScriptedCursorStream extends EventEmitter {
  readonly writes: Buffer[] = [];
  closeCode: number | undefined;
  headDelivered = false;
  private started = false;

  constructor(private readonly script: CursorTransportScript) {
    super();
  }

  setTimeout(): this {
    return this;
  }

  write(chunk: Uint8Array): boolean {
    this.writes.push(Buffer.from(chunk));
    if (this.started || this.script.quiet === true) return true;
    this.started = true;
    queueMicrotask(() => {
      if (this.script.head) this.emit("response", this.script.head);
      this.headDelivered = true;
      // A macrotask, so the adapter's response-head continuation has installed its data
      // listener first — an EventEmitter drops what it emits with no listener attached.
      setImmediate(() => {
        for (const body of this.script.chunks) this.emit("data", body);
        if (this.script.stall !== true) this.emit("end");
      });
    });
    return true;
  }

  close(code?: number): void {
    this.closeCode = code;
    queueMicrotask(() => this.emit("close"));
  }

  destroy(error?: Error): void {
    if (error) queueMicrotask(() => this.emit("error", error));
    queueMicrotask(() => this.emit("close"));
  }
}
