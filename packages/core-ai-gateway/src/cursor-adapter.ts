import http2 from "node:http2";
import { randomUUID } from "node:crypto";

import type {
  AdapterCallOptions,
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
} from "./canonical.js";

export const CURSOR_API_ORIGIN = "https://api2.cursor.sh";
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
export const CURSOR_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
// Cursor CLI가 보내는 값. 서버가 클라이언트를 식별하는 데 쓰므로 upstream 변경 시 여기부터 깨진다.
export const CURSOR_CLIENT_VERSION = "cli-2026.07.08-0c04a8a";

export interface CursorAdapterOptions {
  readonly origin?: string;
  readonly clientVersion?: string;
  readonly idleTimeoutMs?: number;
}

/** Connect streaming 프레임: [flag:1][length:4 BE][payload]. */
export function encodeConnectFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(body.byteLength, 1);
  return Buffer.concat([header, body]);
}

export function decodeConnectFrames(buffer: Buffer): { frames: unknown[]; rest: Buffer } {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const frames: unknown[] = [];
  let offset = 0;
  while (offset + 5 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset + 1);
    if (offset + 5 + length > buffer.byteLength) break;
    const slice = buffer.subarray(offset + 5, offset + 5 + length);
    offset += 5 + length;
    try {
      frames.push(JSON.parse(slice.toString("utf8")));
    } catch {
      // 프레임 하나가 깨져도 스트림 전체를 버리지 않는다.
    }
  }
  return { frames, rest: buffer.subarray(offset) as Buffer };
}

export class CursorAdapter implements AiGatewayAdapter {
  private readonly origin: string;
  private readonly clientVersion: string;
  private readonly idleTimeoutMs: number;
  private readonly sessionId = randomUUID();

  constructor(options: CursorAdapterOptions = {}) {
    this.origin = options.origin ?? CURSOR_API_ORIGIN;
    this.clientVersion = options.clientVersion ?? CURSOR_CLIENT_VERSION;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  }

