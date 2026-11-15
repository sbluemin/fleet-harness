import type { AcpSessionEvent } from "./contract.js";

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

/** `session/prompt` 응답의 stopReason을 계약의 턴 종료로 옮긴다. */
export function toTurnEnd(stopReason: unknown): Extract<AcpSessionEvent, { kind: "turn-end" }> {
  switch (stopReason) {
    case "end_turn":
    case "max_tokens":
    case "refusal":
    case "cancelled":
      return { kind: "turn-end", stopReason };
    default:
      return { kind: "turn-end", stopReason: "error", detail: `Unexpected stop reason: ${String(stopReason)}` };
  }
}
