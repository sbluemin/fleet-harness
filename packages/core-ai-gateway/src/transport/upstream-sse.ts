/**
 * Shared upstream HTTP/SSE plumbing for OpenAI-family adapters.
 *
 * Both the Responses adapter and the Chat Completions adapter read a streamed
 * upstream body under the same three safety bounds — abort linkage, idle
 * timeout, and a total byte ceiling — and split it into SSE frames the same
 * way. The per-wire *interpretation* of a frame stays in each adapter; only the
 * transport mechanics live here.
 */

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export class UpstreamBodyLimitError extends Error {
  constructor(readonly maxBodyBytes: number) {
    super(`Upstream response exceeded ${maxBodyBytes} bytes`);
    this.name = "UpstreamBodyLimitError";
  }
}

export class UpstreamIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(`Upstream response was idle for ${idleTimeoutMs}ms`);
    this.name = "UpstreamIdleTimeoutError";
  }
}

export class UpstreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamProtocolError";
  }
}

export interface UpstreamReadOptions {
  controller: AbortController;
  idleTimeoutMs: number;
  maxBodyBytes: number;
}

export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  options: UpstreamReadOptions
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

export async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: UpstreamReadOptions
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

export function nextEventBoundary(buffer: string): { index: number; length: number } | undefined {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match === null ? undefined : { index: match.index, length: match[0].length };
}

export interface SseFrameFields {
  readonly event?: string;
  /** Joined `data:` lines. Comment-only or empty frames yield an empty string. */
  readonly data: string;
}

/** Split one SSE frame into its `event`/`data` fields; comment lines are skipped. */
export function parseSseFrameFields(frame: string): SseFrameFields {
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
  return {
    ...(eventName === undefined ? {} : { event: eventName }),
    data: data.join("\n"),
  };
}

export function linkAbortSignal(
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

export function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}
