import type http from "node:http";

import type { TerminalRuntime } from "../shared/runtime.js";

const SCROLLBACK_BYTE_LIMIT = 32_768;
const SCROLLBACK_LINES_MAX = 200;

// bench 플러그인 authorized consumer 전용: stdout 바이트만 응답, 민감 필드 없음.
export function handleScrollbackRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  terminalRuntime: TerminalRuntime,
  writeJson: (res: http.ServerResponse, status: number, payload: unknown) => void,
): boolean {
  if (req.method !== "GET") {
    writeJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const linesParam = url.searchParams.get("lines");
  const lines = linesParam ? Math.min(Math.max(1, parseInt(linesParam, 10) || 1), SCROLLBACK_LINES_MAX) : SCROLLBACK_LINES_MAX;

  const chunks = terminalRuntime.getScrollbackTail(sessionId, SCROLLBACK_BYTE_LIMIT);
  const combined = Buffer.concat(chunks);
  const text = combined.toString("utf8");

  // lines 상한 적용: 마지막 N줄만 반환
  const allLines = text.split("\n");
  const sliced = allLines.slice(-lines);
  const scrollback = sliced.join("\n");
  const bytes = Buffer.byteLength(scrollback, "utf8");
  const truncated = combined.length >= SCROLLBACK_BYTE_LIMIT;

  writeJson(res, 200, { scrollback, bytes, truncated });
  return true;
}
