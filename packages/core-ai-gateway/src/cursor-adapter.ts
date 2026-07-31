import { createHash, randomUUID } from "node:crypto";
import http2 from "node:http2";

import type {
  AdapterCallOptions,
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalInputItem,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
} from "./canonical.js";

export const CURSOR_API_ORIGIN = "https://api2.cursor.sh";
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
export const CURSOR_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
// Cursor CLI가 보내는 값. 서버가 클라이언트를 식별하므로 upstream 변경 시 여기부터 깨진다.
export const CURSOR_CLIENT_VERSION = "cli-2026.07.08-0c04a8a";

export interface CursorAdapterOptions {
  readonly origin?: string;
  readonly clientVersion?: string;
  readonly idleTimeoutMs?: number;
  /** 대화 연속성 키. 같은 값을 유지하면 Cursor가 서버측 대화를 이어간다. */
  readonly conversationId?: string;
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

/**
 * Cursor는 프롬프트를 blob으로 주고받는다. rootPromptMessagesJson에는 blob ID만 싣고
 * 서버가 getBlobArgs로 바이트를 되가져간다. ID는 내용의 SHA-256이다.
 */
class BlobStore {
  private readonly values = new Map<string, string>();

  put(value: unknown): string {
    const data = Buffer.from(JSON.stringify(value), "utf8");
    const id = createHash("sha256").update(data).digest("base64");
    this.values.set(id, data.toString("base64"));
    return id;
  }

  set(id: string, base64Data: string): void {
    this.values.set(id, base64Data);
  }

  get(id: string): string | undefined {
    return this.values.get(id);
  }
}

export interface CursorRunPlan {
  readonly payload: unknown;
  readonly blobs: BlobStore;
}

export function buildCursorRunPlan(
  request: CanonicalResponseRequest,
  conversationId: string,
): CursorRunPlan {
  const blobs = new BlobStore();
  const rootIds: string[] = [];

  const instructions = request.instructions?.trim();
  rootIds.push(blobs.put({
    role: "system",
    content: instructions && instructions.length > 0 ? instructions : "You are a helpful assistant.",
  }));

  // 마지막 항목이 tool 결과면 이어가기 턴이다. 그때는 새 사용자 메시지 없이 resume한다.
  const last = request.input.at(-1);
  const isToolContinuation = last?.type === "function_call_output";
  const activeIndex = isToolContinuation ? -1 : lastUserIndex(request.input);

  for (let i = 0; i < request.input.length; i += 1) {
    if (i === activeIndex) break;
    const item = request.input[i];
    if (!item) continue;
    const entry = historyBlob(item);
    if (entry) rootIds.push(blobs.put(entry));
  }

  const activeText = activeIndex >= 0 ? messageText(request.input[activeIndex]) : "";
  const action = isToolContinuation || activeText.trim().length === 0
    ? { resumeAction: { requestContext: { env: { timeZone: "UTC" } } } }
    : {
      userMessageAction: {
        userMessage: { text: activeText, messageId: randomUUID() },
        requestContext: { env: { timeZone: "UTC" } },
      },
    };

  const runRequest: Record<string, unknown> = {
    conversationId,
    conversationState: { rootPromptMessagesJson: rootIds },
    action,
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
  return { payload: { runRequest }, blobs };
}

function lastUserIndex(input: readonly CanonicalInputItem[]): number {
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (item?.type === "message" && (item.role === "user" || item.role === "developer")) return i;
  }
  return -1;
}

function messageText(item: CanonicalInputItem | undefined): string {
  return item?.type === "message" ? item.content : "";
}

/**
 * Cursor는 히스토리를 OpenAI 스타일 content part로 기대한다. assistant의 tool 호출은
 * 눈에 보이는 텍스트로 되살리지 않는다 — 짝이 되는 tool 결과가 call id와 출력을 나른다.
 */
function historyBlob(item: CanonicalInputItem): unknown | null {
  if (item.type === "message") {
    const text = item.content.trim();
    if (text.length === 0) return null;
    const role = item.role === "assistant" ? "assistant" : "user";
    return { role, content: [{ type: "text", text }] };
  }
  if (item.type === "function_call_output") {
    const text = `[Tool Result]\n[tool_result]\ncall_id: ${item.call_id}\noutput:\n${item.output}`;
    return { role: "user", content: [{ type: "text", text }] };
  }
  return null;
}

export class CursorAdapter implements AiGatewayAdapter {
  private readonly origin: string;
  private readonly clientVersion: string;
  private readonly idleTimeoutMs: number;
  private readonly sessionId = randomUUID();
  private readonly conversationId: string;

  constructor(options: CursorAdapterOptions = {}) {
    this.origin = options.origin ?? CURSOR_API_ORIGIN;
    this.clientVersion = options.clientVersion ?? CURSOR_CLIENT_VERSION;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 180_000;
    this.conversationId = options.conversationId ?? `cursor_${randomUUID().replace(/-/g, "")}`;
  }

  async stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions,
  ): Promise<AdapterResponse> {
    const plan = buildCursorRunPlan(request, this.conversationId);
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
    // 스트림을 닫지 않는다. KV 응답과 interaction 응답을 같은 스트림으로 계속 써야 한다.
    stream.write(encodeConnectFrame(plan.payload));

    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      events: mapCursorStream(stream, request.model, plan.blobs, () => {
        options.signal?.removeEventListener("abort", abort);
        session.close();
      }),
    };
  }
}

