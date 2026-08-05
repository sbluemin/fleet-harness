export const ANTHROPIC_SSE_KEEPALIVE_INTERVAL_MS = 10_000;

const KEEPALIVE_FRAME = new TextEncoder().encode(": keep-alive\n\n");

type NextResult<T> =
  | { readonly kind: "chunk"; readonly result: IteratorResult<T> }
  | { readonly kind: "keepalive" };

/** SSE 본문이 조용한 동안 comment frame을 보내 downstream byte watchdog을 살려 둔다. */
export async function* withSseKeepAlive(
  chunks: AsyncIterable<Uint8Array>,
  intervalMs = ANTHROPIC_SSE_KEEPALIVE_INTERVAL_MS,
): AsyncGenerator<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  let next = iterator.next();
  let boundaryTail = "";
  let atFrameBoundary = true;

  try {
    for (;;) {
      const result = atFrameBoundary
        ? await waitForChunk(next, intervalMs)
        : { kind: "chunk" as const, result: await next };
      if (result.kind === "keepalive") {
        yield KEEPALIVE_FRAME;
        continue;
      }
      if (result.result.done) return;
      if (result.result.value.byteLength > 0) {
        boundaryTail = appendBoundaryTail(boundaryTail, result.result.value);
        atFrameBoundary = endsAtSseFrameBoundary(boundaryTail);
      }
      yield result.result.value;
      next = iterator.next();
    }
  } finally {
    await iterator.return?.();
  }
}

function appendBoundaryTail(tail: string, chunk: Uint8Array): string {
  return (tail + new TextDecoder().decode(chunk)).slice(-4);
}

function endsAtSseFrameBoundary(tail: string): boolean {
  return tail.endsWith("\n\n") || tail.endsWith("\r\r") || tail.endsWith("\r\n\r\n");
}

async function waitForChunk<T>(
  next: Promise<IteratorResult<T>>,
  intervalMs: number,
): Promise<NextResult<T>> {
  return await new Promise<NextResult<T>>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ kind: "keepalive" });
    }, intervalMs);
    timer.unref?.();

    next.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "chunk", result });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
