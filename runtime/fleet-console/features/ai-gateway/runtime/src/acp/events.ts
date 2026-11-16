import { AcpAuthRequiredError, AcpModelUnavailableError, type AcpSessionEvent, type AcpTurnUsage } from "./contract.js";

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** ACP 콘텐츠 블록 또는 블록 배열에서 텍스트만 모은다. */
function contentText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map((block) => {
    const entry = record(block);
    // `tool_call_update.content`는 `{type:"content", content:{type:"text",text}}`로 한 겹 더 싸여 온다.
    const inner = record(entry?.content) ?? entry;
    return inner?.type === "text" ? text(inner.text) ?? "" : "";
  }).join("");
}

function toolOutput(update: Json): string | undefined {
  const raw = update.rawOutput;
  if (typeof raw === "string") return raw;
  if (raw !== undefined && raw !== null) {
    try { return JSON.stringify(raw); } catch { return undefined; }
  }
  const fromContent = contentText(update.content);
  return fromContent.length > 0 ? fromContent : undefined;
}

/**
 * agy의 `session/update` 하나를 정규화 이벤트로 접는 함수를 만든다. 세션 하나에 하나씩 쓴다.
 *
 * `tool_call`은 같은 id로 되풀이해 올 수 있어 시작은 한 번만 낸다. 도구 출력 본문이 없는(status만 오는)
 * 업데이트도 있으므로 `output`은 있을 때만 싣는다. 모르는 종류(plan·available_commands_update·mode 변경 등)는 버린다.
 */
export function createSessionUpdateNormalizer(): (update: unknown) => readonly AcpSessionEvent[] {
  const started = new Set<string>();
  const finished = new Set<string>();
  return (raw) => {
    const update = record(raw);
    if (!update) return [];
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const chunk = contentText(update.content);
        return chunk.length > 0 ? [{ kind: "text", text: chunk }] : [];
      }
      case "agent_thought_chunk": {
        const chunk = contentText(update.content);
        return chunk.length > 0 ? [{ kind: "thought", text: chunk }] : [];
      }
      case "tool_call":
      case "tool_call_update": {
        const id = text(update.toolCallId);
        if (id === undefined) return [];
        const events: AcpSessionEvent[] = [];
        if (!started.has(id)) {
          started.add(id);
          events.push({ kind: "tool-start", id, name: text(update.title) ?? text(update.kind) ?? "tool", input: update.rawInput ?? null });
        }
        const status = text(update.status);
        if ((status === "completed" || status === "failed") && !finished.has(id)) {
          finished.add(id);
          const output = toolOutput(update);
          events.push({ kind: "tool-end", id, isError: status === "failed", ...(output === undefined ? {} : { output }) });
        }
        return events;
      }
      case "usage_update": {
        const used = update.used;
        const size = update.size;
        return typeof used === "number" && typeof size === "number"
          ? [{ kind: "usage", usage: { usedTokens: used, contextWindow: size } }]
          : [];
      }
      default:
        return [];
    }
  };
}

function turnUsage(value: unknown): AcpTurnUsage | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const count = (field: string): number => (typeof raw[field] === "number" && Number.isFinite(raw[field]) ? raw[field] as number : 0);
  const usage = {
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
    thoughtTokens: count("thoughtTokens"),
    cachedReadTokens: count("cachedReadTokens"),
    totalTokens: count("totalTokens"),
  };
  return usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0 ? usage : undefined;
}

/** `session/prompt` 응답의 stopReason(과 있으면 usage)을 계약의 턴 종료로 옮긴다. */
export function toTurnEnd(stopReason: unknown, usage?: unknown): Extract<AcpSessionEvent, { kind: "turn-end" }> {
  const counted = turnUsage(usage);
  switch (stopReason) {
    case "end_turn":
    case "max_tokens":
    case "refusal":
    case "cancelled":
      return { kind: "turn-end", stopReason, ...(counted ? { usage: counted } : {}) };
    default:
      return { kind: "turn-end", stopReason: "error", detail: `Unexpected stop reason: ${String(stopReason)}` };
  }
}

/** agy가 모델 출력 대신 내보내는 업스트림 오류 알림. */
export interface AgyUpstreamError {
  /** gRPC 상태 이름(`RESOURCE_EXHAUSTED`). 알림에 없으면 비어 있다. */
  readonly status: string | undefined;
  /** HTTP 코드(`429`). 알림에 없으면 undefined. */
  readonly code: number | undefined;
  /** 알림 문구에서 접두(`⚠`, `API error (attempt N):`)를 뗀 본문. */
  readonly message: string;
}