  async stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions,
  ): Promise<AdapterResponse> {
    const session = http2.connect(this.origin);
    const stream = session.request({
      ":method": "POST",
      ":path": CURSOR_RUN_PATH,
      "content-type": "application/connect+json",
      "connect-protocol-version": "1",
      te: "trailers",
      authorization: `Bearer ${options.apiKey}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": this.clientVersion,
      "x-cursor-client-type": "cli",
      "x-request-id": randomUUID(),
      "x-session-id": this.sessionId,
    });
    stream.setTimeout(this.idleTimeoutMs, () => stream.destroy(new Error("cursor stream idle timeout")));
    const abort = (): void => {
      stream.destroy(new Error("cancelled by caller"));
      session.close();
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    stream.end(encodeConnectFrame(buildCursorRunRequest(request)));

    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      events: mapCursorStream(stream, request.model, () => {
        options.signal?.removeEventListener("abort", abort);
        session.close();
      }),
    };
  }
}

export function buildCursorRunRequest(request: CanonicalResponseRequest): unknown {
  const runRequest: Record<string, unknown> = {
    conversationState: {},
    action: {
      userMessageAction: {
        userMessage: { text: flattenCanonicalInput(request), messageId: randomUUID() },
        requestContext: { env: { timeZone: "UTC" } },
      },
    },
    modelDetails: {
      modelId: request.model,
      displayModelId: request.model,
      displayName: request.model,
      displayNameShort: request.model,
    },
  };
  if (request.tools && request.tools.length > 0) {
    runRequest.mcpTools = {
      mcpTools: request.tools.map((tool) => ({
        name: tool.name,
        toolName: tool.name,
        description: tool.description ?? "",
        providerIdentifier: "fleet-gateway",
        inputSchema: Buffer.from(JSON.stringify(tool.parameters), "utf8").toString("base64"),
      })),
    };
  }
  if (request.instructions) {
    runRequest.customSystemPrompt = request.instructions;
  }
  return { runRequest };
}

/**
 * Cursor는 대화를 서버측 blob으로 관리하지만 Claude Code는 매 턴 전체 히스토리를 보낸다.
 * 첫 구현은 히스토리를 하나의 사용자 메시지로 평탄화해 stateless 요청으로 만든다.
 */
function flattenCanonicalInput(request: CanonicalResponseRequest): string {
  const parts: string[] = [];
  for (const item of request.input) {
    if (item.type === "message") {
      parts.push(item.role === "user" ? item.content : `[${item.role}]\n${item.content}`);
    } else if (item.type === "function_call") {
      parts.push(`[tool_call ${item.name}]\n${item.arguments}`);
    } else {
      parts.push(`[tool_result ${item.call_id}]\n${item.output}`);
    }
  }
  return parts.join("\n\n");
}

async function* mapCursorStream(
  stream: http2.ClientHttp2Stream,
  model: string,
  onClose: () => void,
): AsyncGenerator<CanonicalResponseEvent> {
  const responseId = `cursor_${randomUUID()}`;
  const itemId = `msg_${randomUUID()}`;
  let buffer: Buffer = Buffer.alloc(0);
  let started = false;
  let completed = false;
  let outputIndex = 0;
  const toolItems = new Map<string, { itemId: string; index: number; name: string }>();

  try {
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk as Uint8Array]) as Buffer;
      const { frames, rest } = decodeConnectFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (!isRecord(frame)) continue;
        if (!started) {
          started = true;
          yield { type: "response.created", response: { id: responseId, model, usage: null } };
        }
        const update = isRecord(frame.interactionUpdate) ? frame.interactionUpdate : undefined;
        if (update === undefined) {
          if (isRecord(frame.error)) {
            yield { type: "error", error: cursorError(frame.error) };
            completed = true;
          }
          continue;
        }
        if (isRecord(update.textDelta) && typeof update.textDelta.text === "string") {
          yield {
            type: "response.output_text.delta",
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta: update.textDelta.text,
          };
        } else if (isRecord(update.toolCallStarted)) {
          const call = toolCallInfo(update.toolCallStarted);
          if (call) {
            outputIndex += 1;
            const entry = { itemId: call.callId, index: outputIndex, name: call.name };
            toolItems.set(call.callId, entry);
            yield {
              type: "response.output_item.added",
              output_index: entry.index,
              item: { id: entry.itemId, type: "function_call", call_id: call.callId, name: call.name, arguments: "" },
            };
          }
        } else if (isRecord(update.partialToolCall)) {
          const callId = typeof update.partialToolCall.callId === "string" ? update.partialToolCall.callId : undefined;
          const delta = typeof update.partialToolCall.argsTextDelta === "string" ? update.partialToolCall.argsTextDelta : "";
          const entry = callId === undefined ? undefined : toolItems.get(callId);
          if (entry && delta.length > 0) {
            yield { type: "response.function_call_arguments.delta", item_id: entry.itemId, output_index: entry.index, delta };
          }
        } else if (isRecord(update.toolCallCompleted)) {
          const callId = typeof update.toolCallCompleted.callId === "string" ? update.toolCallCompleted.callId : undefined;
          const entry = callId === undefined ? undefined : toolItems.get(callId);
          if (entry) {
            yield {
              type: "response.output_item.done",
              output_index: entry.index,
              item: { id: entry.itemId, type: "function_call", call_id: entry.itemId, name: entry.name, arguments: "" },
            };
          }
        } else if (isRecord(update.turnEnded)) {
          completed = true;
          yield { type: "response.completed", response: { id: responseId, model, usage: null } };
        }
      }
    }
    if (started && !completed) {
      yield { type: "response.completed", response: { id: responseId, model, usage: null } };
    }
  } finally {
    onClose();
  }
}

function toolCallInfo(value: Record<string, unknown>): { callId: string; name: string } | null {
  const callId = typeof value.callId === "string" ? value.callId : null;
  if (!callId) return null;
  const call = isRecord(value.toolCall) ? value.toolCall : undefined;
  const tool = call && isRecord(call.tool) ? call.tool : undefined;
  const mcp = tool && isRecord(tool.mcpToolCall) ? tool.mcpToolCall : undefined;
  const args = mcp && isRecord(mcp.args) ? mcp.args : undefined;
  const name = args && typeof args.toolName === "string"
    ? args.toolName
    : tool
      ? Object.keys(tool)[0] ?? "tool"
      : "tool";
  return { callId, name };
}

function cursorError(value: Record<string, unknown>): { type: string; message: string } {
  return {
    type: typeof value.code === "string" ? value.code : "api_error",
    message: typeof value.message === "string" ? value.message : "Cursor request failed",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
