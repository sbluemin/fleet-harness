import type http from "node:http";

export const SSE_KEEPALIVE_INTERVAL_MS = 30_000;

export function encodeSseData(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function startSseKeepaliveLifecycle(
  res: http.ServerResponse,
  onCleanup: () => void,
): () => void {
  res.setTimeout(0);
  const interval = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(": keepalive\n\n");
  }, SSE_KEEPALIVE_INTERVAL_MS);
  interval.unref();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(interval);
    onCleanup();
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
  return cleanup;
}