/**
 * KV와 interaction 응답은 이벤트 소비자를 기다리면 안 된다. generator는 소비자가 다음 값을
 * 당길 때까지 멈추는데, 서버는 그 응답이 올 때까지 블록하므로 곧장 stall로 이어진다.
 * 그래서 프레임은 data 리스너에서 즉시 처리하고, 모델 이벤트만 큐를 통해 흘려보낸다.
 */
function mapCursorStream(
  stream: http2.ClientHttp2Stream,
  model: string,
  blobs: BlobStore,
  onClose: () => void,
): AsyncGenerator<CanonicalResponseEvent> {
  const responseId = `cursor_${randomUUID()}`;
  const itemId = `msg_${randomUUID()}`;
  const queue: CanonicalResponseEvent[] = [];
  const waiters: Array<() => void> = [];
  let buffer: Buffer = Buffer.alloc(0);
  let started = false;
  let finished = false;
  let failure: Error | null = null;
  let outputIndex = 0;
  const toolItems = new Map<string, { itemId: string; index: number; name: string }>();

  const wake = (): void => {
    while (waiters.length > 0) waiters.shift()?.();
  };
  const emit = (event: CanonicalResponseEvent): void => {
    if (!started) {
      started = true;
      queue.push({ type: "response.created", response: { id: responseId, model, usage: null } });
    }
    queue.push(event);
    wake();
  };
  const finish = (error?: Error): void => {
    if (finished) return;
    finished = true;
    if (error) failure = error;
    else if (started) queue.push({ type: "response.completed", response: { id: responseId, model, usage: null } });
    wake();
  };

  stream.on("data", (chunk: Uint8Array) => {
    buffer = Buffer.concat([buffer, chunk]) as Buffer;
    const decoded = decodeConnectFrames(buffer);
    buffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (!isRecord(frame)) continue;
      if (isRecord(frame.kvServerMessage)) {
        stream.write(encodeConnectFrame(kvReply(frame.kvServerMessage, blobs)));
        continue;
      }
      if (isRecord(frame.interactionQuery)) {
        stream.write(encodeConnectFrame({ interactionResponse: { id: frame.interactionQuery.id ?? 0 } }));
        continue;
      }
      if (isRecord(frame.error)) {
        emit({ type: "error", error: cursorError(frame.error) });
        finish();
        continue;
      }
      const update = isRecord(frame.interactionUpdate) ? frame.interactionUpdate : undefined;
      if (update === undefined) continue;

      if (isRecord(update.textDelta) && typeof update.textDelta.text === "string") {
        emit({
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: update.textDelta.text,
        });
      } else if (isRecord(update.toolCallStarted)) {
        const call = toolCallInfo(update.toolCallStarted);
        if (call) {
          outputIndex += 1;
          const entry = { itemId: call.callId, index: outputIndex, name: call.name };
          toolItems.set(call.callId, entry);
          emit({
            type: "response.output_item.added",
            output_index: entry.index,
            item: { id: entry.itemId, type: "function_call", call_id: call.callId, name: call.name, arguments: "" },
          });
        }
      } else if (isRecord(update.partialToolCall)) {
        const callId = typeof update.partialToolCall.callId === "string" ? update.partialToolCall.callId : undefined;
        const delta = typeof update.partialToolCall.argsTextDelta === "string" ? update.partialToolCall.argsTextDelta : "";
        const entry = callId === undefined ? undefined : toolItems.get(callId);
        if (entry && delta.length > 0) {
          emit({ type: "response.function_call_arguments.delta", item_id: entry.itemId, output_index: entry.index, delta });
        }
      } else if (isRecord(update.toolCallCompleted)) {
        const callId = typeof update.toolCallCompleted.callId === "string" ? update.toolCallCompleted.callId : undefined;
        const entry = callId === undefined ? undefined : toolItems.get(callId);
        if (entry) {
          emit({
            type: "response.output_item.done",
            output_index: entry.index,
            item: { id: entry.itemId, type: "function_call", call_id: entry.itemId, name: entry.name, arguments: "" },
          });
        }
      } else if (isRecord(update.turnEnded)) {
        finish();
      }
    }
  });
  stream.on("error", (error: Error) => finish(error));
  stream.on("end", () => finish());
  stream.on("close", () => finish());

  return (async function* () {
    try {
      for (;;) {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) yield next;
        }
        if (failure) throw failure;
        if (finished) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    } finally {
      onClose();
    }
  })();
}

function kvReply(kv: Record<string, unknown>, blobs: BlobStore): unknown {
  const id = kv.id ?? 0;
  if (isRecord(kv.getBlobArgs)) {
    const blobId = typeof kv.getBlobArgs.blobId === "string" ? kv.getBlobArgs.blobId : "";
    const blobData = blobs.get(blobId);
    return { kvClientMessage: { id, getBlobResult: blobData ? { blobData } : {} } };
  }
  if (isRecord(kv.setBlobArgs)) {
    const blobId = typeof kv.setBlobArgs.blobId === "string" ? kv.setBlobArgs.blobId : "";
    const blobData = typeof kv.setBlobArgs.blobData === "string" ? kv.setBlobArgs.blobData : "";
    if (blobId) blobs.set(blobId, blobData);
    return { kvClientMessage: { id, setBlobResult: {} } };
  }
  return { kvClientMessage: { id } };
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
