import { createHash, randomUUID } from "node:crypto";
import http2 from "node:http2";

import {
  fromBinary,
  fromJson,
  toBinary,
  toJson,
  type JsonValue,
  type UnknownField,
} from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";

import type {
  AdapterCallOptions,
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalFunctionTool,
  CanonicalInputItem,
  CanonicalNativeTool,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CanonicalUsage,
  ReasoningEffort,
} from "../../canonical/index.js";
import {
  ContextWindowExceededError,
  canonicalMessageImages,
  canonicalMessageText,
} from "../../canonical/index.js";
import { cursorNativeExecPolicyReplies } from "./exec-policy.js";
import { wireLog } from "../../transport/wire-log.js";
import {
  cursorUnknownExecCaseName,
  cursorUnknownExecReply,
} from "./unknown-exec.js";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  UserMessageSchema,
} from "./generated/cursor-agent-protobuf.js";
import { resolveCursorModelSelection } from "../../models.js";
import { estimateTokens } from "../../transport/token-estimate.js";

export const CURSOR_API_ORIGIN = "https://api2.cursor.sh";
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
export const CURSOR_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
// Live tool bridge에서 검증한 프로토콜 버전. 모델 discovery에 사용한
// 로컬 Cursor CLI 버전과 transport wire version은 같은 수명주기가 아니다.
export const CURSOR_CLIENT_VERSION = "cli-2026.07.08-0c04a8a";
export const CURSOR_TOOL_COUNT_LIMIT = 330;
export const CURSOR_TOOL_BYTES_LIMIT = 120_000;
export const CURSOR_TOOL_PROVIDER_IDENTIFIER = "fleet-gateway";
export const CURSOR_TOOL_FINALIZE_GRACE_MS = 50;
export const CURSOR_CLIENT_HEARTBEAT_MS = 5_000;
export const CURSOR_PENDING_LIVE_RUN_TTL_MS = 5 * 60_000;
export const CURSOR_PENDING_LIVE_RUN_CAPACITY = 64;
export const CONNECT_FLAG_COMPRESSED = 0x01;
export const CONNECT_FLAG_END_STREAM = 0x02;

const CURSOR_UNKNOWN_EXEC_FIELDS = Symbol("cursorUnknownExecFields");

const CURSOR_TOOL_LIMIT_NOTE_PREFIX = "[fleet-ai-gateway]";

export class CursorRequestBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorRequestBudgetError";
  }
}

/**
 * Cursor 경로는 Claude session `metadata.user_id`로 conversation/x-session-id를 고정한다.
 * 값이 없으면 턴마다 새 대화를 열게 되므로 요청을 거절한다.
 */
export class CursorSessionIdentityError extends Error {
  constructor(message = "Cursor gateway requests require metadata.user_id") {
    super(message);
    this.name = "CursorSessionIdentityError";
  }
}

export interface CursorAdapterOptions {
  readonly origin?: string;
  readonly clientVersion?: string;
  readonly idleTimeoutMs?: number;
  /** Opt in to Cursor Max Mode for this adapter instance. Omitted by default. */
  readonly maxMode?: boolean;
  /**
   * 테스트용 conversationId 덮어쓰기. 운영 경로에서는 `metadata.user_id`에서 유도한 값을 쓴다.
   */
  readonly conversationId?: string;
  /**
   * 테스트용 x-session-id 덮어쓰기. 운영 경로에서는 `metadata.user_id`에서 결정적으로 유도한다.
   */
  readonly sessionId?: string;
  /** 테스트나 임베디드 transport가 HTTP/2 연결을 대체하는 명시적 seam. */
  readonly connect?: typeof http2.connect;
  /** 병렬 sibling tool call을 한 프레임 늦게 받는 경우를 위한 짧은 종료 유예. */
  readonly toolFinalizeGraceMs?: number;
  /** Cursor agent stream liveness interval. Exposed for deterministic transport tests. */
  readonly clientHeartbeatMs?: number;
  /** Maximum time a client-tool-suspended Run remains attachable. */
  readonly pendingLiveRunTtlMs?: number;
  /** Maximum number of parked Runs retained by this adapter instance. */
  readonly pendingLiveRunCapacity?: number;
  /**
   * Payload-free transport diagnostics. Implementations must not throw; the adapter also isolates
   * callback failures so observability can never affect a model turn.
   */
  readonly diagnostics?: CursorDiagnosticSink;
}

export type CursorDiagnosticEventName =
  | "turn.start"
  | "model.switch"
  | "transport.dial"
  | "transport.connected"
  | "transport.timeout"
  | "transport.semantic_timeout"
  | "transport.abort"
  | "transport.session_error"
  | "transport.stream_error"
  | "transport.end"
  | "transport.close"
  | "client.request"
  | "client.heartbeat"
  | "client.reply"
  | "server.frame"
  | "bridge.park"
  | "bridge.attach"
  | "bridge.expire"
  | "bridge.mismatch"
  | "turn.finish";

/** Mid-session wire-model switches keyed by credential-partitioned conversation identity. */
const CURSOR_WIRE_MODEL_BY_STATE = new Map<string, string>();
interface CursorContextCheckpoint {
  readonly contextTokens: number;
  readonly contextWindow?: number;
}

interface StoredCursorContextCheckpoint extends CursorContextCheckpoint {
  readonly wireModelId: string;
  readonly credentialFingerprint: string;
  /**
   * 이 체크포인트를 측정한 요청 자체의 입력 추정치. 대화가 그만큼 크다는 전제가
   * 무너졌는지 판정하는 기준선이며, 체크포인트 값과는 다른 좌표다.
   */
  readonly requestInputTokens: number;
}

/** Last authoritative Cursor checkpoint for a credential-partitioned conversation and wire model. */
const CURSOR_CONTEXT_CHECKPOINT_BY_STATE = new Map<
  string,
  StoredCursorContextCheckpoint
>();
const CURSOR_CONVERSATION_MEMORY_LIMIT = 512;

/**
 * Safe-by-construction Cursor diagnostic shape. It intentionally has no prompt, output, tool
 * payload, credential, or upstream/session/call identifier fields.
 */
export interface CursorDiagnosticEvent {
  readonly timestamp: string;
  readonly runId: string;
  readonly event: CursorDiagnosticEventName;
  readonly elapsedMs: number;
  readonly model?: string;
  readonly wireModel?: string;
  /** Previous Cursor wire model for mid-session switches. Never a raw user/session id. */
  readonly previousWireModel?: string;
  readonly requestedEffort?: ReasoningEffort;
  readonly turn?: "prompt" | "tool-continuation";
  readonly frame?: string;
  readonly reply?: string;
  readonly sequence?: number;
  readonly count?: number;
  readonly frameCount?: number;
  readonly lastFrame?: string;
  readonly toolCount?: number;
  /** Count of schema-guided scalar repairs; never includes argument names or values. */
  readonly argumentRepairCount?: number;
  readonly estimatedInputTokens?: number;
  /** Cursor checkpoint's absolute occupied-context count. */
  readonly contextTokens?: number;
  /** Cursor checkpoint's runtime context limit for the concrete routed model. */
  readonly contextWindow?: number;
  readonly outcome?: string;
  readonly error?: string;
}

export type CursorDiagnosticSink = (event: CursorDiagnosticEvent) => void;

export interface CursorConnectFrame {
  readonly flags: number;
  readonly payload: Uint8Array;
}

/** Connect streaming 프레임: [flag:1][length:4 BE][protobuf payload]. */
export function encodeConnectFrame(payload: Uint8Array, flags = 0): Buffer {
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    throw new RangeError(`Connect frame flags must be a byte: ${flags}`);
  }
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

export function decodeConnectFrames(
  buffer: Buffer,
): { frames: CursorConnectFrame[]; rest: Buffer } {
  const frames: CursorConnectFrame[] = [];
  let offset = 0;
  while (offset + 5 <= buffer.byteLength) {
    const flags = buffer.readUInt8(offset);
    const length = buffer.readUInt32BE(offset + 1);
    if (offset + 5 + length > buffer.byteLength) break;
    const payload = buffer.subarray(offset + 5, offset + 5 + length);
    offset += 5 + length;
    frames.push({ flags, payload });
  }
  return { frames, rest: buffer.subarray(offset) as Buffer };
}

function encodeCursorClientMessage(payload: unknown): Buffer {
  const message = fromJson(AgentClientMessageSchema, payload as JsonValue);
  return encodeConnectFrame(toBinary(AgentClientMessageSchema, message));
}

type CursorServerFrame = Record<string, unknown> & {
  readonly [CURSOR_UNKNOWN_EXEC_FIELDS]?: readonly UnknownField[];
};

function decodeCursorServerMessage(payload: Uint8Array): CursorServerFrame {
  const message = fromBinary(AgentServerMessageSchema, payload);
  const unknownExecFields = extractCursorUnknownExecFields(message);
  const json = toJson(AgentServerMessageSchema, message);
  if (!isRecord(json)) throw new TypeError("Cursor server frame was not a message object");
  if (unknownExecFields.length > 0) {
    Object.defineProperty(json, CURSOR_UNKNOWN_EXEC_FIELDS, { value: unknownExecFields });
  }
  return json as CursorServerFrame;
}

function extractCursorUnknownExecFields(message: unknown): readonly UnknownField[] {
  if (!isRecord(message) || !isRecord(message.message)) return [];
  if (message.message.case !== "execServerMessage" || !isRecord(message.message.value)) return [];
  const fields = message.message.value.$unknown;
  if (!Array.isArray(fields)) return [];
  return fields.filter((field): field is UnknownField => (
    isRecord(field)
      && typeof field.no === "number"
      && typeof field.wireType === "number"
      && field.data instanceof Uint8Array
  ));
}

export function parseConnectEndStreamError(payload: Uint8Array): Error | null {
  try {
    const parsed = JSON.parse(Buffer.from(payload).toString("utf8")) as {
      readonly error?: { readonly code?: string; readonly message?: string };
    };
    if (!parsed.error) return null;
    return new Error(
      `Cursor Connect error ${parsed.error.code ?? "unknown"}: ${parsed.error.message ?? "Unknown error"}`,
    );
  } catch (error) {
    return error instanceof SyntaxError
      ? new Error("Cursor Connect end-stream payload was invalid JSON")
      : error instanceof Error
        ? error
        : new Error(String(error));
  }
}

/**
 * Cursor는 프롬프트를 blob으로 주고받는다. rootPromptMessagesJson에는 blob ID만 싣고
 * 서버가 getBlobArgs로 바이트를 되가져간다. ID는 내용의 SHA-256이다.
 */
class BlobStore {
  private readonly values = new Map<string, string>();
  private decodedBytes = 0;

  putSerialized(serialized: string): string {
    return this.putBytes(Buffer.from(serialized, "utf8"));
  }

  putBytes(value: Uint8Array): string {
    const data = Buffer.from(value);
    const id = createHash("sha256").update(data).digest("base64");
    this.store(id, data.toString("base64"), data.byteLength);
    return id;
  }

  set(id: string, base64Data: string): void {
    this.store(id, base64Data, Buffer.byteLength(base64Data, "base64"));
  }

  get(id: string): string | undefined {
    return this.values.get(id);
  }

  /**
   * Bodies this request could be asked for, against what a turn actually transmits.
   * Cursor pulls blobs on demand, so the two would diverge if it ever cached one
   * between turns; measured on 2026-08-05 it never did, and every root came back in
   * full on each request.
   */
  inventory(): { readonly count: number; readonly bytes: number } {
    return { count: this.values.size, bytes: this.decodedBytes };
  }

  private store(id: string, base64Data: string, byteLength: number): void {
    // Ids are content hashes, so a repeat put is the same body; count it once but keep
    // the write so `set` retains its overwrite semantics.
    if (!this.values.has(id)) this.decodedBytes += byteLength;
    this.values.set(id, base64Data);
  }
}

export interface CursorRunPlan {
  readonly payload: unknown;
  readonly blobs: BlobStore;
  readonly tools: readonly CursorWireTool[];
  readonly wireModelId: string;
  /** Request-local estimate from the exact root/action text sent to Cursor. */
  readonly estimatedInputTokens: number;
  /**
   * Size of the replay this turn re-uploads. Cursor caches nothing between turns —
   * every root is pulled back in full on each request — so this grows with the whole
   * conversation and is the transport's real cost. It is diagnostic only: a local cap
   * on it once refused sessions at ~48% of the model's window, and a measurement
   * against Cursor showed 858 KB / 117 roots accepted, so the token window is the only
   * ceiling the gateway enforces. Do not restore a byte or root cap without an
   * observed upstream refusal to size it from.
   */
  readonly replayRootCount: number;
  readonly replayBytes: number;
}

interface CursorWireTool {
  readonly clientName: string;
  /** Original client schema retained only for response-side compatibility repair. */
  readonly inputSchemaValue: Record<string, unknown>;
  readonly name: string;
  readonly toolName: string;
  readonly description: string;
  readonly providerIdentifier: string;
  readonly inputSchema: string;
}

interface CursorToolBudget {
  readonly tools: readonly CursorWireTool[];
  readonly omittedNames: readonly string[];
}

interface CursorRootEntry {
  readonly serialized: string;
  readonly byteLength: number;
  readonly role: "system" | "user" | "assistant" | "toolResult";
  readonly text?: string;
}

