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
  CanonicalInputItem,
  CanonicalNativeTool,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CanonicalUsage,
  ReasoningEffort,
} from "./canonical.js";
import {
  canonicalMessageImages,
  canonicalMessageText,
} from "./canonical.js";
import { cursorNativeExecPolicyReplies } from "./cursor-native-exec-policy.js";
import {
  cursorUnknownExecCaseName,
  cursorUnknownExecReply,
} from "./cursor-unknown-exec.js";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  UserMessageSchema,
} from "./generated/cursor-agent-protobuf.js";
import { resolveCursorModelSelection } from "./models.js";
import { estimateTokens } from "./token-estimate.js";

export const CURSOR_API_ORIGIN = "https://api2.cursor.sh";
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
export const CURSOR_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
// Live tool bridge에서 검증한 프로토콜 버전. 모델 discovery에 사용한
// 로컬 Cursor CLI 버전과 transport wire version은 같은 수명주기가 아니다.
export const CURSOR_CLIENT_VERSION = "cli-2026.07.08-0c04a8a";
export const CURSOR_TOOL_COUNT_LIMIT = 330;
export const CURSOR_TOOL_BYTES_LIMIT = 120_000;
export const CURSOR_EXTERNAL_ROOT_BLOB_LIMIT = 192;
export const CURSOR_EXTERNAL_ROOT_BYTE_LIMIT = 512 * 1024;
export const CURSOR_TOOL_PROVIDER_IDENTIFIER = "fleet-gateway";
export const CURSOR_TOOL_FINALIZE_GRACE_MS = 50;
export const CURSOR_CLIENT_HEARTBEAT_MS = 5_000;
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

