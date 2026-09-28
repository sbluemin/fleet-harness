/**
 * 원격 SSE를 한도 안에서 읽는 파서. 데이터 뷰로 흘릴 스트림과 broker 전용 control stream이 같이 쓴다.
 *
 * 이벤트는 허용목록에 든 이름만 통과하고, 원문을 그대로 넘기지 않고 파싱한 JSON을 다시 직렬화해
 * 낸다 — 원격이 만든 줄 바꿈·주석·id·retry가 데이터 뷰의 EventSource 상태를 조작하지 못한다.
 * 한도를 넘거나 JSON이 아니면 그 스트림 자체가 오염된 것으로 보고 끊는다.
 */
export const SSE_LIMITS = {
  lineBytes: 16 * 1024,
  eventBytes: 64 * 1024,
  pendingBytes: 64 * 1024,
  jsonDepth: 32,
} as const;

export interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

export type SseFeedResult =
  | { readonly ok: true; readonly events: readonly SseEvent[]; readonly keepalive: boolean }
  | { readonly ok: false; readonly error: "oversize" | "malformed" };

export interface SseParser {
  feed(chunk: Buffer | string): SseFeedResult;
}

export function createSseParser(): SseParser {
  let pending = "";
  let event = "message";
  let data: string[] = [];
  let eventBytes = 0;

  function reset(): void {
    event = "message";
    data = [];
    eventBytes = 0;
  }

  return {
    feed(chunk) {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const events: SseEvent[] = [];
      let keepalive = false;
      let newline: number;
      while ((newline = pending.search(/\r\n|\n|\r/u)) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + (pending.startsWith("\r\n", newline) ? 2 : 1));
        if (line.length > SSE_LIMITS.lineBytes) return { ok: false, error: "oversize" };
        if (line === "") {
          if (data.length > 0) {
            const parsed = parseJson(data.join("\n"));
            if (parsed === INVALID) return { ok: false, error: "malformed" };
            events.push({ event, data: parsed });
          }
          reset();
          continue;
        }
        if (line.startsWith(":")) { keepalive = true; continue; }
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "");
        eventBytes += line.length;
        if (eventBytes > SSE_LIMITS.eventBytes) return { ok: false, error: "oversize" };
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        // id·retry와 모르는 필드는 버린다 — 재전송 기준과 재연결 간격은 원격이 정하지 않는다.
      }
      if (pending.length > SSE_LIMITS.pendingBytes) return { ok: false, error: "oversize" };
      return { ok: true, events, keepalive };
    },
  };
}

const INVALID = Symbol("invalid");

function parseJson(text: string): unknown {
  try {
    const value = JSON.parse(text) as unknown;
    return depthOf(value, 0) <= SSE_LIMITS.jsonDepth ? value : INVALID;
  } catch {
    return INVALID;
  }
}

function depthOf(value: unknown, depth: number): number {
  if (depth > SSE_LIMITS.jsonDepth) return depth;
  if (value === null || typeof value !== "object") return depth;
  let max = depth + 1;
  for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, depthOf(child, depth + 1));
    if (max > SSE_LIMITS.jsonDepth) break;
  }
  return max;
}

export function encodeSseEvent(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