export function buildCursorRunPlan(
  request: CanonicalResponseRequest,
  conversationId: string,
  options: { readonly maxMode?: boolean } = {},
): CursorRunPlan {
  const modelSelection = resolveCursorModelSelection(request.model, request.reasoning?.effort);
  const wireModelId = modelSelection.upstreamModelId;
  const maxMode = options.maxMode ?? modelSelection.maxMode;
  const blobs = new BlobStore();
  const toolBudget = applyCursorToolBudget(request);
  const limitNote = cursorToolLimitNote(toolBudget);
  const nativeTools = request.native_tools ?? [];
  const instructions = [
    request.instructions?.trim(),
    cursorNativeToolGuidance(nativeTools),
    cursorToolGuidance(toolBudget.tools, nativeTools),
    limitNote,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  const roots: CursorRootEntry[] = [rootEntry({
    role: "system",
    content: instructions && instructions.length > 0 ? instructions : "You are a helpful assistant.",
  }, "system")];

  // 마지막 항목이 tool 결과면 이어가기 턴이다. 그때는 새 사용자 메시지 없이 resume한다.
  const last = request.input.at(-1);
  const isToolContinuation = last?.type === "function_call_output";
  const activeIndex = isToolContinuation ? -1 : lastUserIndex(request.input);
  const toolNames = new Map(
    request.input
      .filter((item): item is Extract<CanonicalInputItem, { type: "function_call" }> => item.type === "function_call")
      .map((item) => [item.call_id, item.name]),
  );

  for (let i = 0; i < request.input.length; i += 1) {
    if (i === activeIndex) break;
    const item = request.input[i];
    if (!item) continue;
    const entry = historyRoot(item, toolNames);
    if (entry) roots.push(entry);
  }

  const activeMessage = activeIndex >= 0 ? request.input[activeIndex] : undefined;
  const activeReplayRoot = activeMessage ? historyRoot(activeMessage, toolNames) : null;
  const replayRoots = activeReplayRoot ? [...roots, activeReplayRoot] : roots;
  const rootIds = roots.map((entry) => blobs.putSerialized(entry.serialized));
  const turnIds = buildCursorConversationTurns(request, blobs, activeIndex, toolBudget.tools);

  const activeText = messageText(activeMessage);
  const activeImages = messageImages(activeMessage);
  const estimatedInputTokens = estimateTokens(
    [
      ...roots.map((entry) => entry.serialized),
      ...(activeText.length > 0 ? [activeText] : []),
    ].join("\n"),
    wireModelId,
  );
  const action = isToolContinuation || (activeText.trim().length === 0 && activeImages.length === 0)
    ? { resumeAction: { requestContext: { env: { timeZone: runtimeTimeZone() } } } }
    : {
      userMessageAction: {
        userMessage: cursorUserMessagePayload(activeText, activeImages),
        requestContext: { env: { timeZone: runtimeTimeZone() } },
      },
    };

  const runRequest: Record<string, unknown> = {
    conversationId,
    conversationState: { rootPromptMessagesJson: rootIds, turns: turnIds },
    action,
    modelDetails: {
      modelId: wireModelId,
      displayModelId: wireModelId,
      displayName: wireModelId,
      displayNameShort: wireModelId,
      ...(maxMode ? { maxMode: true } : {}),
    },
  };
  if (toolBudget.tools.length > 0) {
    runRequest.mcpTools = {
      mcpTools: toolBudget.tools.map(cursorWireToolDefinition),
    };
  }
  return {
    payload: { runRequest },
    blobs,
    tools: toolBudget.tools,
    wireModelId,
    estimatedInputTokens,
    replayRootCount: replayRoots.length,
    replayBytes: rootBytes(replayRoots),
  };
}

function lastUserIndex(input: readonly CanonicalInputItem[]): number {
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (item?.type === "message" && (item.role === "user" || item.role === "developer")) return i;
  }
  return -1;
}

function messageText(item: CanonicalInputItem | undefined): string {
  return item?.type === "message" ? canonicalMessageText(item.content) : "";
}

function messageImages(item: CanonicalInputItem | undefined): ReturnType<typeof canonicalMessageImages> {
  return item?.type === "message" ? canonicalMessageImages(item.content) : [];
}

function cursorUserMessagePayload(
  text: string,
  images: ReturnType<typeof canonicalMessageImages>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    text,
    messageId: randomUUID(),
  };
  const selectedImages = cursorSelectedImages(images);
  if (selectedImages.length > 0) {
    payload.selectedContext = { selectedImages };
  }
  return payload;
}

/**
 * Cursor accepts images only through SelectedContext.selectedImages.
 * Root prompt JSON content parts are text-only — `image_url` is rejected upstream.
 */
function cursorSelectedImages(
  images: ReturnType<typeof canonicalMessageImages>,
): Array<Record<string, unknown>> {
  return images.flatMap((image, index) => {
    const parsed = parseCanonicalImageUrl(image.image_url);
    if (!parsed.data && !parsed.path) {
      return [];
    }
    const mimeType = parsed.mimeType ?? "image/png";
    return [{
      uuid: randomUUID(),
      path: parsed.path ?? `claude-image-${index + 1}.${imageExtension(mimeType)}`,
      mimeType,
      ...(parsed.data && parsed.data.length > 0 ? { data: parsed.data } : {}),
    }];
  });
}

function parseCanonicalImageUrl(imageUrl: string): {
  mimeType?: string;
  data?: string;
  path?: string;
} {
  const dataUrl = /^data:([^;,]+);base64,([\s\S]+)$/.exec(imageUrl);
  if (dataUrl) {
    return {
      mimeType: dataUrl[1],
      data: dataUrl[2],
    };
  }
  return { path: imageUrl };
}

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/png":
    default:
      return "png";
  }
}

interface CursorConversationTurn {
  readonly userMessage: string;
  readonly steps: string[];
}

function buildCursorConversationTurns(
  request: CanonicalResponseRequest,
  blobs: BlobStore,
  activeIndex: number,
  tools: readonly CursorWireTool[],
): string[] {
  const history = activeIndex < 0 ? request.input : request.input.slice(0, activeIndex);
  const turns: string[] = [];
  const pendingCalls = new Map<string, Extract<CanonicalInputItem, { type: "function_call" }>>();
  let current: CursorConversationTurn | undefined;

  const flush = (): void => {
    if (!current) return;
    for (const call of pendingCalls.values()) {
      current.steps.push(storeCursorToolCallStep(blobs, call, tools));
    }
    const turn = fromJson(ConversationTurnStructureSchema, {
      agentConversationTurn: {
        userMessage: current.userMessage,
        steps: current.steps,
      },
    });
    turns.push(blobs.putBytes(toBinary(ConversationTurnStructureSchema, turn)));
    current = undefined;
    pendingCalls.clear();
  };

  for (const item of history) {
    if (item.type === "message" && (item.role === "user" || item.role === "developer")) {
      flush();
      const userMessage = fromJson(
        UserMessageSchema,
        cursorUserMessagePayload(
          canonicalMessageText(item.content),
          canonicalMessageImages(item.content),
        ) as JsonValue,
      );
      current = {
        userMessage: blobs.putBytes(toBinary(UserMessageSchema, userMessage)),
        steps: [],
      };
      continue;
    }
    if (!current) continue;
    if (item.type === "message") {
      const text = canonicalMessageText(item.content);
      if (text.length > 0) {
        current.steps.push(storeCursorAssistantStep(blobs, text));
      }
      continue;
    }
    if (item.type === "function_call") {
      pendingCalls.set(item.call_id, item);
      continue;
    }

    const call = pendingCalls.get(item.call_id);
    if (call) {
      current.steps.push(storeCursorToolCallStep(
        blobs,
        call,
        tools,
        item.output,
        item.is_error === true,
      ));
      pendingCalls.delete(item.call_id);
    } else {
      current.steps.push(storeCursorAssistantStep(blobs, `[Tool Result]\n${item.output}`));
    }
  }
  flush();
  return turns;
}

function storeCursorAssistantStep(blobs: BlobStore, text: string): string {
  const step = fromJson(ConversationStepSchema, { assistantMessage: { text } });
  return blobs.putBytes(toBinary(ConversationStepSchema, step));
}

function storeCursorToolCallStep(
  blobs: BlobStore,
  call: Extract<CanonicalInputItem, { type: "function_call" }>,
  tools: readonly CursorWireTool[],
  output?: string,
  isError = false,
): string {
  const wireName = cursorWireNameForClient(call.name, tools);
  const step = fromJson(ConversationStepSchema, {
    toolCall: {
      mcpToolCall: {
        args: {
          name: wireName,
          toolName: wireName,
          toolCallId: call.call_id,
          providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
          args: cursorToolArgumentBytes(call.arguments),
        },
        ...(output === undefined
          ? {}
          : {
            result: {
              success: {
                isError,
                content: [{ text: { text: output } }],
              },
            },
          }),
      },
    },
  });
  return blobs.putBytes(toBinary(ConversationStepSchema, step));
}

function cursorToolArgumentBytes(argumentsText: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).map(([name, value]) => [
    name,
    Buffer.from(toBinary(ValueSchema, fromJson(ValueSchema, value as JsonValue))).toString("base64"),
  ]));
}

/**
 * Cursor는 히스토리를 OpenAI 스타일 content part로 기대한다. assistant의 tool 호출은
 * 눈에 보이는 텍스트로 되살리지 않는다 — 짝이 되는 tool 결과가 call id와 출력을 나른다.
 * 이미지는 root content part로 실을 수 없다(`image_url` → Connect internal 오류).
 * 실제 바이트는 conversation-turn UserMessage.selectedContext로만 전달한다.
 */
function historyRoot(
  item: CanonicalInputItem,
  toolNames: ReadonlyMap<string, string>,
): CursorRootEntry | null {
  if (item.type === "message") {
    const text = canonicalMessageText(item.content).trim();
    const imageCount = canonicalMessageImages(item.content).length;
    const body = text.length > 0
      ? text
      : imageCount > 0
        ? `[${imageCount} image${imageCount === 1 ? "" : "s"}]`
        : "";
    if (body.length === 0) return null;
    const role = item.role === "assistant" ? "assistant" : "user";
    return rootEntry({ role, content: [{ type: "text", text: body }] }, role, body);
  }
  if (item.type === "function_call_output") {
    const toolName = toolNames.get(item.call_id);
    const text = [
      "[Tool Result]",
      "[tool_result]",
      `call_id: ${item.call_id}`,
      ...(toolName ? [`name: ${toolName}`] : []),
      `is_error: ${item.is_error === true}`,
      "output:",
      item.output,
    ].join("\n");
    return rootEntry({ role: "user", content: [{ type: "text", text }] }, "toolResult", text);
  }
  return null;
}

function rootEntry(
  value: unknown,
  role: CursorRootEntry["role"],
  text?: string,
): CursorRootEntry {
  const serialized = JSON.stringify(value);
  return {
    serialized,
    byteLength: Buffer.byteLength(serialized, "utf8"),
    role,
    ...(text === undefined ? {} : { text }),
  };
}

function runtimeTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function applyCursorToolBudget(request: CanonicalResponseRequest): CursorToolBudget {
  const declaredTools = request.tools ?? [];
  const selectedName = typeof request.tool_choice === "object" ? request.tool_choice.name : undefined;
  const referencedNames = cursorReferencedToolNames(request.input);
  const supportsDeferredLoading = declaredTools.some((tool) => isCursorToolSearchName(tool.name));
  // Preserve legacy callers that attach defer_loading metadata without exposing ToolSearch.
  const sourceTools = supportsDeferredLoading
    ? declaredTools.filter((tool) => (
        tool.defer_loading !== true
        || isCursorToolSearchName(tool.name)
        || referencedNames.has(tool.name)
        || cursorToolMatches(tool.name, selectedName)
      ))
    : declaredTools;
  const wireTools = sourceTools.map(toCursorWireTool);
  if (
    wireTools.length <= CURSOR_TOOL_COUNT_LIMIT
    && cursorToolPayloadBytes(wireTools) <= CURSOR_TOOL_BYTES_LIMIT
  ) {
    return { tools: wireTools, omittedNames: [] };
  }

  const candidates = sourceTools
    .map((tool, index) => ({
      index,
      priority: cursorToolPriority(tool.name, selectedName, referencedNames.has(tool.name)),
      wire: wireTools[index]!,
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);
  const keptIndexes = new Set<number>();
  const keptWire: CursorWireTool[] = [];
  let byteLength = cursorToolPayloadBytes([]);

  const tryKeep = (candidate: typeof candidates[number]): void => {
    if (keptIndexes.has(candidate.index) || keptWire.length >= CURSOR_TOOL_COUNT_LIMIT) return;
    const candidateBytes = Buffer.byteLength(
      JSON.stringify(cursorWireToolDefinition(candidate.wire)),
      "utf8",
    )
      + (keptWire.length === 0 ? 0 : 1);
    if (byteLength + candidateBytes > CURSOR_TOOL_BYTES_LIMIT) return;
    keptIndexes.add(candidate.index);
    keptWire.push(candidate.wire);
    byteLength += candidateBytes;
  };

  for (const candidate of candidates) {
    if (candidate.priority <= 2) tryKeep(candidate);
  }
  for (const candidate of candidates) {
    tryKeep(candidate);
  }

  if (selectedName) {
    const selectedIndex = sourceTools.findIndex((tool) => cursorToolMatches(tool.name, selectedName));
    if (selectedIndex >= 0 && !keptIndexes.has(selectedIndex)) {
      throw new CursorRequestBudgetError(
        `Selected Cursor tool "${selectedName}" exceeds the transport budget`,
      );
    }
  }

  return {
    tools: wireTools.filter((_, index) => keptIndexes.has(index)),
    omittedNames: sourceTools
      .filter((_, index) => !keptIndexes.has(index))
      .map((tool) => tool.name),
  };
}

function toCursorWireTool(
  tool: NonNullable<CanonicalResponseRequest["tools"]>[number],
): CursorWireTool {
  const wireName = cursorWireToolName(tool.name);
  return {
    clientName: tool.name,
    inputSchemaValue: tool.parameters,
    name: wireName,
    toolName: wireName,
    description: tool.description ?? "",
    providerIdentifier: CURSOR_TOOL_PROVIDER_IDENTIFIER,
    // The plan uses protobuf's JSON representation, where bytes are base64. The binary
    // transport decodes this field back to a serialized google.protobuf.Value.
    inputSchema: Buffer.from(toBinary(
      ValueSchema,
      fromJson(ValueSchema, tool.parameters as JsonValue),
    )).toString("base64"),
  };
}

const CURSOR_PASSTHROUGH_TOOL_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * Cursor reserves several title-cased names for native tools. Claude Code exposes its own tools
 * with those same names, so isolate unsafe names behind a stable lowercase wire alias and map them
 * back at the adapter boundary.
 */
function cursorWireToolName(clientName: string): string {
  if (CURSOR_PASSTHROUGH_TOOL_NAME.test(clientName)) return clientName;
  const slug = clientName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "tool";
  const digest = createHash("sha256").update(clientName).digest("hex").slice(0, 8);
  return `cc_${slug}_${digest}`;
}

function cursorWireToolDefinition(
  tool: CursorWireTool,
): Omit<CursorWireTool, "clientName" | "inputSchemaValue"> {
  return {
    name: tool.name,
    toolName: tool.toolName,
    description: tool.description,
    providerIdentifier: tool.providerIdentifier,
    inputSchema: tool.inputSchema,
  };
}

function cursorWireNameForClient(
  clientName: string,
  tools: readonly CursorWireTool[],
): string {
  return tools.find((tool) => tool.clientName === clientName)?.toolName
    ?? cursorWireToolName(clientName);
}

function cursorToolPayloadBytes(tools: readonly CursorWireTool[]): number {
  return Buffer.byteLength(JSON.stringify({
    mcpTools: { mcpTools: tools.map(cursorWireToolDefinition) },
  }), "utf8");
}

function cursorToolPriority(
  name: string,
  selectedName: string | undefined,
  loadedFromToolSearch: boolean,
): number {
  const leafName = cursorToolLeafName(name);
  if (leafName === "exec_command" || leafName === "shell_command") return 0;
  if (leafName === "apply_patch") return 1;
  if (cursorToolMatches(name, selectedName)) return 2;
  if (loadedFromToolSearch || isCursorToolSearchName(name)) return 3;
  return name.includes("__") ? 5 : 4;
}

function cursorToolMatches(name: string, selectedName: string | undefined): boolean {
  return selectedName !== undefined
    && (name === selectedName || cursorToolLeafName(name) === cursorToolLeafName(selectedName));
}

function cursorReferencedToolNames(input: readonly CanonicalInputItem[]): ReadonlySet<string> {
  return new Set(input.flatMap((item) => (
    item.type === "function_call_output" ? item.tool_references ?? [] : []
  )));
}

function isCursorToolSearchName(name: string): boolean {
  return cursorToolLeafName(name).replace(/[_-]/g, "").toLowerCase() === "toolsearch";
}

function cursorToolLeafName(name: string): string {
  return name.split("__").at(-1) ?? name;
}

function cursorToolLimitNote(budget: CursorToolBudget): string | undefined {
  if (budget.omittedNames.length === 0) return undefined;
  const names = budget.omittedNames.slice(0, 12);
  const remainder = budget.omittedNames.length - names.length;
  const summary = `${names.join(", ")}${remainder > 0 ? `, and ${remainder} more` : ""}`;
  const toolSearch = budget.tools.find((tool) => isCursorToolSearchName(tool.clientName));
  const total = budget.tools.length + budget.omittedNames.length;
  return toolSearch
    ? `${CURSOR_TOOL_LIMIT_NOTE_PREFIX} Cursor transport limits expose ${budget.tools.length} of ${total} tools this turn. Omitted: ${summary}. Use ${toolSearch.toolName} to load an omitted tool when needed.`
    : `${CURSOR_TOOL_LIMIT_NOTE_PREFIX} Cursor transport limits expose ${budget.tools.length} of ${total} tools this turn. Omitted and unavailable this turn: ${summary}.`;
}

function cursorNativeToolGuidance(tools: readonly CanonicalNativeTool[]): string | undefined {
  const webSearch = tools.find((tool) => tool.type === "web_search");
  if (!webSearch) return undefined;
  const guidance = [
    "Cursor-native web search is available for this request.",
    webSearch.required
      ? "Use native web search before answering this request."
      : "Use native web search when the request requires current web information.",
  ];
  if (webSearch.allowed_domains && webSearch.allowed_domains.length > 0) {
    guidance.push(`Restrict results to these domains: ${webSearch.allowed_domains.join(", ")}.`);
  }
  if (webSearch.blocked_domains && webSearch.blocked_domains.length > 0) {
    guidance.push(`Exclude results from these domains: ${webSearch.blocked_domains.join(", ")}.`);
  }
  if (webSearch.max_uses !== undefined) {
    guidance.push(`Use no more than ${webSearch.max_uses} searches.`);
  }
  return guidance.join(" ");
}

function cursorToolGuidance(
  tools: readonly CursorWireTool[],
  nativeTools: readonly CanonicalNativeTool[],
): string | undefined {
  if (tools.length === 0) return undefined;
  const names = tools.map((tool) => `\`${tool.toolName}\``).join(", ");
  return [
    `Cursor tool calls: available tool names are exactly ${names}.`,
    "Use the current tool catalog as ground truth and call only those exact names with their listed argument keys.",
    "Every tool call must include valid JSON arguments satisfying its input schema, including every required field.",
    cursorClientToolDiscipline(tools, nativeTools),
  ].join(" ");
}

function cursorClientToolDiscipline(
  tools: readonly CursorWireTool[],
  nativeTools: readonly CanonicalNativeTool[],
): string {
  const bash = findCursorToolName(tools, ["Bash", "shell_command", "exec_command"]);
  const read = findCursorToolName(tools, ["Read"]);
  const edit = findCursorToolName(tools, ["Edit", "apply_patch"]);
  const write = findCursorToolName(tools, ["Write", "apply_patch"]);
  const grep = findCursorToolName(tools, ["Grep"]);
  const glob = findCursorToolName(tools, ["Glob"]);
  const toolSearch = tools.find((tool) => isCursorToolSearchName(tool.clientName))?.toolName;
  const nativeWebSearch = nativeTools.some((tool) => tool.type === "web_search");
  const guidance = [
    nativeWebSearch
      ? "Do not invoke Cursor-native filesystem, shell, or editing tools in gateway mode; native web search is the only exception. Call the advertised client bridge tools for every other action."
      : "Do not invoke Cursor-native tools in gateway mode; call the advertised client bridge tools directly.",
  ];
  if (toolSearch) {
    guidance.push(
      `\`${toolSearch}\` is Claude Code's ToolSearch bridge. Use it to load deferred client tools, then call only a tool name returned by that search on the next turn.`,
    );
  }
  const dedicated = [
    read ? `\`${read}\` for reading files` : undefined,
    edit ? `\`${edit}\` for exact file changes` : undefined,
    write ? `\`${write}\` for new files` : undefined,
    grep ? `\`${grep}\` for content search` : undefined,
    glob ? `\`${glob}\` for file discovery` : undefined,
  ].filter((entry): entry is string => entry !== undefined);
  if (bash && dedicated.length > 0) {
    guidance.push(`Prefer purpose-built client tools over \`${bash}\`: ${dedicated.join(", ")}.`);
    guidance.push(
      `Never use \`${bash}\` with Python, sed, perl, or heredocs to read or modify files when a purpose-built client tool above can do the work.`,
    );
  }
  if (bash) {
    const searchGuidance = grep || glob
      ? "Use the advertised search tools instead of the shell for repository search."
      : `Repository search with \`${bash}\` is expected because neither \`Grep\` nor \`Glob\` is advertised.`;
    guidance.push(
      `Use \`${bash}\` only for shell-native workflows such as git, builds, tests, package managers, and commands with no dedicated client tool. ${searchGuidance}`,
    );
  }
  return guidance.join(" ");
}

function findCursorToolName(
  tools: readonly CursorWireTool[],
  candidates: readonly string[],
): string | undefined {
  for (const candidate of candidates) {
    const match = tools.find((tool) => (
      cursorToolLeafName(tool.clientName).toLowerCase() === candidate.toLowerCase()
    ));
    if (match) return match.toolName;
  }
  return undefined;
}

function isCursorNativeModel(modelId: string): boolean {
  return modelId === "default" || modelId === "auto" || modelId.startsWith("composer-");
}

/** Explicit provider semantics: Auto/default, Composer, and Grok retain cold continuation. */
function supportsCursorLiveToolBridge(wireModelId: string): boolean {
  return !isCursorNativeModel(wireModelId)
    && !wireModelId.startsWith("cursor-grok-")
    && !wireModelId.startsWith("grok-");
}

interface CursorLiveRunDescriptor {
  readonly conversationId: string;
  readonly sessionId: string;
  readonly credentialFingerprint: string;
  readonly requestModel: string;
  readonly wireModelId: string;
  readonly effort?: ReasoningEffort;
  readonly toolCatalogFingerprint: string;
}

interface CursorPendingToolCorrelation {
  /** Anthropic-visible tool_use id. */
  readonly callId: string;
  /** Cursor MCP id sealed from mcpArgs. */
  readonly toolCallId: string;
  /** Cursor exec envelope id sealed from execServerMessage. */
  readonly messageId: number;
  readonly execId: string;
}

type CursorCanonicalToolResult = Extract<CanonicalInputItem, { type: "function_call_output" }>;

interface CursorLiveRun {
  readonly descriptor: CursorLiveRunDescriptor;
  readonly initialEvents: AsyncIterable<CanonicalResponseEvent>;
  readonly report: CursorDiagnosticReporter;
  attach(
    results: readonly CursorCanonicalToolResult[],
    signal: AbortSignal | undefined,
    estimatedInputTokens: number,
  ): AsyncIterable<CanonicalResponseEvent>;
  dispose(outcome: string, error?: Error): void;
}

interface CursorPendingLiveRun {
  readonly run: CursorLiveRun;
  readonly calls: readonly CursorPendingToolCorrelation[];
  readonly timer: ReturnType<typeof setTimeout>;
}

function cursorCredentialFingerprint(apiKey: string): string {
  return createHash("sha256")
    .update("fleet:cursor:credential:\0")
    .update(apiKey)
    .digest("hex");
}

function cursorConversationStateKey(
  credentialFingerprint: string,
  conversationId: string,
): string {
  return `${credentialFingerprint}:${conversationId}`;
}

function cursorToolCatalogFingerprint(
  requestTools: readonly NonNullable<CanonicalResponseRequest["tools"]>[number][],
  wireTools: readonly CursorWireTool[],
): string {
  return createHash("sha256")
    .update("fleet:cursor:tool-catalog:\0")
    .update(JSON.stringify({
      requestTools,
      wireTools: wireTools.map(cursorWireToolDefinition),
    }))
    .digest("hex");
}

function trailingCursorToolResults(
  input: readonly CanonicalInputItem[],
): readonly CursorCanonicalToolResult[] | undefined {
  if (input.at(-1)?.type !== "function_call_output") return undefined;
  let start = input.length - 1;
  while (start > 0 && input[start - 1]?.type === "function_call_output") start -= 1;
  const preceding = input.slice(0, start);
  let lastCallIndex = -1;
  for (let index = preceding.length - 1; index >= 0; index -= 1) {
    if (preceding[index]?.type !== "function_call") continue;
    lastCallIndex = index;
    break;
  }
  if (lastCallIndex < 0 || lastUserIndex(preceding) > lastCallIndex) return undefined;
  return input.slice(start) as readonly CursorCanonicalToolResult[];
}

function cursorLiveRunMismatch(
  pending: CursorPendingLiveRun,
  descriptor: CursorLiveRunDescriptor,
  results: readonly CursorCanonicalToolResult[] | undefined,
): string | undefined {
  if (!results) return "superseded_by_prompt";
  const expected = pending.run.descriptor;
  if (descriptor.conversationId !== expected.conversationId) return "conversation";
  if (descriptor.sessionId !== expected.sessionId) return "session";
  if (descriptor.credentialFingerprint !== expected.credentialFingerprint) return "credential";
  if (descriptor.requestModel !== expected.requestModel) return "model";
  if (descriptor.wireModelId !== expected.wireModelId) return "wire_model";
  if (descriptor.effort !== expected.effort) return "effort";
  if (descriptor.toolCatalogFingerprint !== expected.toolCatalogFingerprint) return "tool_catalog";
  if (!supportsCursorLiveToolBridge(descriptor.wireModelId)) return "ineligible_model";

  const resultIds = results.map((result) => result.call_id);
  if (new Set(resultIds).size !== resultIds.length) return "duplicate_result";
  const expectedIds = pending.calls.map((call) => call.callId);
  if (resultIds.length !== expectedIds.length) {
    return resultIds.length < expectedIds.length ? "partial_results" : "extra_results";
  }
  const expectedSet = new Set(expectedIds);
  return resultIds.every((callId) => expectedSet.has(callId)) ? undefined : "stale_results";
}

function rootBytes(entries: readonly CursorRootEntry[]): number {
  return entries.reduce((total, entry) => total + entry.byteLength, 0);
}

export class CursorAdapter implements AiGatewayAdapter {
  readonly capabilities = { nativeTools: ["web_search"] } as const;
  private readonly origin: string;
  private readonly clientVersion: string;
  private readonly idleTimeoutMs: number;
  private readonly maxMode: boolean | undefined;
  private readonly connect: typeof http2.connect;
  private readonly toolFinalizeGraceMs: number;
  private readonly clientHeartbeatMs: number;
  private readonly pendingLiveRunTtlMs: number;
  private readonly pendingLiveRunCapacity: number;
  private readonly diagnostics: CursorDiagnosticSink | undefined;
  private readonly conversationIdOverride: string | undefined;
  private readonly sessionIdOverride: string | undefined;
  private readonly pendingLiveRuns = new Map<string, CursorPendingLiveRun>();
  private readonly liveRuns = new Set<CursorLiveRun>();
  private disposed = false;

  constructor(options: CursorAdapterOptions = {}) {
    this.origin = options.origin ?? CURSOR_API_ORIGIN;
    this.clientVersion = options.clientVersion ?? CURSOR_CLIENT_VERSION;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 180_000;
    this.maxMode = options.maxMode;
    this.connect = options.connect ?? http2.connect;
    this.toolFinalizeGraceMs = options.toolFinalizeGraceMs ?? CURSOR_TOOL_FINALIZE_GRACE_MS;
    this.clientHeartbeatMs = options.clientHeartbeatMs ?? CURSOR_CLIENT_HEARTBEAT_MS;
    this.pendingLiveRunTtlMs = cursorPositiveIntegerOption(
      options.pendingLiveRunTtlMs,
      CURSOR_PENDING_LIVE_RUN_TTL_MS,
      "pendingLiveRunTtlMs",
    );
    this.pendingLiveRunCapacity = cursorPositiveIntegerOption(
      options.pendingLiveRunCapacity,
      CURSOR_PENDING_LIVE_RUN_CAPACITY,
      "pendingLiveRunCapacity",
    );
    this.diagnostics = options.diagnostics;
    this.conversationIdOverride = options.conversationId;
    this.sessionIdOverride = options.sessionId;
  }

  /**
   * Cursor drops every `defer_loading` tool once the client advertises ToolSearch and
   * then caps the survivors by count and bytes, so the declared catalog is far larger
   * than the wire payload. Report only the survivors; charging a request for tools that
   * never leave the gateway would refuse turns the provider would have accepted.
   */
  wireTools(request: CanonicalResponseRequest): readonly CanonicalFunctionTool[] {
    const declared = request.tools ?? [];
    if (declared.length === 0) return [];
    let keptNames: ReadonlySet<string>;
    try {
      keptNames = new Set(applyCursorToolBudget(request).tools.map((tool) => tool.clientName));
    } catch {
      // A budget rejection belongs to `stream`, which raises it with the real diagnosis.
      return [];
    }
    return declared.filter((tool) => keptNames.has(tool.name));
  }

  async stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions,
  ): Promise<AdapterResponse> {
    if (this.disposed) throw new Error("Cursor adapter is disposed");
    const identity = resolveCursorSessionIdentity(request, {
      conversationId: this.conversationIdOverride,
      sessionId: this.sessionIdOverride,
    });
    const credentialFingerprint = cursorCredentialFingerprint(options.apiKey);
    const conversationStateKey = cursorConversationStateKey(
      credentialFingerprint,
      identity.conversationId,
    );
    const results = trailingCursorToolResults(request.input);
    const earlyPending = this.pendingLiveRuns.get(conversationStateKey);
    if (!results && earlyPending && this.claimPendingLiveRun(earlyPending)) {
      earlyPending.run.report("bridge.mismatch", {
        model: cursorDiagnosticLabel(request.model),
        outcome: "superseded_by_prompt",
      });
      earlyPending.run.dispose("bridge_mismatch_superseded_by_prompt");
    }
    let plan: CursorRunPlan;
    try {
      plan = buildCursorRunPlan(request, identity.conversationId, {
        maxMode: this.maxMode,
      });
    } catch (error) {
      const pending = this.pendingLiveRuns.get(conversationStateKey);
      if (pending && this.claimPendingLiveRun(pending)) {
        pending.run.report("bridge.mismatch", {
          model: cursorDiagnosticLabel(request.model),
          outcome: "invalid_continuation",
        });
        pending.run.dispose("bridge_mismatch_invalid_continuation");
      }
      throw error;
    }
    // Cursor rewrites and caps the declared catalog before it reaches the wire; this is the
    // post-rewrite tool set plus the resolved model coordinate.
    wireLog("cursor.wire.plan", plan);
    // 모든 진입 경로가 이 판정을 지나야 한다. bridge를 지원하는 모델은 tool 결과가
    // parked Run에 붙어 cold Run 경로를 건너뛰므로, 판정을 그 뒤에 두면 tool을 쓰는
    // 세션만 포화된 계기로 계속 달리게 된다.
    const contextRecall = recallCursorContextCheckpoint(
      identity.conversationId,
      plan.wireModelId,
      credentialFingerprint,
      plan.estimatedInputTokens,
    );
    const contextRefusal = cursorContextWindowRefusal(
      contextRecall.checkpoint,
      options.modelContextWindow,
    );
    if (contextRefusal || contextRecall.compacted) {
      // parked Run은 park될 당시의 대화를 전제로 업스트림에 이어져 있다. 창이 찼다면
      // 압축이 곧 오고, 이미 축소됐다면 압축이 지나간 것이라 어느 쪽이든 그 전제가
      // 깨졌다. 그런데 mismatch 판정은 대화 내용을 보지 않아 call id만 같으면 그대로
      // 다시 붙고, 그러면 압축이 클라이언트에만 반영된 채 업스트림 세션은 가득 찬
      // 상태로 이어진다. 여기서 버려야 다음 요청이 차갑게 열린다.
      const stale = this.pendingLiveRuns.get(conversationStateKey);
      if (stale && this.claimPendingLiveRun(stale)) {
        const outcome = contextRefusal ? "context_window_exceeded" : "conversation_compacted";
        stale.run.report("bridge.mismatch", {
          model: cursorDiagnosticLabel(request.model),
          outcome,
        });
        stale.run.dispose(`bridge_mismatch_${outcome}`);
      }
      if (contextRefusal) throw contextRefusal;
    }
    const descriptor: CursorLiveRunDescriptor = {
      conversationId: identity.conversationId,
      sessionId: identity.sessionId,
      credentialFingerprint,
      requestModel: request.model,
      wireModelId: plan.wireModelId,
      ...(request.reasoning?.effort === undefined ? {} : { effort: request.reasoning.effort }),
      toolCatalogFingerprint: cursorToolCatalogFingerprint(request.tools ?? [], plan.tools),
    };
    const pending = this.pendingLiveRuns.get(conversationStateKey);
    if (pending) {
      const mismatch = cursorLiveRunMismatch(pending, descriptor, results);
      if (mismatch === undefined && results && this.claimPendingLiveRun(pending)) {
        rememberCursorWireModel(
          identity.conversationId,
          descriptor.credentialFingerprint,
          plan.wireModelId,
        );
        pending.run.report("turn.start", {
          model: cursorDiagnosticLabel(request.model),
          wireModel: cursorDiagnosticLabel(plan.wireModelId),
          requestedEffort: request.reasoning?.effort,
          turn: "tool-continuation",
          toolCount: plan.tools.length,
          estimatedInputTokens: plan.estimatedInputTokens,
        });
        pending.run.report("bridge.attach", {
          model: cursorDiagnosticLabel(request.model),
          outcome: "exact_match",
          count: results.length,
        });
        return cursorSuccessfulResponse(pending.run.attach(
          results,
          options.signal,
          plan.estimatedInputTokens,
        ));
      }
      if (this.claimPendingLiveRun(pending)) {
        pending.run.report("bridge.mismatch", {
          model: cursorDiagnosticLabel(request.model),
          outcome: mismatch ?? "concurrent_claim",
        });
        pending.run.dispose(`bridge_mismatch_${mismatch ?? "concurrent_claim"}`);
      }
    }

    return this.openRun(request, options, identity, plan, descriptor, contextRecall.checkpoint);
  }

  /** Close every adapter-owned parked Run. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const parkedRuns = new Set<CursorLiveRun>();
    for (const pending of [...this.pendingLiveRuns.values()]) {
      if (!this.claimPendingLiveRun(pending)) continue;
      parkedRuns.add(pending.run);
      pending.run.report("bridge.expire", { outcome: "adapter_dispose" });
    }
    for (const run of [...this.liveRuns]) {
      if (!parkedRuns.has(run)) run.report("bridge.expire", { outcome: "adapter_dispose" });
      run.dispose("adapter_dispose", new Error("Cursor adapter disposed"));
    }
    this.liveRuns.clear();
  }

  private claimPendingLiveRun(pending: CursorPendingLiveRun): boolean {
    const key = cursorConversationStateKey(
      pending.run.descriptor.credentialFingerprint,
      pending.run.descriptor.conversationId,
    );
    if (this.pendingLiveRuns.get(key) !== pending) return false;
    this.pendingLiveRuns.delete(key);
    clearTimeout(pending.timer);
    return true;
  }

  private parkLiveRun(
    run: CursorLiveRun,
    calls: readonly CursorPendingToolCorrelation[],
  ): void {
    if (this.disposed) {
      run.dispose("adapter_dispose");
      return;
    }
    const key = cursorConversationStateKey(
      run.descriptor.credentialFingerprint,
      run.descriptor.conversationId,
    );
    const existing = this.pendingLiveRuns.get(key);
    if (existing && this.claimPendingLiveRun(existing)) {
      existing.run.report("bridge.expire", { outcome: "superseded_pending_run" });
      existing.run.dispose("superseded_pending_run");
    }
    while (this.pendingLiveRuns.size >= this.pendingLiveRunCapacity) {
      const oldest = [...this.pendingLiveRuns.values()].find((pending) => (
        pending.run.descriptor.credentialFingerprint === run.descriptor.credentialFingerprint
      ));
      if (!oldest) {
        run.report("bridge.expire", { outcome: "capacity_rejected" });
        run.dispose("capacity_rejected");
        return;
      }
      if (!this.claimPendingLiveRun(oldest)) continue;
      oldest.run.report("bridge.expire", { outcome: "capacity_eviction" });
      oldest.run.dispose("capacity_eviction");
    }
    let pending: CursorPendingLiveRun;
    const timer = setTimeout(() => {
      if (!this.claimPendingLiveRun(pending)) return;
      run.report("bridge.expire", { outcome: "ttl" });
      run.dispose("ttl_expired");
    }, this.pendingLiveRunTtlMs);
    timer.unref?.();
    pending = { run, calls, timer };
    this.pendingLiveRuns.set(key, pending);
    run.report("bridge.park", { outcome: "client_tool_suspended", count: calls.length });
  }

  private releaseLiveRun(run: CursorLiveRun): void {
    this.liveRuns.delete(run);
    const key = cursorConversationStateKey(
      run.descriptor.credentialFingerprint,
      run.descriptor.conversationId,
    );
    const pending = this.pendingLiveRuns.get(key);
    if (pending?.run === run) this.claimPendingLiveRun(pending);
  }

  private async openRun(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions,
    identity: CursorSessionIdentity,
    plan: CursorRunPlan,
    descriptor: CursorLiveRunDescriptor,
    previousContextCheckpoint: CursorContextCheckpoint | undefined,
  ): Promise<AdapterResponse> {
    if (options.signal?.aborted) throw new Error("cancelled by caller");
    // Cursor Run을 열 때 기록 정책을 고정한다. tool continuation은 이 Run에 붙어 reporter를
    // 재사용하므로 설정을 바꿔도 trace가 중간부터 잘려 기록되지 않는다.
    const report = createCursorDiagnosticReporter(
      options.diagnosticsEnabled === false ? undefined : this.diagnostics,
    );
    const model = cursorDiagnosticLabel(request.model);
    const wireModel = cursorDiagnosticLabel(plan.wireModelId);
    const previousWireModel = rememberCursorWireModel(
      identity.conversationId,
      descriptor.credentialFingerprint,
      plan.wireModelId,
    );
    report("turn.start", {
      model,
      wireModel,
      requestedEffort: request.reasoning?.effort,
      turn: request.input.at(-1)?.type === "function_call_output"
        ? "tool-continuation"
        : "prompt",
      toolCount: plan.tools.length,
      estimatedInputTokens: plan.estimatedInputTokens,
    });
    if (previousWireModel !== undefined && previousWireModel !== plan.wireModelId) {
      report("model.switch", {
        model,
        wireModel,
        previousWireModel: cursorDiagnosticLabel(previousWireModel),
        turn: request.input.at(-1)?.type === "function_call_output"
          ? "tool-continuation"
          : "prompt",
      });
    }

    report("transport.dial", { model });
    let session: http2.ClientHttp2Session;
    try {
      session = this.connect(this.origin);
    } catch (error) {
      report("turn.finish", {
        model,
        outcome: "dial_error",
        error: cursorDiagnosticError(error),
        frameCount: 0,
        lastFrame: "none",
      });
      throw error;
    }
    session.on("connect", () => report("transport.connected", { model }));

    let stream: http2.ClientHttp2Stream;
    try {
      stream = session.request({
        ":method": "POST",
        ":path": CURSOR_RUN_PATH,
        "content-type": "application/connect+proto",
        "connect-protocol-version": "1",
        te: "trailers",
        authorization: `Bearer ${options.apiKey}`,
        "x-ghost-mode": "true",
        "x-cursor-client-version": this.clientVersion,
        "x-cursor-client-type": "cli",
        "x-request-id": randomUUID(),
        "x-session-id": identity.sessionId,
      });
    } catch (error) {
      report("turn.finish", {
        model,
        outcome: "request_error",
        error: cursorDiagnosticError(error),
        frameCount: 0,
        lastFrame: "none",
      });
      session.close();
      throw error;
    }
    let heartbeatCount = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeat = (): void => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
    };
    let liveRun: CursorLiveRun;
    liveRun = createCursorLiveRun({
      stream,
      session,
      descriptor,
      model: request.model,
      blobs: plan.blobs,
      tools: plan.tools,
      estimatedInputTokens: plan.estimatedInputTokens,
      previousContextCheckpoint,
      onContextCheckpoint: (checkpoint) => rememberCursorContextCheckpoint(
        identity.conversationId,
        plan.wireModelId,
        descriptor.credentialFingerprint,
        plan.estimatedInputTokens,
        checkpoint,
      ),
      toolFinalizeGraceMs: this.toolFinalizeGraceMs,
      semanticStallTimeoutMs: this.idleTimeoutMs,
      bridgeEnabled: supportsCursorLiveToolBridge(plan.wireModelId),
      initialSignal: options.signal,
      report,
      stopHeartbeat,
      onPark: (calls) => this.parkLiveRun(liveRun, calls),
      onTerminal: () => this.releaseLiveRun(liveRun),
    });
    this.liveRuns.add(liveRun);
    session.on("error", (error: Error) => {
      report("transport.session_error", { model, error: cursorDiagnosticError(error) });
      liveRun.dispose("session_error", error);
    });
    stream.setTimeout(this.idleTimeoutMs, () => {
      const error = new Error("cursor stream idle timeout");
      report("transport.timeout", { model, outcome: "idle_timeout" });
      liveRun.dispose("idle_timeout", error);
    });
    heartbeat = setInterval(() => {
      if (stream.closed || stream.destroyed || stream.writableEnded) return;
      try {
        stream.write(encodeCursorClientMessage({ clientHeartbeat: {} }));
        heartbeatCount += 1;
        report("client.heartbeat", { model, sequence: heartbeatCount });
      } catch (error) {
        liveRun.dispose(
          "heartbeat_write_error",
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }, this.clientHeartbeatMs);
    heartbeat.unref();
    stream.once("close", stopHeartbeat);
    stream.once("end", stopHeartbeat);
    stream.once("error", stopHeartbeat);
    try {
      // KV, interaction, heartbeat, and later mcpResult messages share this request stream.
      stream.write(encodeCursorClientMessage(plan.payload));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      liveRun.dispose("request_write_error", failure);
      throw failure;
    }
    report("client.request", { model, reply: "run" });

    return cursorSuccessfulResponse(liveRun.initialEvents);
  }
}

function cursorPositiveIntegerOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || !Number.isFinite(resolved)) {
    throw new RangeError(`${name} must be a finite positive integer`);
  }
  return resolved;
}

function cursorSuccessfulResponse(
  events: AsyncIterable<CanonicalResponseEvent>,
): AdapterResponse {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    events,
  };
}

type CursorDiagnosticFields = Omit<
  CursorDiagnosticEvent,
  "timestamp" | "runId" | "event" | "elapsedMs"
>;

type CursorDiagnosticReporter = (
  event: CursorDiagnosticEventName,
  fields?: CursorDiagnosticFields,
) => void;

function createCursorDiagnosticReporter(
  sink: CursorDiagnosticSink | undefined,
): CursorDiagnosticReporter {
  const startedAt = Date.now();
  const runId = `cursor-run-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  return (event, fields = {}) => {
    if (!sink) return;
    try {
      sink({
        timestamp: new Date().toISOString(),
        runId,
        event,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        ...fields,
      });
    } catch {
      // Diagnostics are observational only and must never change transport behavior.
    }
  };
}

function cursorDiagnosticLabel(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").slice(0, 128);
}

function cursorDiagnosticError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === "cursor stream idle timeout") return "idle_timeout";
    if (error.message === "cursor stream semantic stall timeout") return "semantic_stall_timeout";
    if (error.message === "cancelled by caller") return "caller_abort";
    const code = (error as Error & { readonly code?: unknown }).code;
    if (
      (typeof code === "string" || typeof code === "number")
      && /^[A-Za-z0-9_-]{1,64}$/.test(String(code))
    ) {
      return `transport_${String(code)}`;
    }
    if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(error.name)) {
      return `error_${error.name}`;
    }
  }
  return "unknown_error";
}

interface CursorSessionIdentity {
  readonly conversationId: string;
  readonly sessionId: string;
}

/**
 * Claude session `metadata.user_id`를 Cursor conversation/x-session-id로 결정적으로 유도한다.
 * 같은 user_id면 adapter 인스턴스가 바뀌어도 식별자가 유지된다.
 */
export function resolveCursorSessionIdentity(
  request: CanonicalResponseRequest,
  overrides: {
    readonly conversationId?: string;
    readonly sessionId?: string;
  } = {},
): CursorSessionIdentity {
  const userId = request.metadata?.user_id?.trim();
  if (!userId) {
    throw new CursorSessionIdentityError();
  }
  return {
    conversationId: overrides.conversationId ?? cursorConversationIdFromUserId(userId),
    sessionId: overrides.sessionId ?? cursorSessionIdFromUserId(userId),
  };
}

function cursorConversationIdFromUserId(userId: string): string {
  const digest = createHash("sha256")
    .update("fleet:cursor:claude-session:")
    .update(userId)
    .digest("hex")
    .slice(0, 32);
  return `cursor_${digest}`;
}

function cursorSessionIdFromUserId(userId: string): string {
  const digest = createHash("sha256")
    .update("fleet:cursor:x-session:")
    .update(userId)
    .digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

/**
 * conversation 단위로 직전 wire model을 기억한다. 식별자 자체는 로그하지 않고,
 * 모델 전환 여부만 관측한다. 테스트에서만 리셋한다.
 */
function rememberCursorWireModel(
  conversationId: string,
  credentialFingerprint: string,
  wireModelId: string,
): string | undefined {
  const key = cursorConversationStateKey(credentialFingerprint, conversationId);
  const previous = CURSOR_WIRE_MODEL_BY_STATE.get(key);
  if (CURSOR_WIRE_MODEL_BY_STATE.has(key)) {
    CURSOR_WIRE_MODEL_BY_STATE.delete(key);
  } else if (CURSOR_WIRE_MODEL_BY_STATE.size >= CURSOR_CONVERSATION_MEMORY_LIMIT) {
    const oldest = CURSOR_WIRE_MODEL_BY_STATE.keys().next().value;
    if (oldest !== undefined) CURSOR_WIRE_MODEL_BY_STATE.delete(oldest);
  }
  CURSOR_WIRE_MODEL_BY_STATE.set(key, wireModelId);
  return previous;
}

interface CursorCheckpointRecall {
  readonly checkpoint: CursorContextCheckpoint | undefined;
  /**
   * 요청이 기준선보다 작아져 체크포인트를 폐기한 경우. 대화가 재구성됐다는 신호이며,
   * 그 대화를 전제로 열려 있는 parked Run도 함께 무효가 된다.
   */
  readonly compacted: boolean;
}

/**
 * 보관된 체크포인트는 그것을 측정한 대화가 계속 자라는 동안에만 이 요청을 설명한다.
 * Claude Code가 컴팩트하면 입력이 급감하는데, 낡은 값은 그 요청보다 큰 점유를 주장하고
 * 소비 측이 그것을 바닥으로 쓰기 때문에 계기가 세션이 끝날 때까지 고정된다. 요청이
 * 기준선보다 작아졌다면 대화가 줄어든 것이므로 체크포인트를 폐기한다.
 */
function recallCursorContextCheckpoint(
  conversationId: string,
  wireModelId: string,
  credentialFingerprint: string,
  requestInputTokens: number,
): CursorCheckpointRecall {
  const key = cursorConversationStateKey(credentialFingerprint, conversationId);
  const checkpoint = CURSOR_CONTEXT_CHECKPOINT_BY_STATE.get(key);
  if (!checkpoint) return { checkpoint: undefined, compacted: false };
  CURSOR_CONTEXT_CHECKPOINT_BY_STATE.delete(key);
  if (
    checkpoint.wireModelId !== wireModelId
    || checkpoint.credentialFingerprint !== credentialFingerprint
  ) {
    return { checkpoint: undefined, compacted: false };
  }
  if (requestInputTokens < checkpoint.requestInputTokens) {
    return { checkpoint: undefined, compacted: true };
  }
  CURSOR_CONTEXT_CHECKPOINT_BY_STATE.set(key, checkpoint);
  return { checkpoint, compacted: false };
}

/**
 * Refuse a new turn once Cursor's own measurement says the conversation already fills
 * the model's window.
 *
 * This is not a transport budget — it is what keeps Claude Code's occupancy meter
 * informative. That meter reads a projection onto Claude Code's 1M coordinate, and the
 * projection saturates at exactly this point: past it every turn reports 1,000,000 no
 * matter how much further the conversation grew, so the client can no longer see itself
 * approaching its own compaction threshold. Measured on 2026-08-05, a `grok-4.5-fast`
 * session sat at a saturated 1,000,000 across 31 consecutive requests before compaction
 * finally fired from the client's own local accounting, several minutes late.
 *
 * The refusal restores that signal: it carries the 413 Claude Code arms reactive
 * compaction from, so the turn compacts instead of continuing blind. The count is
 * Cursor's, never our character estimate — on that same session the estimate read
 * 210,670 against a measured 262,338, which is why the gateway's own pre-flight guard
 * never fired.
 *
 * A compacted retry sends a smaller request, and `recallCursorContextCheckpoint` drops
 * the stale checkpoint on exactly that shrink, so this cannot fire twice against a
 * conversation that already compacted.
 */
function cursorContextWindowRefusal(
  checkpoint: CursorContextCheckpoint | undefined,
  modelContextWindow: number | undefined,
): ContextWindowExceededError | undefined {
  if (
    checkpoint === undefined
    || typeof modelContextWindow !== "number"
    || !Number.isFinite(modelContextWindow)
    || modelContextWindow <= 0
    || checkpoint.contextTokens < modelContextWindow
  ) {
    return undefined;
  }
  return new ContextWindowExceededError(checkpoint.contextTokens, modelContextWindow);
}

function rememberCursorContextCheckpoint(
  conversationId: string,
  wireModelId: string,
  credentialFingerprint: string,
  requestInputTokens: number,
  checkpoint: CursorContextCheckpoint,
): void {
  const key = cursorConversationStateKey(credentialFingerprint, conversationId);
  if (CURSOR_CONTEXT_CHECKPOINT_BY_STATE.has(key)) {
    CURSOR_CONTEXT_CHECKPOINT_BY_STATE.delete(key);
  } else if (
    CURSOR_CONTEXT_CHECKPOINT_BY_STATE.size >= CURSOR_CONVERSATION_MEMORY_LIMIT
  ) {
    const oldest = CURSOR_CONTEXT_CHECKPOINT_BY_STATE.keys().next().value;
    if (oldest !== undefined) CURSOR_CONTEXT_CHECKPOINT_BY_STATE.delete(oldest);
  }
  CURSOR_CONTEXT_CHECKPOINT_BY_STATE.set(key, {
    wireModelId,
    credentialFingerprint,
    requestInputTokens,
    ...checkpoint,
  });
}

/** 테스트용: conversation 단위의 wire-model 및 context 메모리를 비운다. */
export function resetCursorWireModelMemory(): void {
  CURSOR_WIRE_MODEL_BY_STATE.clear();
  CURSOR_CONTEXT_CHECKPOINT_BY_STATE.clear();
}

/**
 * KV와 interaction 응답은 이벤트 소비자를 기다리면 안 된다. generator는 소비자가 다음 값을
 * 당길 때까지 멈추는데, 서버는 그 응답이 올 때까지 블록하므로 곧장 stall로 이어진다.
 * 그래서 프레임은 data 리스너에서 즉시 처리하고, 모델 이벤트만 큐를 통해 흘려보낸다.
 */
interface CursorLiveRunOptions {
  readonly stream: http2.ClientHttp2Stream;
  readonly session: http2.ClientHttp2Session;
  readonly descriptor: CursorLiveRunDescriptor;
  readonly model: string;
  readonly blobs: BlobStore;
  readonly tools: readonly CursorWireTool[];
  readonly estimatedInputTokens: number;
  readonly previousContextCheckpoint: CursorContextCheckpoint | undefined;
  readonly onContextCheckpoint: (checkpoint: CursorContextCheckpoint) => void;
  readonly toolFinalizeGraceMs: number;
  readonly semanticStallTimeoutMs: number;
  readonly bridgeEnabled: boolean;
  readonly initialSignal: AbortSignal | undefined;
  readonly report: CursorDiagnosticReporter;
  readonly stopHeartbeat: () => void;
  readonly onPark: (calls: readonly CursorPendingToolCorrelation[]) => void;
  readonly onTerminal: () => void;
}

type CursorLiveRunState = "attached" | "parked" | "completed" | "closed";

interface CursorResponseSegment {
  readonly responseId: string;
  readonly itemId: string;
  readonly queue: CanonicalResponseEvent[];
  readonly waiters: Array<() => void>;
  readonly toolItems: Set<CursorToolItem>;
  readonly toolItemsByIdentifier: Map<string, CursorToolItem>;
  readonly contextCheckpointAtStart: CursorContextCheckpoint | undefined;
  readonly contextWindowAtStart: number | undefined;
  started: boolean;
  finished: boolean;
  failure: Error | null;
  correlationInvalid: boolean;
  outputIndex: number;
  contextOutputTokens: number;
  outputText: string;
  estimatedInputTokens: number;
  checkpointVersionAtStart: number;
  contextWindowVersionAtStart: number;
  toolFinalizeTimer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

function createCursorLiveRun(options: CursorLiveRunOptions): CursorLiveRun {
  const {
    stream,
    session,
    descriptor,
    model,
    blobs,
    tools,
    estimatedInputTokens,
    previousContextCheckpoint,
    toolFinalizeGraceMs,
    semanticStallTimeoutMs,
    report,
  } = options;
  const diagnosticModel = cursorDiagnosticLabel(model);
  let state: CursorLiveRunState = "attached";
  let activeSegment: CursorResponseSegment;
  let parkedCalls: readonly CursorPendingToolCorrelation[] | undefined;
  let buffer: Buffer = Buffer.alloc(0);
  let latestContextCheckpoint = previousContextCheckpoint;
  let contextWindow = previousContextCheckpoint?.contextWindow;
  let checkpointVersion = 0;
  let contextWindowVersion = 0;
  let frameCount = 0;
  let lastFrame = "none";
  let semanticStallTimer: ReturnType<typeof setTimeout> | undefined;
  let transportClosed = false;
  let terminalNotified = false;
  let blobFetchCount = 0;
  let blobFetchBytes = 0;
  let blobFetchMisses = 0;

  const usage = (segment: CursorResponseSegment): CanonicalUsage => {
    const outputTokens = Math.max(
      segment.contextOutputTokens,
      estimateTokens(segment.outputText, model),
    );
    const checkpointInputTokens = latestContextCheckpoint === undefined
      || checkpointVersion <= segment.checkpointVersionAtStart
      ? undefined
      : Math.max(0, latestContextCheckpoint.contextTokens - outputTokens);
    const usageContextWindow = contextWindowVersion > segment.contextWindowVersionAtStart
      ? contextWindow
      : segment.contextWindowAtStart;
    return {
      input_tokens: checkpointInputTokens
        ?? Math.max(
          segment.estimatedInputTokens,
          segment.contextCheckpointAtStart?.contextTokens ?? 0,
        ),
      output_tokens: outputTokens,
      ...(usageContextWindow === undefined ? {} : { context_window: usageContextWindow }),
    };
  };

  const wake = (segment: CursorResponseSegment): void => {
    while (segment.waiters.length > 0) segment.waiters.shift()?.();
  };

  const detachAbort = (segment: CursorResponseSegment): void => {
    if (segment.signal && segment.abort) {
      segment.signal.removeEventListener("abort", segment.abort);
    }
    segment.signal = undefined;
    segment.abort = undefined;
  };

  const clearToolFinalize = (segment: CursorResponseSegment): void => {
    if (!segment.toolFinalizeTimer) return;
    clearTimeout(segment.toolFinalizeTimer);
    segment.toolFinalizeTimer = undefined;
  };

  const clearSemanticStall = (): void => {
    if (!semanticStallTimer) return;
    clearTimeout(semanticStallTimer);
    semanticStallTimer = undefined;
  };

  const finishSegment = (
    segment: CursorResponseSegment,
    error?: Error,
    outcome = error ? "error" : "completed",
  ): void => {
    if (segment.finished) return;
    segment.finished = true;
    clearToolFinalize(segment);
    clearSemanticStall();
    detachAbort(segment);
    if (error) segment.failure = error;
    else if (segment.started) {
      segment.queue.push({
        type: "response.completed",
        response: { id: segment.responseId, model, usage: usage(segment) },
      });
    }
    report("turn.finish", {
      model: diagnosticModel,
      outcome,
      frameCount,
      lastFrame,
      ...(error ? { error: cursorDiagnosticError(error) } : {}),
    });
    wake(segment);
  };

  const notifyTerminal = (): void => {
    if (terminalNotified) return;
    terminalNotified = true;
    // The root budget rejects on bodies this run *could* be asked for. Cursor pulls them
    // on demand, so that ceiling only describes real traffic if the server re-pulls
    // everything each turn. These two totals are what decides that.
    const inventory = blobs.inventory();
    wireLog("cursor.wire.blobsummary", {
      model: diagnosticModel,
      availableBlobs: inventory.count,
      availableBytes: inventory.bytes,
      fetchedBlobs: blobFetchCount,
      fetchedBytes: blobFetchBytes,
      misses: blobFetchMisses,
    });
    options.onTerminal();
  };

  const closeTransport = (cancel: boolean, error?: Error): void => {
    if (transportClosed) return;
    transportClosed = true;
    clearSemanticStall();
    clearToolFinalize(activeSegment);
    detachAbort(activeSegment);
    options.stopHeartbeat();
    try {
      if (error) stream.destroy(error);
      else stream.close(cancel ? http2.constants.NGHTTP2_CANCEL : http2.constants.NGHTTP2_NO_ERROR);
    } catch {
      try {
        stream.destroy(error);
      } catch {
        // The transport is already gone.
      }
    }
    try {
      session.close();
    } catch {
      // The session is already gone.
    }
    notifyTerminal();
  };

  const dispose = (outcome: string, error?: Error): void => {
    if (state === "closed") return;
    state = "closed";
    if (!activeSegment.finished) finishSegment(activeSegment, error, outcome);
    closeTransport(outcome !== "completed", error);
  };

  const noteSemanticProgress = (): void => {
    if (state !== "attached") return;
    if (!Number.isFinite(semanticStallTimeoutMs) || semanticStallTimeoutMs <= 0) return;
    clearSemanticStall();
    semanticStallTimer = setTimeout(() => {
      semanticStallTimer = undefined;
      if (state !== "attached") return;
      const error = new Error("cursor stream semantic stall timeout");
      report("transport.semantic_timeout", {
        model: diagnosticModel,
        outcome: "semantic_stall_timeout",
      });
      dispose("semantic_stall_timeout", error);
    }, semanticStallTimeoutMs);
    semanticStallTimer.unref?.();
  };

  const emit = (event: CanonicalResponseEvent): void => {
    if (state !== "attached" || activeSegment.finished) return;
    if (!activeSegment.started) {
      activeSegment.started = true;
      activeSegment.queue.push({
        type: "response.created",
        response: {
          id: activeSegment.responseId,
          model,
          usage: usage(activeSegment),
        },
      });
    }
    activeSegment.queue.push(event);
    wake(activeSegment);
  };

  const createSegment = (
    signal: AbortSignal | undefined,
    segmentEstimatedInputTokens: number,
  ): CursorResponseSegment => {
    const segment: CursorResponseSegment = {
      responseId: `cursor_${randomUUID()}`,
      itemId: `msg_${randomUUID()}`,
      queue: [],
      waiters: [],
      toolItems: new Set(),
      toolItemsByIdentifier: new Map(),
      contextCheckpointAtStart: latestContextCheckpoint === undefined
        ? undefined
        : { ...latestContextCheckpoint },
      contextWindowAtStart: contextWindow,
      started: false,
      finished: false,
      failure: null,
      correlationInvalid: false,
      outputIndex: 0,
      contextOutputTokens: 0,
      outputText: "",
      estimatedInputTokens: segmentEstimatedInputTokens,
      checkpointVersionAtStart: checkpointVersion,
      contextWindowVersionAtStart: contextWindowVersion,
    };
    activeSegment = segment;
    state = "attached";
    if (signal) {
      const abort = (): void => {
        const error = new Error("cancelled by caller");
        report("transport.abort", { model: diagnosticModel, outcome: "caller_abort" });
        dispose("caller_abort", error);
      };
      segment.signal = signal;
      segment.abort = abort;
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    noteSemanticProgress();
    return segment;
  };

  const invalidateToolCorrelation = (entries: Iterable<CursorToolItem>): void => {
    activeSegment.correlationInvalid = true;
    for (const entry of entries) entry.correlationInvalid = true;
  };

  const ensureToolItem = (call: CursorMcpCall): CursorToolItem => {
    const identifiers = [...new Set([
      call.publicCallId,
      call.toolCallId,
    ].filter((identifier): identifier is string => identifier !== undefined))];
    const matches = new Set(
      identifiers.flatMap((identifier) => {
        const entry = activeSegment.toolItemsByIdentifier.get(identifier);
        return entry ? [entry] : [];
      }),
    );
    if (matches.size > 1) {
      invalidateToolCorrelation(matches);
      return matches.values().next().value!;
    }

    const existing = matches.values().next().value as CursorToolItem | undefined;
    if (existing) {
      const publicCallIdConflict = call.publicCallId !== undefined
        && existing.publicCallId !== undefined
        && call.publicCallId !== existing.publicCallId;
      const toolCallIdConflict = call.toolCallId !== undefined
        && existing.toolCallId !== undefined
        && call.toolCallId !== existing.toolCallId;
      const unsafePublicAlias = call.publicCallId !== undefined
        && existing.publicCallId === undefined
        && (
          call.toolCallId === undefined
          || activeSegment.toolItemsByIdentifier.get(call.toolCallId) !== existing
        );
      const unsafeToolAlias = call.toolCallId !== undefined
        && existing.toolCallId === undefined
        && (
          call.publicCallId === undefined
          || activeSegment.toolItemsByIdentifier.get(call.publicCallId) !== existing
        );
      if (
        publicCallIdConflict
        || toolCallIdConflict
        || unsafePublicAlias
        || unsafeToolAlias
      ) {
        invalidateToolCorrelation([existing]);
        return existing;
      }
      if (existing.name === "tool" && call.name !== "tool") existing.name = call.name;
      if (existing.publicCallId === undefined && call.publicCallId !== undefined) {
        existing.publicCallId = call.publicCallId;
      }
      if (existing.toolCallId === undefined && call.toolCallId !== undefined) {
        existing.toolCallId = call.toolCallId;
      }
      for (const identifier of identifiers) {
        activeSegment.toolItemsByIdentifier.set(identifier, existing);
      }
      return existing;
    }

    activeSegment.outputIndex += 1;
    const entry: CursorToolItem = {
      itemId: call.publicCallId ?? call.toolCallId ?? call.callId,
      index: activeSegment.outputIndex,
      name: call.name,
      arguments: "",
      completed: false,
      suspended: false,
      ...(call.publicCallId === undefined ? {} : { publicCallId: call.publicCallId }),
      ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
    };
    activeSegment.toolItems.add(entry);
    for (const identifier of identifiers) {
      activeSegment.toolItemsByIdentifier.set(identifier, entry);
    }
    emit({
      type: "response.output_item.added",
      output_index: entry.index,
      item: {
        id: entry.itemId,
        type: "function_call",
        call_id: entry.itemId,
        name: call.name,
        arguments: "",
      },
    });
    return entry;
  };

  const completeToolItem = (entry: CursorToolItem, call: CursorMcpCall): void => {
    if (entry.completed) return;
    const argumentsText = call.arguments ?? completeJson(entry.arguments) ?? "{}";
    entry.arguments = argumentsText;
    entry.completed = true;
    activeSegment.outputText += `\n${entry.name}\n${argumentsText}`;
    emit({
      type: "response.output_item.done",
      output_index: entry.index,
      item: {
        id: entry.itemId,
        type: "function_call",
        call_id: entry.itemId,
        name: entry.name,
        arguments: argumentsText,
      },
    });
  };

  const sealPendingCalls = (): readonly CursorPendingToolCorrelation[] | undefined => {
    const entries = [...activeSegment.toolItems.values()];
    if (
      activeSegment.correlationInvalid
      || entries.length === 0
      || entries.some((entry) => (
        !entry.suspended || !entry.correlation || entry.correlationInvalid === true
      ))
    ) {
      return undefined;
    }
    const calls = entries.map((entry) => entry.correlation!);
    const unique = (values: readonly (string | number)[]): boolean => (
      new Set(values).size === values.length
    );
    return unique(calls.map((call) => call.callId))
      && unique(calls.map((call) => call.toolCallId))
      && unique(calls.map((call) => call.execId))
      && unique(calls.map((call) => call.messageId))
      ? calls
      : undefined;
  };

  const suspendSegment = (): void => {
    const calls = sealPendingCalls();
    if (options.bridgeEnabled && calls) {
      parkedCalls = calls;
      state = "parked";
      finishSegment(activeSegment, undefined, "client_tool_suspended");
      options.onPark(calls);
      return;
    }
    if (options.bridgeEnabled) {
      report("bridge.mismatch", { model: diagnosticModel, outcome: "invalid_correlation" });
    }
    state = "completed";
    finishSegment(activeSegment, undefined, "client_tool_suspended");
    closeTransport(true);
  };

  const rescheduleToolTurnFinish = (): void => {
    clearToolFinalize(activeSegment);
    if (
      activeSegment.toolItems.size === 0
      || [...activeSegment.toolItems.values()].some((entry) => !entry.suspended)
    ) {
      return;
    }
    const segment = activeSegment;
    segment.toolFinalizeTimer = setTimeout(() => {
      segment.toolFinalizeTimer = undefined;
      if (state === "attached" && activeSegment === segment) suspendSegment();
    }, toolFinalizeGraceMs);
    segment.toolFinalizeTimer.unref?.();
  };

  const completeRun = (outcome: string): void => {
    if (state !== "attached") return;
    state = "completed";
    finishSegment(activeSegment, undefined, outcome);
  };

  const handleFrame = (frame: CursorServerFrame): void => {
    frameCount += 1;
    const unknownExecFields = frame[CURSOR_UNKNOWN_EXEC_FIELDS] ?? [];
    lastFrame = describeCursorServerFrame(frame, unknownExecFields);
    const tokenDetails = isRecord(frame.conversationCheckpointUpdate)
      && isRecord(frame.conversationCheckpointUpdate.tokenDetails)
      ? frame.conversationCheckpointUpdate.tokenDetails
      : undefined;
    const checkpointContextTokens = positiveTokenCount(tokenDetails?.usedTokens);
    const checkpointContextWindow = positiveTokenCount(tokenDetails?.maxTokens);
    report("server.frame", {
      model: diagnosticModel,
      frame: lastFrame,
      sequence: frameCount,
      ...(checkpointContextTokens === undefined ? {} : { contextTokens: checkpointContextTokens }),
      ...(checkpointContextWindow === undefined ? {} : { contextWindow: checkpointContextWindow }),
    });
    if (isRecord(frame.conversationCheckpointUpdate)) {
      if (checkpointContextTokens !== undefined) {
        // Cursor reports a real token count only on some turns; every other turn
        // reports our own character estimate back. When the two disagree, Claude
        // Code's occupancy meter is wrong by that much — and it is the meter that
        // decides whether a session auto-compacts before it reaches its window.
        wireLog("cursor.wire.checkpoint", {
          model: diagnosticModel,
          estimatedInputTokens: activeSegment?.estimatedInputTokens ?? estimatedInputTokens,
          checkpointContextTokens,
          ...(checkpointContextWindow === undefined
            ? {}
            : { checkpointContextWindow }),
        });
      }
      if (checkpointContextWindow !== undefined) {
        contextWindow = checkpointContextWindow;
        contextWindowVersion += 1;
      }
      if (checkpointContextTokens !== undefined) {
        latestContextCheckpoint = {
          contextTokens: checkpointContextTokens,
          ...(contextWindow === undefined ? {} : { contextWindow }),
        };
        checkpointVersion += 1;
        options.onContextCheckpoint(latestContextCheckpoint);
      }
      return;
    }
    if (isRecord(frame.kvServerMessage)) {
      const kv = kvReply(frame.kvServerMessage, blobs);
      stream.write(encodeCursorClientMessage(kv.message));
      if (kv.fetch) {
        blobFetchCount += 1;
        blobFetchBytes += kv.fetch.bytes;
        if (!kv.fetch.hit) blobFetchMisses += 1;
        // Per-fetch, not just per-run: a run can span several turns, and only the id
        // sequence shows whether the server re-pulls a body it was already given.
        wireLog("cursor.wire.blobfetch", {
          model: diagnosticModel,
          sequence: blobFetchCount,
          blobId: kv.fetch.blobId,
          bytes: kv.fetch.bytes,
          hit: kv.fetch.hit,
        });
      }
      report("client.reply", {
        model: diagnosticModel,
        reply: `kv.${cursorNestedRecordCase(frame.kvServerMessage, CURSOR_KV_CASES)}`,
      });
      return;
    }
    if (isRecord(frame.interactionQuery)) {
      const reply = cursorInteractionQueryReply(frame.interactionQuery);
      stream.write(encodeCursorClientMessage(reply.message));
      report("client.reply", { model: diagnosticModel, reply: reply.replyKind });
      if (reply.planText && state === "attached") {
        activeSegment.outputText += reply.planText;
        emit({
          type: "response.output_text.delta",
          item_id: activeSegment.itemId,
          output_index: 0,
          content_index: 0,
          delta: reply.planText,
        });
      }
      return;
    }
    if (isRecord(frame.error)) {
      if (state === "attached") {
        emit({ type: "error", error: cursorError(frame.error) });
        completeRun("server_error");
      } else {
        dispose("server_error_while_parked", new Error("Cursor failed while awaiting mcpResult"));
      }
      return;
    }
    if (state === "parked") {
      if (isCursorHeartbeatFrame(frame)) return;
      dispose("protocol_frame_while_parked", new Error("Cursor sent progress while awaiting mcpResult"));
      return;
    }
    if (state !== "attached") return;
    if (isRecord(frame.execServerMessage)) {
      if (isRecord(frame.execServerMessage.requestContextArgs)) {
        stream.write(encodeCursorClientMessage(cursorRequestContextReply(frame.execServerMessage, tools)));
        report("client.reply", { model: diagnosticModel, reply: "exec.requestContext" });
        return;
      }
      const wireCall = mcpCallFromExecMessage(frame.execServerMessage);
      const call = wireCall ? cursorClientMcpCall(wireCall, tools) : null;
      if (call?.providerIdentifier === CURSOR_TOOL_PROVIDER_IDENTIFIER) {
        clearToolFinalize(activeSegment);
        const entry = ensureToolItem(call);
        if (entry.suspended) invalidateToolCorrelation([entry]);
        entry.suspended = true;
        if (
          call.toolCallId
          && call.execId
          && call.messageId !== undefined
          && Number.isSafeInteger(call.messageId)
        ) {
          entry.correlation = activeSegment.correlationInvalid || entry.correlationInvalid
            ? undefined
            : {
              callId: entry.itemId,
              toolCallId: call.toolCallId,
              execId: call.execId,
              messageId: call.messageId,
            };
        }
        completeToolItem(entry, call);
        report("client.reply", {
          model: diagnosticModel,
          reply: "exec.clientToolSuspend",
          ...(call.argumentRepairCount === undefined
            ? {}
            : { argumentRepairCount: call.argumentRepairCount }),
        });
        rescheduleToolTurnFinish();
        return;
      }
      const policyReplies = cursorNativeExecPolicyReplies(
        frame.execServerMessage,
        tools.map((tool) => ({ clientName: tool.clientName, wireName: tool.toolName })),
      );
      for (const reply of policyReplies ?? []) stream.write(encodeCursorClientMessage(reply));
      if (policyReplies) {
        report("client.reply", {
          model: diagnosticModel,
          reply: `exec.policy.${cursorNestedRecordCase(frame.execServerMessage, CURSOR_EXEC_CASES)}`,
          count: policyReplies.length,
        });
      } else {
        const fallback = cursorUnknownExecReply(frame.execServerMessage, unknownExecFields);
        for (const payload of fallback.payloads) stream.write(encodeConnectFrame(payload));
        report("client.reply", {
          model: diagnosticModel,
          reply: fallback.replyKind,
          count: fallback.payloads.length,
        });
      }
      return;
    }

    const update = isRecord(frame.interactionUpdate) ? frame.interactionUpdate : undefined;
    if (update === undefined) return;
    if (isRecord(update.textDelta) && typeof update.textDelta.text === "string") {
      activeSegment.outputText += update.textDelta.text;
      emit({
        type: "response.output_text.delta",
        item_id: activeSegment.itemId,
        output_index: 0,
        content_index: 0,
        delta: update.textDelta.text,
      });
      return;
    }
    if (isRecord(update.thinkingDelta) && typeof update.thinkingDelta.text === "string") {
      activeSegment.outputText += update.thinkingDelta.text;
      emit({
        type: "response.reasoning_summary_text.delta",
        item_id: `${activeSegment.itemId}_reasoning`,
        output_index: 0,
        delta: update.thinkingDelta.text,
      });
      return;
    }
    if (isRecord(update.tokenDelta)) {
      const tokens = positiveTokenCount(update.tokenDelta.tokens);
      if (tokens !== undefined) activeSegment.contextOutputTokens += tokens;
      return;
    }
    if (isRecord(update.toolCallStarted)) {
      const wireCall = mcpCallFromToolUpdate(update.toolCallStarted);
      const call = wireCall ? cursorClientMcpCall(wireCall, tools) : null;
      if (call) {
        clearToolFinalize(activeSegment);
        ensureToolItem(call);
        rescheduleToolTurnFinish();
      }
      return;
    }
    if (isRecord(update.partialToolCall)) {
      const wireCall = mcpCallFromToolUpdate(update.partialToolCall);
      const call = wireCall ? cursorClientMcpCall(wireCall, tools) : null;
      if (!call) return;
      clearToolFinalize(activeSegment);
      const entry = ensureToolItem(call);
      const cumulative = typeof update.partialToolCall.argsTextDelta === "string"
        ? update.partialToolCall.argsTextDelta
        : "";
      if (cumulative.length >= entry.arguments.length) entry.arguments = cumulative;
      rescheduleToolTurnFinish();
      return;
    }
    if (isRecord(update.toolCallCompleted)) {
      const wireCall = mcpCallFromToolUpdate(update.toolCallCompleted);
      const call = wireCall ? cursorClientMcpCall(wireCall, tools) : null;
      if (!call) return;
      clearToolFinalize(activeSegment);
      const entry = ensureToolItem(call);
      const argumentsText = call.arguments ?? completeJson(entry.arguments);
      if (argumentsText !== undefined) {
        completeToolItem(entry, { ...call, arguments: argumentsText });
      }
      rescheduleToolTurnFinish();
      return;
    }
    if (isRecord(update.turnEnded)) completeRun("turn_ended");
  };

  const eventsFor = (segment: CursorResponseSegment): AsyncIterable<CanonicalResponseEvent> => (
    (async function* () {
      try {
        for (;;) {
          while (segment.queue.length > 0) {
            const next = segment.queue.shift();
            if (next) yield next;
          }
          if (segment.failure) throw segment.failure;
          if (segment.finished) return;
          await new Promise<void>((resolve) => segment.waiters.push(resolve));
        }
      } finally {
        if (!segment.finished && state !== "closed") {
          dispose("segment_consumer_detached", new Error("Cursor response segment detached"));
        } else if (state === "completed" && activeSegment === segment) {
          state = "closed";
          closeTransport(false);
        }
      }
    })()
  );

  const attach = (
    results: readonly CursorCanonicalToolResult[],
    signal: AbortSignal | undefined,
    continuationEstimatedInputTokens: number,
  ): AsyncIterable<CanonicalResponseEvent> => {
    if (state !== "parked" || !parkedCalls) {
      throw new Error("Cursor live Run is not parked");
    }
    const resultById = new Map(results.map((result) => [result.call_id, result]));
    if (resultById.size !== parkedCalls.length || results.length !== parkedCalls.length) {
      const error = new Error("Cursor live Run result batch changed after claim");
      dispose("attach_protocol_mismatch", error);
      throw error;
    }
    const calls = parkedCalls;
    parkedCalls = undefined;
    const segment = createSegment(signal, continuationEstimatedInputTokens);
    try {
      for (const call of calls) {
        const result = resultById.get(call.callId);
        if (!result) throw new Error("Cursor live Run result batch changed after claim");
        stream.write(encodeCursorClientMessage({
          execClientMessage: {
            id: call.messageId,
            execId: call.execId,
            mcpResult: {
              success: {
                content: [{ text: { text: result.output } }],
                isError: result.is_error === true,
              },
            },
          },
        }));
      }
      report("client.reply", {
        model: diagnosticModel,
        reply: "exec.mcpResult",
        count: calls.length,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      dispose("mcp_result_write_error", failure);
    }
    return eventsFor(segment);
  };

  stream.on("data", (chunk: Uint8Array) => {
    try {
      buffer = Buffer.concat([buffer, chunk]) as Buffer;
      const decoded = decodeConnectFrames(buffer);
      buffer = decoded.rest;
      for (const frame of decoded.frames) {
        if ((frame.flags & CONNECT_FLAG_COMPRESSED) === CONNECT_FLAG_COMPRESSED) {
          frameCount += 1;
          lastFrame = "connect.compressed";
          report("server.frame", { model: diagnosticModel, frame: lastFrame, sequence: frameCount });
          throw new Error("Compressed Cursor Connect frames are not supported");
        }
        if ((frame.flags & CONNECT_FLAG_END_STREAM) === CONNECT_FLAG_END_STREAM) {
          frameCount += 1;
          lastFrame = "connect.endStream";
          report("server.frame", { model: diagnosticModel, frame: lastFrame, sequence: frameCount });
          const error = parseConnectEndStreamError(frame.payload);
          if (error) dispose("connect_end_stream_error", error);
          else completeRun("connect_end_stream");
          continue;
        }
        const decodedFrame = decodeCursorServerMessage(frame.payload);
        if (!isCursorHeartbeatFrame(decodedFrame)) noteSemanticProgress();
        handleFrame(decodedFrame);
      }
    } catch (error) {
      dispose("decode_error", error instanceof Error ? error : new Error(String(error)));
    }
  });
  stream.on("error", (error: Error) => {
    report("transport.stream_error", { model: diagnosticModel, error: cursorDiagnosticError(error) });
    dispose("stream_error", error);
  });
  stream.on("end", () => {
    report("transport.end", { model: diagnosticModel, frameCount, lastFrame });
    if (state === "attached") completeRun("stream_end");
    if (state === "parked") dispose("stream_end_while_parked");
    closeTransport(false);
  });
  stream.on("close", () => {
    report("transport.close", { model: diagnosticModel, frameCount, lastFrame });
    if (state === "attached") completeRun("stream_close");
    if (state === "parked") dispose("stream_close_while_parked");
    closeTransport(false);
  });

  const initialSegment = createSegment(options.initialSignal, estimatedInputTokens);
  const run: CursorLiveRun = {
    descriptor,
    initialEvents: eventsFor(initialSegment),
    report,
    attach,
    dispose,
  };
  return run;
}

const CURSOR_INTERACTION_UPDATE_CASES = [
  "textDelta",
  "thinkingDelta",
  "tokenDelta",
  "toolCallStarted",
  "partialToolCall",
  "toolCallDelta",
  "toolCallCompleted",
  "heartbeat",
  "turnEnded",
] as const;

const CURSOR_EXEC_CASES = [
  "requestContextArgs",
  "mcpArgs",
  "readArgs",
  "writeArgs",
  "deleteArgs",
  "lsArgs",
  "grepArgs",
  "shellArgs",
  "shellStreamArgs",
  "backgroundShellSpawnArgs",
  "writeShellStdinArgs",
  "fetchArgs",
  "diagnosticsArgs",
  "listMcpResourcesExecArgs",
  "readMcpResourceExecArgs",
  "recordScreenArgs",
  "computerUseArgs",
] as const;

const CURSOR_INTERACTION_QUERY_CASES = [
  "createPlanRequestQuery",
  "askQuestionInteractionQuery",
  "switchModeRequestQuery",
  "webSearchRequestQuery",
  "exaSearchRequestQuery",
  "exaFetchRequestQuery",
  "setupVmEnvironmentArgs",
] as const;

const CURSOR_KV_CASES = ["getBlobArgs", "setBlobArgs"] as const;

/** Describe only protobuf union cases; never include their payload values or identifiers. */
function describeCursorServerFrame(
  frame: Record<string, unknown>,
  unknownExecFields: readonly UnknownField[] = [],
): string {
  if (isRecord(frame.interactionUpdate)) {
    return `interactionUpdate.${cursorNestedRecordCase(
      frame.interactionUpdate,
      CURSOR_INTERACTION_UPDATE_CASES,
    )}`;
  }
  if (isRecord(frame.execServerMessage)) {
    const knownCase = cursorNestedRecordCase(frame.execServerMessage, CURSOR_EXEC_CASES);
    return `execServerMessage.${knownCase === "unknown"
      ? cursorUnknownExecCaseName(unknownExecFields)
      : knownCase}`;
  }
  if (isRecord(frame.interactionQuery)) {
    return `interactionQuery.${cursorNestedRecordCase(
      frame.interactionQuery,
      CURSOR_INTERACTION_QUERY_CASES,
    )}`;
  }
  if (isRecord(frame.kvServerMessage)) {
    return `kvServerMessage.${cursorNestedRecordCase(frame.kvServerMessage, CURSOR_KV_CASES)}`;
  }
  if (isRecord(frame.conversationCheckpointUpdate)) return "conversationCheckpointUpdate";
  if (isRecord(frame.error)) return "error";
  return "unknown";
}

function isCursorHeartbeatFrame(frame: Record<string, unknown>): boolean {
  return isRecord(frame.interactionUpdate) && isRecord(frame.interactionUpdate.heartbeat);
}

function cursorNestedRecordCase(
  value: Record<string, unknown>,
  cases: readonly string[],
): string {
  return cases.find((candidate) => isRecord(value[candidate])) ?? "unknown";
}

function positiveTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

interface CursorInteractionReply {
  readonly message: unknown;
  readonly replyKind: string;
  readonly planText?: string;
}

const CURSOR_NON_INTERACTIVE_REASON =
  "Fleet AI Gateway is non-interactive; proceed without this interaction.";

/**
 * Cursor blocks its server-side agent until an interaction query receives a matching typed reply.
 * The gateway is headless, so it acknowledges plans, rejects human-only choices, and delegates
 * server-owned search permission gates. Unsupported VM setup stays fail-closed.
 */
function cursorInteractionQueryReply(query: Record<string, unknown>): CursorInteractionReply {
  const id = typeof query.id === "number" && Number.isSafeInteger(query.id) ? query.id : 0;
  const response = (result: Record<string, unknown> = {}): unknown => ({
    interactionResponse: { id, ...result },
  });

  if (isRecord(query.createPlanRequestQuery)) {
    const args = isRecord(query.createPlanRequestQuery.args)
      ? query.createPlanRequestQuery.args
      : undefined;
    const name = stringValue(args?.name)?.trim();
    const overview = stringValue(args?.overview)?.trim();
    const plan = stringValue(args?.plan)?.trim();
    const parts = [
      name ? `Plan: ${name}` : undefined,
      overview || undefined,
      plan || undefined,
    ].filter((part): part is string => part !== undefined);
    return {
      message: response({ createPlanRequestResponse: { result: { success: {} } } }),
      replyKind: "interaction.createPlan.approved",
      ...(parts.length > 0 ? { planText: `${parts.join("\n\n")}\n` } : {}),
    };
  }
  if (isRecord(query.askQuestionInteractionQuery)) {
    return {
      message: response({
        askQuestionInteractionResponse: {
          result: { rejected: { reason: CURSOR_NON_INTERACTIVE_REASON } },
        },
      }),
      replyKind: "interaction.askQuestion.rejected",
    };
  }
  if (isRecord(query.switchModeRequestQuery)) {
    return {
      message: response({
        switchModeRequestResponse: {
          rejected: { reason: CURSOR_NON_INTERACTIVE_REASON },
        },
      }),
      replyKind: "interaction.switchMode.rejected",
    };
  }
  if (isRecord(query.webSearchRequestQuery)) {
    return {
      message: response({ webSearchRequestResponse: { approved: {} } }),
      replyKind: "interaction.webSearch.approved",
    };
  }
  if (isRecord(query.exaSearchRequestQuery)) {
    return {
      message: response({ exaSearchRequestResponse: { approved: {} } }),
      replyKind: "interaction.exaSearch.approved",
    };
  }
  if (isRecord(query.exaFetchRequestQuery)) {
    return {
      message: response({ exaFetchRequestResponse: { approved: {} } }),
      replyKind: "interaction.exaFetch.approved",
    };
  }

  // setupVmEnvironment and future query types must not fabricate work the gateway did not perform.
  return { message: response(), replyKind: "interaction.unsupported.failClosed" };
}

interface CursorKvOutcome {
  readonly message: unknown;
  /** Present only for getBlob — the one frame that transmits a replay body. */
  readonly fetch?: {
    readonly blobId: string;
    readonly bytes: number;
    readonly hit: boolean;
  };
}

function kvReply(kv: Record<string, unknown>, blobs: BlobStore): CursorKvOutcome {
  const id = kv.id ?? 0;
  if (isRecord(kv.getBlobArgs)) {
    const blobId = typeof kv.getBlobArgs.blobId === "string" ? kv.getBlobArgs.blobId : "";
    const blobData = blobs.get(blobId);
    return {
      message: { kvClientMessage: { id, getBlobResult: blobData ? { blobData } : {} } },
      fetch: {
        blobId,
        bytes: blobData === undefined ? 0 : Buffer.byteLength(blobData, "base64"),
        hit: blobData !== undefined,
      },
    };
  }
  if (isRecord(kv.setBlobArgs)) {
    const blobId = typeof kv.setBlobArgs.blobId === "string" ? kv.setBlobArgs.blobId : "";
    const blobData = typeof kv.setBlobArgs.blobData === "string" ? kv.setBlobArgs.blobData : "";
    if (blobId) blobs.set(blobId, blobData);
    return { message: { kvClientMessage: { id, setBlobResult: {} } } };
  }
  return { message: { kvClientMessage: { id } } };
}

function cursorRequestContextReply(
  exec: Record<string, unknown>,
  tools: readonly CursorWireTool[],
): unknown {
  return {
    execClientMessage: {
      id: typeof exec.id === "number" ? exec.id : 0,
      ...(typeof exec.execId === "string" && exec.execId.length > 0 ? { execId: exec.execId } : {}),
      requestContextResult: {
        success: {
          requestContext: { tools: tools.map(cursorWireToolDefinition) },
        },
      },
    },
  };
}

interface CursorToolItem {
  readonly itemId: string;
  readonly index: number;
  name: string;
  arguments: string;
  completed: boolean;
  suspended: boolean;
  publicCallId?: string;
  toolCallId?: string;
  correlation?: CursorPendingToolCorrelation;
  correlationInvalid?: boolean;
}

interface CursorMcpCall {
  readonly callId: string;
  readonly publicCallId?: string;
  readonly toolCallId?: string;
  readonly messageId?: number;
  readonly execId?: string;
  readonly name: string;
  readonly providerIdentifier?: string;
  readonly arguments?: string;
  readonly argumentRepairCount?: number;
}

const CURSOR_MCP_DISPLAY_PREFIX = `mcp_${CURSOR_TOOL_PROVIDER_IDENTIFIER}_`;

function cursorClientMcpCall(
  call: CursorMcpCall,
  tools: readonly CursorWireTool[],
): CursorMcpCall {
  const wireName = call.name.startsWith(CURSOR_MCP_DISPLAY_PREFIX)
    ? call.name.slice(CURSOR_MCP_DISPLAY_PREFIX.length)
    : call.name;
  const tool = tools.find((candidate) => (
    candidate.name === wireName
    || candidate.toolName === wireName
    || candidate.clientName === call.name
  ));
  if (!tool) return call;
  const repaired = call.arguments === undefined
    ? undefined
    : repairCursorToolArguments(call.arguments, tool.inputSchemaValue);
  return {
    ...call,
    name: tool.clientName,
    ...(repaired === undefined
      ? {}
      : {
          arguments: repaired.arguments,
          argumentRepairCount: repaired.count,
        }),
  };
}

interface CursorArgumentRepair {
  readonly value: unknown;
  readonly count: number;
}

/**
 * Cursor models can serialize numeric-looking opaque IDs as JSON numbers. Repair only lossless
 * safe integers at schema positions that exclusively accept strings; all other validation remains
 * the client's responsibility.
 */
function repairCursorToolArguments(
  argumentsText: string,
  schema: Record<string, unknown>,
): { readonly arguments: string; readonly count: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return undefined;
  }
  const repaired = repairCursorArgumentValue(parsed, schema);
  return repaired.count === 0
    ? undefined
    : { arguments: JSON.stringify(repaired.value), count: repaired.count };
}

function repairCursorArgumentValue(value: unknown, schema: unknown): CursorArgumentRepair {
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && cursorSchemaRequiresString(schema)
  ) {
    return { value: String(value), count: 1 };
  }
  if (Array.isArray(value)) {
    const itemSchema = isRecord(schema) ? schema.items : undefined;
    if (itemSchema === undefined) return { value, count: 0 };
    let repairedValues: unknown[] | undefined;
    let count = 0;
    value.forEach((item, index) => {
      const repaired = repairCursorArgumentValue(item, itemSchema);
      if (repaired.count === 0) return;
      repairedValues ??= [...value];
      repairedValues[index] = repaired.value;
      count += repaired.count;
    });
    return { value: repairedValues ?? value, count };
  }
  if (!isRecord(value) || !isRecord(schema) || !isRecord(schema.properties)) {
    return { value, count: 0 };
  }
  let repairedValue: Record<string, unknown> | undefined;
  let count = 0;
  for (const [name, propertySchema] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, name)) continue;
    const repaired = repairCursorArgumentValue(value[name], propertySchema);
    if (repaired.count === 0) continue;
    repairedValue ??= { ...value };
    repairedValue[name] = repaired.value;
    count += repaired.count;
  }
  return { value: repairedValue ?? value, count };
}

function cursorSchemaRequiresString(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.type === "string") return true;
  return Array.isArray(schema.type)
    && schema.type.includes("string")
    && schema.type.every((type) => type === "string" || type === "null");
}

function mcpCallFromToolUpdate(value: Record<string, unknown>): CursorMcpCall | null {
  const toolCall = isRecord(value.toolCall) ? value.toolCall : undefined;
  const args = toolCall ? mcpArgsFromToolCall(toolCall) : undefined;
  if (!args) return null;
  const publicCallId = stringValue(value.callId);
  const toolCallId = stringValue(args.toolCallId);
  const callId = publicCallId ?? toolCallId;
  if (!callId) return null;
  return {
    callId,
    ...(publicCallId ? { publicCallId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    name: stringValue(args?.toolName) ?? stringValue(args?.name) ?? "tool",
    ...(stringValue(args?.providerIdentifier)
      ? { providerIdentifier: stringValue(args?.providerIdentifier)! }
      : {}),
    ...(args ? cursorMcpArguments(args) : {}),
  };
}

function mcpCallFromExecMessage(value: Record<string, unknown>): CursorMcpCall | null {
  const args = isRecord(value.mcpArgs) ? value.mcpArgs : undefined;
  if (!args) return null;
  const toolCallId = stringValue(args.toolCallId);
  if (!toolCallId) return null;
  const messageId = typeof value.id === "number" && Number.isSafeInteger(value.id)
    ? value.id
    : undefined;
  const execId = stringValue(value.execId);
  return {
    callId: toolCallId,
    toolCallId,
    ...(messageId === undefined ? {} : { messageId }),
    ...(execId ? { execId } : {}),
    name: stringValue(args.toolName) ?? stringValue(args.name) ?? "tool",
    ...(stringValue(args.providerIdentifier)
      ? { providerIdentifier: stringValue(args.providerIdentifier)! }
      : {}),
    ...cursorMcpArguments(args),
  };
}

function mcpArgsFromToolCall(toolCall: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = isRecord(toolCall.mcpToolCall) ? toolCall.mcpToolCall : undefined;
  if (direct && isRecord(direct.args)) return direct.args;
  const tool = isRecord(toolCall.tool) ? toolCall.tool : undefined;
  const nested = tool && isRecord(tool.mcpToolCall) ? tool.mcpToolCall : undefined;
  return nested && isRecord(nested.args) ? nested.args : undefined;
}

function cursorMcpArguments(args: Record<string, unknown>): { arguments?: string } {
  if (!isRecord(args.args) || Object.keys(args.args).length === 0) return {};
  const decoded: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args.args)) {
    if (typeof value !== "string") {
      throw new TypeError(`Cursor tool argument "${name}" was not protobuf bytes`);
    }
    decoded[name] = decodeCursorArgumentValue(value);
  }
  return { arguments: JSON.stringify(decoded) };
}

function decodeCursorArgumentValue(value: string): unknown {
  const bytes = canonicalBase64Bytes(value);
  if (!bytes) return parseCursorJsonText(value);

  const protobuf = decodeProtobufCursorArgument(bytes);
  if (protobuf.matched) return protobuf.value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
      return parseCursorJsonText(text);
    }
  } catch {
    // A raw Connect-JSON string can coincidentally use base64 characters.
  }
  return parseCursorJsonText(value);
}

function canonicalBase64Bytes(value: string): Uint8Array | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : undefined;
}

function decodeProtobufCursorArgument(
  value: Uint8Array,
): { readonly matched: true; readonly value: unknown } | { readonly matched: false } {
  try {
    const parsed = fromBinary(ValueSchema, value);
    if (!sameBytes(toBinary(ValueSchema, parsed), value)) {
      throw new TypeError("non-canonical protobuf Value");
    }
    const jsonValue = toJson(ValueSchema, parsed);
    return {
      matched: true,
      value: typeof jsonValue === "string" ? parseCursorJsonText(jsonValue) : jsonValue,
    };
  } catch {
    return { matched: false };
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function parseCursorJsonText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function completeJson(value: string): string | undefined {
  if (value.length === 0) return undefined;
  try {
    JSON.parse(value);
    return value;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