/** Claude Code recognizes this prefix and routes the failed turn through reactive compaction. */
export class CursorReplayBudgetError extends CursorRequestBudgetError {
  constructor(message: string) {
    super(`Prompt is too long: ${message}`);
    this.name = "CursorReplayBudgetError";
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
  | "turn.finish";

/** Mid-session wire-model switches keyed by derived conversation id. Package-owned; no raw user_id. */
const CURSOR_WIRE_MODEL_BY_CONVERSATION = new Map<string, string>();
const CURSOR_WIRE_MODEL_MEMORY_LIMIT = 512;

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

  putSerialized(serialized: string): string {
    return this.putBytes(Buffer.from(serialized, "utf8"));
  }

  putBytes(value: Uint8Array): string {
    const data = Buffer.from(value);
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
  readonly tools: readonly CursorWireTool[];
  readonly wireModelId: string;
  /** Request-local estimate from the exact root/action text sent to Cursor. */
  readonly estimatedInputTokens: number;
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
  assertCursorRootBudget(
    activeReplayRoot ? [...roots, activeReplayRoot] : roots,
    wireModelId,
  );
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
      current.steps.push(storeCursorToolCallStep(blobs, call, tools, item.output));
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
                isError: false,
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
      "is_error: false",
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
  const sourceTools = request.tools ?? [];
  const wireTools = sourceTools.map(toCursorWireTool);
  if (
    wireTools.length <= CURSOR_TOOL_COUNT_LIMIT
    && cursorToolPayloadBytes(wireTools) <= CURSOR_TOOL_BYTES_LIMIT
  ) {
    return { tools: wireTools, omittedNames: [] };
  }

  const selectedName = typeof request.tool_choice === "object" ? request.tool_choice.name : undefined;
  const candidates = sourceTools
    .map((tool, index) => ({
      index,
      priority: cursorToolPriority(tool.name, selectedName),
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
    const selectedIndex = sourceTools.findIndex((tool) => (
      tool.name === selectedName || cursorToolLeafName(tool.name) === cursorToolLeafName(selectedName)
    ));
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

function cursorToolPriority(name: string, selectedName: string | undefined): number {
  const leafName = cursorToolLeafName(name);
  if (leafName === "exec_command" || leafName === "shell_command") return 0;
  if (leafName === "apply_patch") return 1;
  if (selectedName && (name === selectedName || leafName === cursorToolLeafName(selectedName))) return 2;
  if (leafName === "tool_search") return 3;
  return name.includes("__") ? 5 : 4;
}

function cursorToolLeafName(name: string): string {
  return name.split("__").at(-1) ?? name;
}

function cursorToolLimitNote(budget: CursorToolBudget): string | undefined {
  if (budget.omittedNames.length === 0) return undefined;
  const names = budget.omittedNames.slice(0, 12);
  const remainder = budget.omittedNames.length - names.length;
  const summary = `${names.join(", ")}${remainder > 0 ? `, and ${remainder} more` : ""}`;
  const recoverable = budget.tools.some((tool) => cursorToolLeafName(tool.clientName) === "tool_search");
  const total = budget.tools.length + budget.omittedNames.length;
  return recoverable
    ? `${CURSOR_TOOL_LIMIT_NOTE_PREFIX} Cursor transport limits expose ${budget.tools.length} of ${total} tools this turn. Omitted: ${summary}. Use tool_search to load an omitted tool when needed.`
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
  const nativeWebSearch = nativeTools.some((tool) => tool.type === "web_search");
  const guidance = [
    nativeWebSearch
      ? "Do not invoke Cursor-native filesystem, shell, or editing tools in gateway mode; native web search is the only exception. Call the advertised client bridge tools for every other action."
      : "Do not invoke Cursor-native tools in gateway mode; call the advertised client bridge tools directly.",
  ];
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

function assertCursorRootBudget(
  roots: readonly CursorRootEntry[],
  modelId: string,
): void {
  if (isCursorNativeModel(modelId)) return;
  const systemEntries = roots.filter((entry) => entry.role === "system");
  const systemBytes = rootBytes(systemEntries);
  if (
    systemEntries.length > CURSOR_EXTERNAL_ROOT_BLOB_LIMIT
    || systemBytes > CURSOR_EXTERNAL_ROOT_BYTE_LIMIT
  ) {
    throw new CursorRequestBudgetError(
      `Cursor system prompt exceeds the external-model root budget (${systemBytes} bytes; limit ${CURSOR_EXTERNAL_ROOT_BYTE_LIMIT})`,
    );
  }
  const totalBytes = rootBytes(roots);
  if (
    roots.length > CURSOR_EXTERNAL_ROOT_BLOB_LIMIT
    || totalBytes > CURSOR_EXTERNAL_ROOT_BYTE_LIMIT
  ) {
    throw new CursorReplayBudgetError(
      `Cursor external replay exceeds its transport budget (${roots.length} roots, ${totalBytes} bytes; limits ${CURSOR_EXTERNAL_ROOT_BLOB_LIMIT} roots and ${CURSOR_EXTERNAL_ROOT_BYTE_LIMIT} bytes)`,
    );
  }
}

function isCursorNativeModel(modelId: string): boolean {
  return modelId === "default" || modelId === "auto" || modelId.startsWith("composer-");
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
  private readonly diagnostics: CursorDiagnosticSink | undefined;
  private readonly conversationIdOverride: string | undefined;
  private readonly sessionIdOverride: string | undefined;

  constructor(options: CursorAdapterOptions = {}) {
    this.origin = options.origin ?? CURSOR_API_ORIGIN;
    this.clientVersion = options.clientVersion ?? CURSOR_CLIENT_VERSION;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 180_000;
    this.maxMode = options.maxMode;
    this.connect = options.connect ?? http2.connect;
    this.toolFinalizeGraceMs = options.toolFinalizeGraceMs ?? CURSOR_TOOL_FINALIZE_GRACE_MS;
    this.clientHeartbeatMs = options.clientHeartbeatMs ?? CURSOR_CLIENT_HEARTBEAT_MS;
    this.diagnostics = options.diagnostics;
    this.conversationIdOverride = options.conversationId;
    this.sessionIdOverride = options.sessionId;
  }

  async stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions,
  ): Promise<AdapterResponse> {
    const report = createCursorDiagnosticReporter(this.diagnostics);
    const identity = resolveCursorSessionIdentity(request, {
      conversationId: this.conversationIdOverride,
      sessionId: this.sessionIdOverride,
    });
    const plan = buildCursorRunPlan(request, identity.conversationId, {
      maxMode: this.maxMode,
    });
    const model = cursorDiagnosticLabel(request.model);
    const wireModel = cursorDiagnosticLabel(plan.wireModelId);
    const previousWireModel = rememberCursorWireModel(identity.conversationId, plan.wireModelId);
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
    session.on("error", (error: Error) => {
      report("transport.session_error", { model, error: cursorDiagnosticError(error) });
      stream.destroy(error);
    });
    stream.setTimeout(this.idleTimeoutMs, () => {
      report("transport.timeout", { model, outcome: "idle_timeout" });
      stream.destroy(new Error("cursor stream idle timeout"));
    });
    const abort = (): void => {
      report("transport.abort", { model, outcome: "caller_abort" });
      stream.destroy(new Error("cancelled by caller"));
      session.close();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    // 스트림을 닫지 않는다. KV 응답과 interaction 응답을 같은 스트림으로 계속 써야 한다.
    stream.write(encodeCursorClientMessage(plan.payload));
    report("client.request", { model, reply: "run" });
    let heartbeatCount = 0;
    const heartbeat = setInterval(() => {
      if (stream.closed || stream.destroyed || stream.writableEnded) return;
      stream.write(encodeCursorClientMessage({ clientHeartbeat: {} }));
      heartbeatCount += 1;
      report("client.heartbeat", { model, sequence: heartbeatCount });
    }, this.clientHeartbeatMs);
    heartbeat.unref();
    const stopHeartbeat = (): void => clearInterval(heartbeat);
    stream.once("close", stopHeartbeat);
    stream.once("end", stopHeartbeat);
    stream.once("error", stopHeartbeat);

    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      events: mapCursorStream(
        stream,
        request.model,
        plan.blobs,
        plan.tools,
        plan.estimatedInputTokens,
        this.toolFinalizeGraceMs,
        this.idleTimeoutMs,
        report,
        () => {
          stopHeartbeat();
          options.signal?.removeEventListener("abort", abort);
          session.close();
        },
      ),
    };
  }
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
  wireModelId: string,
): string | undefined {
  const previous = CURSOR_WIRE_MODEL_BY_CONVERSATION.get(conversationId);
  if (CURSOR_WIRE_MODEL_BY_CONVERSATION.has(conversationId)) {
    CURSOR_WIRE_MODEL_BY_CONVERSATION.delete(conversationId);
  } else if (CURSOR_WIRE_MODEL_BY_CONVERSATION.size >= CURSOR_WIRE_MODEL_MEMORY_LIMIT) {
    const oldest = CURSOR_WIRE_MODEL_BY_CONVERSATION.keys().next().value;
    if (oldest !== undefined) CURSOR_WIRE_MODEL_BY_CONVERSATION.delete(oldest);
  }
  CURSOR_WIRE_MODEL_BY_CONVERSATION.set(conversationId, wireModelId);
  return previous;
}

/** 테스트용: mid-session model switch 메모리를 비운다. */
export function resetCursorWireModelMemory(): void {
  CURSOR_WIRE_MODEL_BY_CONVERSATION.clear();
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
  tools: readonly CursorWireTool[],
  estimatedInputTokens: number,
  toolFinalizeGraceMs: number,
  semanticStallTimeoutMs: number,
  report: CursorDiagnosticReporter,
  onClose: () => void,
): AsyncGenerator<CanonicalResponseEvent> {
  const responseId = `cursor_${randomUUID()}`;
  const itemId = `msg_${randomUUID()}`;
  const diagnosticModel = cursorDiagnosticLabel(model);
  const queue: CanonicalResponseEvent[] = [];
  const waiters: Array<() => void> = [];
  let buffer: Buffer = Buffer.alloc(0);
  let started = false;
  let finished = false;
  let failure: Error | null = null;
  let outputIndex = 0;
  let contextTokens: number | undefined;
  let contextWindow: number | undefined;
  let reportedOutputTokens = 0;
  let outputText = "";
  let frameCount = 0;
  let lastFrame = "none";
  let toolFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let semanticStallTimer: ReturnType<typeof setTimeout> | undefined;
  const toolItems = new Map<string, CursorToolItem>();

  const usage = (): CanonicalUsage => {
    const outputTokens = Math.max(reportedOutputTokens, estimateTokens(outputText, model));
    return {
      input_tokens: contextTokens === undefined
        ? estimatedInputTokens
        : Math.max(0, contextTokens - outputTokens),
      output_tokens: outputTokens,
      ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
    };
  };

  const wake = (): void => {
    while (waiters.length > 0) waiters.shift()?.();
  };
  const emit = (event: CanonicalResponseEvent): void => {
    if (!started) {
      started = true;
      queue.push({ type: "response.created", response: { id: responseId, model, usage: usage() } });
    }
    queue.push(event);
    wake();
  };
  const finish = (error?: Error, outcome = error ? "error" : "completed"): void => {
    if (finished) return;
    finished = true;
    if (toolFinalizeTimer) {
      clearTimeout(toolFinalizeTimer);
      toolFinalizeTimer = undefined;
    }
    if (semanticStallTimer) {
      clearTimeout(semanticStallTimer);
      semanticStallTimer = undefined;
    }
    if (error) failure = error;
    else if (started) queue.push({ type: "response.completed", response: { id: responseId, model, usage: usage() } });
    report("turn.finish", {
      model: diagnosticModel,
      outcome,
      frameCount,
      lastFrame,
      ...(error ? { error: cursorDiagnosticError(error) } : {}),
    });
    wake();
  };

  // Cursor heartbeats keep the HTTP/2 stream active even when the server is blocked waiting for a
  // client reply. Track meaningful protocol progress separately so heartbeats cannot mask a stall.
  const noteSemanticProgress = (): void => {
    if (!Number.isFinite(semanticStallTimeoutMs) || semanticStallTimeoutMs <= 0) return;
    if (semanticStallTimer) clearTimeout(semanticStallTimer);
    semanticStallTimer = setTimeout(() => {
      semanticStallTimer = undefined;
      const error = new Error("cursor stream semantic stall timeout");
      report("transport.semantic_timeout", {
        model: diagnosticModel,
        outcome: "semantic_stall_timeout",
      });
      finish(error, "semantic_stall_timeout");
      stream.destroy(error);
    }, semanticStallTimeoutMs);
    semanticStallTimer.unref?.();
  };

  const clearToolTurnFinish = (): void => {
    if (!toolFinalizeTimer) return;
    clearTimeout(toolFinalizeTimer);
    toolFinalizeTimer = undefined;
  };

  const ensureToolItem = (call: CursorMcpCall): CursorToolItem => {
    const existing = toolItems.get(call.callId);
    if (existing) {
      if (existing.name === "tool" && call.name !== "tool") existing.name = call.name;
      return existing;
    }
    outputIndex += 1;
    const entry: CursorToolItem = {
      itemId: call.callId,
      index: outputIndex,
      name: call.name,
      arguments: "",
      completed: false,
      suspended: false,
    };
    toolItems.set(call.callId, entry);
    emit({
      type: "response.output_item.added",
      output_index: entry.index,
      item: {
        id: entry.itemId,
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: "",
      },
    });
    return entry;
  };

  const completeToolItem = (call: CursorMcpCall): void => {
    const entry = ensureToolItem(call);
    if (entry.completed) return;
    const argumentsText = call.arguments ?? completeJson(entry.arguments) ?? "{}";
    entry.arguments = argumentsText;
    entry.completed = true;
    outputText += `\n${entry.name}\n${argumentsText}`;
    emit({
      type: "response.output_item.done",
      output_index: entry.index,
      item: {
        id: entry.itemId,
        type: "function_call",
        call_id: call.callId,
        name: entry.name,
        arguments: argumentsText,
      },
    });
  };

  const rescheduleToolTurnFinish = (): void => {
    clearToolTurnFinish();
    if (toolItems.size === 0 || [...toolItems.values()].some((entry) => !entry.suspended)) return;
    toolFinalizeTimer = setTimeout(() => {
      toolFinalizeTimer = undefined;
      finish(undefined, "client_tool_suspended");
      try {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      } catch {
        stream.destroy();
      }
    }, toolFinalizeGraceMs);
    toolFinalizeTimer.unref?.();
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
      ...(checkpointContextTokens === undefined
        ? {}
        : { contextTokens: checkpointContextTokens }),
      ...(checkpointContextWindow === undefined
        ? {}
        : { contextWindow: checkpointContextWindow }),
    });
    if (isRecord(frame.conversationCheckpointUpdate)) {
      if (checkpointContextTokens !== undefined) {
        contextTokens = Math.max(contextTokens ?? 0, checkpointContextTokens);
      }
      if (checkpointContextWindow !== undefined) contextWindow = checkpointContextWindow;
      return;
    }
    if (isRecord(frame.kvServerMessage)) {
      stream.write(encodeCursorClientMessage(kvReply(frame.kvServerMessage, blobs)));
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
      if (reply.planText) {
        outputText += reply.planText;
        emit({
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: reply.planText,
        });
      }
      return;
    }
    if (isRecord(frame.error)) {
      emit({ type: "error", error: cursorError(frame.error) });
      finish(undefined, "server_error");
      return;
    }
    if (isRecord(frame.execServerMessage)) {
      if (isRecord(frame.execServerMessage.requestContextArgs)) {
        stream.write(encodeCursorClientMessage(cursorRequestContextReply(frame.execServerMessage, tools)));
        report("client.reply", { model: diagnosticModel, reply: "exec.requestContext" });
        return;
      }
      const wireCall = mcpCallFromExecMessage(frame.execServerMessage);
      const call = wireCall ? cursorClientMcpCall(wireCall, tools) : null;
      if (call?.providerIdentifier === CURSOR_TOOL_PROVIDER_IDENTIFIER) {
        clearToolTurnFinish();
        ensureToolItem(call).suspended = true;
        completeToolItem(call);
        // Cursor will not send turnEnded here: it is synchronously waiting for an
        // mcpResult. The real result returns in the next Anthropic request, so end
        // this bridge turn and cancel the run without fabricating a result.
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
      for (const reply of policyReplies ?? []) {
        stream.write(encodeCursorClientMessage(reply));
      }
      if (policyReplies) {
        report("client.reply", {
          model: diagnosticModel,
          reply: `exec.policy.${cursorNestedRecordCase(frame.execServerMessage, CURSOR_EXEC_CASES)}`,
          count: policyReplies.length,
        });
      } else {
        const fallback = cursorUnknownExecReply(frame.execServerMessage, unknownExecFields);
        for (const payload of fallback.payloads) {
          stream.write(encodeConnectFrame(payload));
        }
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
      outputText += update.textDelta.text;
      emit({
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: update.textDelta.text,
      });
      return;
    }
    if (isRecord(update.thinkingDelta) && typeof update.thinkingDelta.text === "string") {
      outputText += update.thinkingDelta.text;
      return;
    }
    if (isRecord(update.tokenDelta)) {
      const tokens = positiveTokenCount(update.tokenDelta.tokens);
      if (tokens !== undefined) reportedOutputTokens += tokens;
      return;
    }
    if (isRecord(update.toolCallStarted)) {
      const wireCall = mcpCallFromToolUpdate(update.toolCallStarted);
      const call = wireCall ? cursorClientMcpCall(wireCall, tools) : null;
      if (call) {
        clearToolTurnFinish();
        ensureToolItem(call);
        rescheduleToolTurnFinish();
      }
      return;
    }
    if (isRecord(update.partialToolCall)) {
      const wireCall = mcpCallFromToolUpdate(update.partialToolCall);
      const call = wireCall ? cursorClientMcpCall(wireCall, tools) : null;
      if (!call) return;
      clearToolTurnFinish();
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
      clearToolTurnFinish();
      const entry = ensureToolItem(call);
      const argumentsText = call.arguments ?? completeJson(entry.arguments);
      if (argumentsText !== undefined) completeToolItem({ ...call, arguments: argumentsText });
      rescheduleToolTurnFinish();
      return;
    }
    if (isRecord(update.turnEnded)) finish(undefined, "turn_ended");
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
          report("server.frame", {
            model: diagnosticModel,
            frame: lastFrame,
            sequence: frameCount,
          });
          throw new Error("Compressed Cursor Connect frames are not supported");
        }
        if ((frame.flags & CONNECT_FLAG_END_STREAM) === CONNECT_FLAG_END_STREAM) {
          frameCount += 1;
          lastFrame = "connect.endStream";
          report("server.frame", {
            model: diagnosticModel,
            frame: lastFrame,
            sequence: frameCount,
          });
          const error = parseConnectEndStreamError(frame.payload);
          finish(error ?? undefined, error ? "connect_end_stream_error" : "connect_end_stream");
          continue;
        }
        const decodedFrame = decodeCursorServerMessage(frame.payload);
        if (!isCursorHeartbeatFrame(decodedFrame)) noteSemanticProgress();
        handleFrame(decodedFrame);
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)), "decode_error");
    }
  });
  stream.on("error", (error: Error) => {
    report("transport.stream_error", { model: diagnosticModel, error: cursorDiagnosticError(error) });
    finish(error, "stream_error");
  });
  stream.on("end", () => {
    report("transport.end", { model: diagnosticModel, frameCount, lastFrame });
    finish(undefined, "stream_end");
  });
  stream.on("close", () => {
    report("transport.close", { model: diagnosticModel, frameCount, lastFrame });
    finish(undefined, "stream_close");
  });
  noteSemanticProgress();

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
      if (toolFinalizeTimer) clearTimeout(toolFinalizeTimer);
      if (semanticStallTimer) clearTimeout(semanticStallTimer);
      onClose();
    }
  })();
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
}

interface CursorMcpCall {
  readonly callId: string;
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
  const callId = stringValue(value.callId) ?? stringValue(args?.toolCallId);
  if (!callId) return null;
  return {
    callId,
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
  const callId = stringValue(args.toolCallId);
  if (!callId) return null;
  return {
    callId,
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