/**
 * `agent_message_chunk` 텍스트가 agy의 업스트림 오류 알림이면 그 내용을 돌려준다.
 *
 * **구조 신호는 없다.** agy 1.5.9는 업스트림 429를 재시도하는 동안(실측: 8회, 약 147초) 오류를 ACP 오류 필드가 아니라
 * 평범한 `agent_message_chunk`로 내보내고, 포기한 뒤에도 `stopReason: "end_turn"`으로 정상 종료한다(prompt 결과에
 * 오류 필드가 없었다). 그래서 문자열 패턴이 유일한 감지 수단이다. 패턴은 이 알림이 쓰는 모양에 고정한다:
 * - 청크가 `⚠`로 시작하고(앞 공백 허용),
 * - `API error (attempt N): ` 접두가 있거나, `<GRPC_STATUS> (code NNN): ` 꼴이다.
 * 실측 문구: `\n⚠ API error (attempt 8): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n`,
 * 마지막 포기 알림은 접두 없이 `\n⚠ RESOURCE_EXHAUSTED (code 429): …\n`.
 * 청크 중간의 `⚠`나 다른 모양은 모델 출력으로 두어 오탐을 피한다.
 */
export function parseAgyUpstreamError(text: string): AgyUpstreamError | undefined {
  const body = /^\s*⚠\s*([\s\S]*?)\s*$/.exec(text)?.[1];
  if (body === undefined) return undefined;
  const attempt = /^API error \(attempt \d+\):\s*([\s\S]*)$/.exec(body);
  const rest = attempt ? attempt[1]! : body;
  const coded = /^([A-Z][A-Z0-9_]+) \(code (\d{3})\):?\s*([\s\S]*)$/.exec(rest);
  if (coded) return { status: coded[1]!, code: Number(coded[2]), message: coded[3]!.trim() };
  if (!attempt) return undefined;
  const numeric = /\b(?:code|HTTP|status)[ :]+(\d{3})\b/i.exec(rest);
  return { status: undefined, code: numeric ? Number(numeric[1]) : undefined, message: rest.trim() };
}

/**
 * `⚠ `로 시작하는 텍스트면 그 뒤의 본문을 돌려준다.
 *
 * agy는 업스트림 오류 중 일부(실측: 네트워크 문제, `⚠ There was a network issue connecting to the server, please try again.`)를
 * 코드 없이 같은 모양의 `agent_message_chunk`로 내보내고 `end_turn`으로 정상 종료한다. 이 한 줄만으로는 오류인지 알 수 없다 —
 * 한 턴의 출력이 이런 텍스트**뿐**이고 도구 호출도 다른 텍스트도 없이 끝났을 때만 호출자가 업스트림 오류로 본다.
 */
export function agyWarningText(text: string): string | undefined {
  return /^\s*⚠\s+([\s\S]*?)\s*$/.exec(text)?.[1];
}

/** agy가 알린 업스트림 오류를 Anthropic 오류 형식(HTTP 상태와 오류 type)으로 옮긴다. */
export function classifyAgyUpstreamFailure(error: AgyUpstreamError): {
  readonly status: number;
  readonly type: string;
  readonly message: string;
} {
  const message = `agy upstream error${error.status ? ` ${error.status}` : ""}${error.code ? ` (code ${error.code})` : ""}: ${error.message}`;
  const code = error.code;
  const status = error.status;
  if (code === 429 || status === "RESOURCE_EXHAUSTED") return { status: 429, type: "rate_limit_error", message };
  if (code === 401 || status === "UNAUTHENTICATED") return { status: 401, type: "authentication_error", message };
  if (code === 403 || status === "PERMISSION_DENIED") return { status: 403, type: "permission_error", message };
  if (code === 404 || status === "NOT_FOUND") return { status: 404, type: "not_found_error", message };
  if (code === 400 || status === "INVALID_ARGUMENT" || status === "FAILED_PRECONDITION") return { status: 400, type: "invalid_request_error", message };
  if (code === 503 || code === 529 || status === "UNAVAILABLE") return { status: 529, type: "overloaded_error", message };
  if (code === 504 || status === "DEADLINE_EXCEEDED") return { status: 504, type: "api_error", message };
  // 코드를 알 수 없는 오류(예: 네트워크 문제)는 일시적인 것으로 보고 Claude Code가 재시도하게 529로 보낸다.
  if (code === undefined) return { status: 529, type: "overloaded_error", message };
  return { status: code >= 500 && code <= 599 ? code : 500, type: "api_error", message };
}

/** `port.open` 실패를 Anthropic HTTP 상태·오류 형식으로 옮긴다. */
export function classifyAgyOpenFailure(error: unknown): {
  readonly status: number;
  readonly type: string;
  readonly message: string;
} {
  if (error instanceof AcpModelUnavailableError) {
    return {
      status: 400,
      type: "invalid_request_error",
      message: `${error.message} The agy account offers: ${error.availableModels.join(", ") || "no models"}. Pick another model or sign in to agy with an account that has it.`,
    };
  }
  if (error instanceof AcpAuthRequiredError) {
    return {
      status: 401,
      type: "authentication_error",
      message: `${error.message} Run \`agy\` and sign in first.`,
    };
  }
  return {
    status: 503,
    type: "api_error",
    message: error instanceof Error ? error.message : String(error),
  };
}
