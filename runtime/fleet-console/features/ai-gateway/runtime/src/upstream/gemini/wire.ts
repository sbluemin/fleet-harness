/**
 * Gemini generateContent 요청 번역: canonical → `contents`/`tools`/`generationConfig`.
 *
 * 이 파일의 스키마 정화·도구 이름 코덱·thoughtSignature 규칙은 같은 generateContent 형식을 Cloud
 * Code 봉투로 말하던 선행 구현(#2592 이전 `upstream/antigravity/generate-content/`)의 실측에서 왔다.
 * 아래 "Measured …" 주석은 그 백엔드에서 본 값이고, 공개 `v1beta` 엔드포인트에서 달라질 수 있는
 * 곳(thinkingLevel 대소문자, 서명 누락 시 오류)은 해당 주석이 따로 적는다.
 */
import { createHash } from "node:crypto";

import {
  canonicalMessageImages,
  canonicalMessageText,
  type CanonicalFunctionTool,
  type CanonicalInputItem,
  type CanonicalResponseRequest,
  type CanonicalToolChoice,
  clampReasoningEffort,
  type ReasoningEffort,
} from "../../canonical/index.js";
import { GATEWAY_MODELS, upstreamModelId } from "../../models.js";
import { GEMINI_PROVIDER_ID, type GeminiModelId } from "./coordinates.js";

/** A Gemini `contents[]` entry. `model` is the assistant role on this wire. */
export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: {
    name: string;
    response: { result: string };
    id?: string;
  };
  inlineData?: { mimeType: string; data: string };
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type GeminiFunctionCallingMode = "NONE" | "ANY";

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: [{ text: string }] };
  tools?: [{ functionDeclarations: GeminiFunctionDeclaration[] }];
  toolConfig?: {
    functionCallingConfig: {
      mode: GeminiFunctionCallingMode;
      allowedFunctionNames?: string[];
    };
  };
  generationConfig: {
    maxOutputTokens?: number;
    thinkingConfig?: { thinkingLevel: string; includeThoughts: true };
  };
}

/**
 * Gemini's function-name grammar. Claude Code's own tools already satisfy it, but
 * MCP tools arrive as `mcp__<server>__<tool>` and can exceed the length or carry
 * characters this wire rejects, so every name goes through the codec below.
 */
const GEMINI_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * A per-request, reversible tool-name map.
 *
 * The upstream echoes the name it was given, so a rewritten name has to be
 * restored before the call reaches the caller — a client asked to execute
 * `mcp__linear__create_issue_a1b2c3d4` would have no such tool. The hash suffix
 * keeps two names that sanitize alike from collapsing onto one entry.
 */
export interface ToolNameCodec {
  toWire(name: string): string;
  fromWire(name: string): string;
}

export function createToolNameCodec(): ToolNameCodec {
  const toWireMap = new Map<string, string>();
  const fromWireMap = new Map<string, string>();
  return {
    toWire(name) {
      const cached = toWireMap.get(name);
      if (cached !== undefined) return cached;
      let wire = name;
      if (!GEMINI_TOOL_NAME_PATTERN.test(name)) {
        const suffix = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8);
        const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[^A-Za-z_]/, "_");
        wire = `${cleaned.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length - 1)}_${suffix}`;
      }
      toWireMap.set(name, wire);
      // A wire name already claimed by another tool would silently reroute one of
      // them; keep the first claim and let the second resolve to itself.
      if (!fromWireMap.has(wire)) fromWireMap.set(wire, name);
      return wire;
    },
    fromWire(name) {
      return fromWireMap.get(name) ?? name;
    },
  };
}

/**
 * JSON Schema keys Gemini's `functionDeclarations[].parameters` accepts.
 *
 * The wire is an OpenAPI subset, not JSON Schema: Claude Code sends draft-07
 * documents carrying `$schema`, `additionalProperties`, and `$ref`, and an
 * unknown key is a request-level rejection rather than an ignored field. This
 * is a whitelist so a new client-side key degrades into a slightly looser schema
 * instead of a failed turn.
 */
const GEMINI_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
]);

/**
 * 모델별 출력 토큰 상한. 컨텍스트 창과 출력 상한은 다른 숫자라서, 호출자가 더 큰 값을 요구해도
 * (Grok Build는 매 턴 128,000을 보낸다) 와이어는 이름도 한도도 없는 400으로 턴을 죽인다.
 * 거절보다 상한으로 줄이는 쪽이 맞다 — 공급자가 그 이상은 어차피 내지 않는다.
 *
 * 값 출처: 2026-11-18 사령관 실측 `GET /v1beta/models`의 outputTokenLimit
 * (argon 32768, carbon 32768, hydrogen 65536). 입력 창 1048576은 카탈로그(models.json)가 가진다.
 */
const GEMINI_OUTPUT_TOKEN_LIMITS: Readonly<Record<GeminiModelId, number>> = {
  "gemini-4-argon": 32_768,
  "gemini-4-carbon": 32_768,
  "gemini-4-hydrogen": 65_536,
};

function clampGeminiOutputTokens(model: string, requested: number): number {
  const limit = (GEMINI_OUTPUT_TOKEN_LIMITS as Readonly<Record<string, number | undefined>>)[model];
  return limit !== undefined && requested > limit ? limit : requested;
}

/** `format` values Gemini recognizes; anything else is dropped, not guessed. */
const GEMINI_STRING_FORMATS: ReadonlySet<string> = new Set(["enum", "date-time"]);
const GEMINI_NUMBER_FORMATS: ReadonlySet<string> = new Set(["float", "double", "int32", "int64"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function geminiOpenValueApproximation(depth = 2): Record<string, unknown> {
  const alternatives: Record<string, unknown>[] = [
    // `nullable` carries the otherwise unrepresentable JSON null branch.
    { type: "string", nullable: true },
    { type: "number" },
    { type: "boolean" },
    { type: "object", properties: {} },
  ];
  if (depth > 0) alternatives.push({
    type: "array",
    items: geminiOpenValueApproximation(depth - 1),
  });
  return { anyOf: alternatives };
}

function sanitizeGeminiItems(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return geminiOpenValueApproximation();
  const schema = sanitizeGeminiSchema(value);
  const hasStructure = typeof schema.type === "string"
    || isRecord(schema.properties)
    || Array.isArray(schema.anyOf);
  return hasStructure ? schema : geminiOpenValueApproximation();
}

function schemaAlternatives(schema: Record<string, unknown>): Record<string, unknown>[] {
  if (Object.keys(schema).length === 1 && Array.isArray(schema.anyOf)) {
    return schema.anyOf.filter(isRecord);
  }
  return [schema];
}

function geminiTupleItems(
  items: readonly unknown[],
  options: { readonly additional?: unknown; readonly allowsAdditional: boolean },
): Record<string, unknown> {
  const alternatives = items.flatMap((item) => schemaAlternatives(sanitizeGeminiItems(item)));
  if (options.allowsAdditional) {
    alternatives.push(...schemaAlternatives(sanitizeGeminiItems(options.additional)));
  }
  const distinct = [...new Map(alternatives.map((schema) => [JSON.stringify(schema), schema])).values()];
  if (distinct.length === 0) return geminiOpenValueApproximation();
  if (distinct.length === 1) return distinct[0]!;
  return { anyOf: distinct };
}

export function sanitizeGeminiSchema(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { type: "object", properties: {} };
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    switch (key) {
      case "properties": {
        if (!isRecord(raw)) break;
        const properties: Record<string, unknown> = {};
        for (const [name, schema] of Object.entries(raw)) {
          properties[name] = sanitizeGeminiSchema(schema);
        }
        out.properties = properties;
        break;
      }
      case "items":
        // Gemini requires one concrete schema here. JSON Schema tuples arrive either as the
        // draft-07 array form or as 2020-12 `prefixItems` plus an unconstrained `{}` tail.
        // Passing that empty tail produces `properties[...].items.items: missing field` and
        // rejects every tool in the request, so lower the positional schemas into one union.
        if (Array.isArray(raw)) {
          out.items = geminiTupleItems(raw, {
            additional: value.additionalItems,
            allowsAdditional: value.additionalItems !== false,
          });
        } else if (Array.isArray(value.prefixItems)) {
          out.items = geminiTupleItems(value.prefixItems, {
            additional: raw,
            allowsAdditional: raw !== false,
          });
        } else {
          out.items = sanitizeGeminiItems(raw);
        }
        break;
      case "anyOf":
        if (Array.isArray(raw)) {
          out.anyOf = raw.flatMap((entry) => schemaAlternatives(sanitizeGeminiItems(entry)));
        }
        break;
      case "format": {
        const type = typeof value.type === "string" ? value.type : "";
        const format = typeof raw === "string" ? raw : "";
        const allowed = type === "string" ? GEMINI_STRING_FORMATS : GEMINI_NUMBER_FORMATS;
        if (allowed.has(format)) out.format = format;
        break;
      }
      case "required":
        if (Array.isArray(raw)) out.required = raw.filter((entry) => typeof entry === "string");
        break;
      case "type": {
        // JSON Schema lets `type` be a union (`["string", "null"]`), which is how a client
        // spells an optional parameter. Gemini's wire is OpenAPI, where `type` is one scalar
        // and absence is `nullable` — it answers a list with a request-level 400
        // ("Proto field is not repeating, cannot start list"), so the whole turn dies, tools
        // and all. The key whitelist above cannot catch this: the key is legal and the
        // *value shape* is not.
        //
        // Measured against Grok Build 1.0.5, whose 26 built-in tools carry 32 such unions.
        // Claude Code sends none, which is why this survived until a second client arrived.
        if (typeof raw === "string") {
          out.type = raw;
          break;
        }
        if (!Array.isArray(raw)) break;
        const named = raw.filter((entry): entry is string => typeof entry === "string");
        const concrete = named.filter((entry) => entry !== "null");
        // `null` in the union is the client saying "may be omitted" — Gemini's own spelling.
        if (named.length !== concrete.length) out.nullable = true;
        // Keep the first concrete member. A union of two real types cannot be expressed here,
        // and narrowing beats refusing the request: the model still gets a usable parameter.
        if (concrete[0] !== undefined) out.type = concrete[0];
        break;
      }
      default:
        out[key] = raw;
    }
  }
  // An object with no declared type reads as untyped upstream and is refused;
  // every tool parameter document is an object at its root.
  if (out.type === undefined && out.properties !== undefined) out.type = "object";
  // Unlike JSON Schema, Gemini does not interpret a missing `items` as an unconstrained
  // element. Supply a concrete schema even when a client used only `prefixItems` or left
  // the array open-ended.
  if (out.type === "array" && out.items === undefined) {
    out.items = Array.isArray(value.prefixItems)
      ? geminiTupleItems(value.prefixItems, { allowsAdditional: true })
      : geminiOpenValueApproximation();
  }
  // A homogeneous schema cannot express tuple length on its own. Preserve the positional
  // ceiling when the source explicitly closed its tail, without weakening a smaller limit.
  const tuple = Array.isArray(value.items)
    ? value.items
    : Array.isArray(value.prefixItems) ? value.prefixItems : undefined;
  const closedTuple = Array.isArray(value.items)
    ? value.additionalItems === false
    : tuple !== undefined && value.items === false;
  if (closedTuple && tuple) {
    const explicitMax = typeof out.maxItems === "number" ? out.maxItems : undefined;
    out.maxItems = explicitMax === undefined ? tuple.length : Math.min(explicitMax, tuple.length);
  }
  // The mirror case: a declared object with no property map. A client spells a free-form
  // payload that way — Grok Build's `use_tool.tool_input` carries whatever schema the MCP
  // tool on the other side declares, so it cannot enumerate fields. Gemini refuses the
  // request rather than reading it as "any object", and the refusal is the generic
  // "Request contains an invalid argument", which names nothing. An empty map says the same
  // thing in the shape this wire accepts.
  if (out.type === "object" && out.properties === undefined) out.properties = {};
  return out;
}

export function geminiFunctionDeclarations(
  tools: readonly CanonicalFunctionTool[],
  codec: ToolNameCodec,
): GeminiFunctionDeclaration[] {
  return tools.map((tool) => ({
    name: codec.toWire(tool.name),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: sanitizeGeminiSchema(tool.parameters),
  }));
}

/**
 * Translate the canonical tool choice.
 *
 * `auto` sends no `toolConfig` at all: the wire's own default is the same thing,
 * and stating it would make a no-tool turn carry a config it does not need.
 */
export function geminiToolConfig(
  choice: CanonicalToolChoice | undefined,
  codec: ToolNameCodec,
): GeminiGenerateContentRequest["toolConfig"] | undefined {
  if (choice === undefined || choice === "auto") return undefined;
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  return {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: [codec.toWire(choice.name)] },
  };
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

function imagePart(imageUrl: string): GeminiPart | undefined {
  const match = DATA_URL.exec(imageUrl);
  if (!match) return undefined;
  const [, mimeType, data] = match;
  if (!mimeType || !data) return undefined;
  return { inlineData: { mimeType, data } };
}

/** 이 어댑터가 자기가 낸 추론 blob에 찍는 발행자. 다른 공급자의 blob은 이 값으로 걸러낸다. */
export const GEMINI_REASONING_ORIGIN = GEMINI_PROVIDER_ID;

/**
 * 이전 assistant 턴이 만든 thoughtSignature를 클라이언트가 되돌려 준 그대로 받는다.
 *
 * 문서(reference `Part.thoughtSignature`: "An opaque signature for the thought so it can be reused
 * in subsequent requests", 2026-11-18)와, 같은 generateContent 형식을 쓰던 선행 구현의 실측
 * (2026-08-22: functionCall에 blob을 돌려주지 않으면 `400 INVALID_ARGUMENT` "Function call is
 * missing a thought_signature")에 따라 blob은 그 functionCall 파트에 그대로 얹어야 한다.
 * canonical 경계가 이미 공급자 추론 blob을 Anthropic wire의 thinking `signature`로 왕복시키므로
 * blob은 클라이언트가 재생하는 대화에 실려 오고, Fleet이 키를 만들고 만료시킬 캐시가 필요 없다.
 * {@link GeminiSignatureLedger}는 클라이언트가 blob을 되돌려 주지 않은 턴(압축·thinking 블록을
 * 버리는 호출자)을 위한 대체 경로일 뿐이다.
 */
export interface GeminiSignatureLedger {
  /** 이 call id가 발행받은 blob을 기억한다. */
  record(callId: string, signature: string): void;
  /** 클라이언트가 blob을 되돌려 주지 않았을 때 call id로 찾는다. */
  recall(callId: string): string | undefined;
}

/**
 * blob은 업스트림 자신의 `functionCall.id`로 찾는다. Claude Code가 `tool_use.id`로 그대로 되돌리고
 * `tool_result.tool_use_id`로 돌려 보내므로 키가 인자 해시가 아니라 정확한 값이다. 원장은 메모리에
 * 있고 크기가 묶여 있다 — 시스템 오브 레코드가 아니라 thinking 블록을 잃은 클라이언트를 견디는 용도다.
 */
export function createGeminiSignatureLedger(maxEntries = 512): GeminiSignatureLedger {
  const entries = new Map<string, string>();
  return {
    record(callId, signature) {
      if (callId.length === 0 || signature.length === 0) return;
      // 다시 넣어 Map의 순회 순서를 가장 오래 안 쓴 것 먼저로 유지한다.
      entries.delete(callId);
      entries.set(callId, signature);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    recall(callId) {
      return entries.get(callId);
    },
  };
}

/**
 * 업스트림이 낼 법한 서명인가.
 *
 * 다른 공급자의 추론 id도 `reasoning_encrypted`로 들어올 수 있고, 그걸 보내면 업스트림은 진짜
 * 원인이 아니라 Base64 디코딩 실패로 턴을 거절한다. 길이와 문자 집합이 실제 blob(base64 수백 자)과
 * 외부 식별자를 가르는 값싼 검사다.
 */
export function isGeminiSignature(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 16
    && !/^(fc|ctc|tsc|call|msg|rs|resp|reasoning|item|ws|toolu|tool|func|function)[-_]/i.test(value)
    && /^[A-Za-z0-9+/_=-]+$/.test(value);
}

function parsedArguments(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 이 wire가 되돌려 보낼 수 있는 blob: 이 어댑터가 발행해 origin을 찍은 것만이다. 발행자 없는
 * blob(v1 서명)은 받지 않는다 — Gemini 공급자는 발행자를 싣기 전의 blob을 낸 적이 없고, 다른
 * 공급자의 blob은 형태 검사를 통과하므로(Codex blob도 plausible한 base64url이다) origin이 먼저다.
 */
function ownedSignature(item: { reasoning_encrypted?: string; reasoning_origin?: string }): string | undefined {
  if (item.reasoning_origin !== GEMINI_REASONING_ORIGIN) return undefined;
  return isGeminiSignature(item.reasoning_encrypted) ? item.reasoning_encrypted : undefined;
}

function signatureFor(
  item: { reasoning_encrypted?: string; reasoning_origin?: string },
  callId: string,
  ledger: GeminiSignatureLedger,
): string | undefined {
  const carried = ownedSignature(item);
  if (carried !== undefined) return carried;
  const recalled = ledger.recall(callId);
  return isGeminiSignature(recalled) ? recalled : undefined;
}

/**
 * canonical 입력 목록을 Gemini `contents`로 접는다.
 *
 * 같은 role의 연속 항목은 한 entry로 합친다: wire는 role이 번갈아야 하고, 도구 왕복이 결과마다
 * content 하나씩을 만들어서는 안 된다.
 */
export function geminiContents(
  input: readonly CanonicalInputItem[],
  codec: ToolNameCodec,
  ledger: GeminiSignatureLedger,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const push = (role: GeminiContent["role"], parts: GeminiPart[]): void => {
    if (parts.length === 0) return;
    const tail = contents.at(-1);
    if (tail && tail.role === role) tail.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const item of input) {
    if (item.type === "function_call") {
      const signature = signatureFor(item, item.call_id, ledger);
      push("model", [{
        ...(signature === undefined ? {} : { thoughtSignature: signature }),
        functionCall: {
          name: codec.toWire(item.name),
          args: parsedArguments(item.arguments),
          id: item.call_id,
        },
      }]);
      continue;
    }
    if (item.type === "function_call_output") {
      const parts: GeminiPart[] = [{
        functionResponse: {
          name: codec.toWire(item.call_id),
          response: { result: canonicalMessageText(item.output) },
          id: item.call_id,
        },
      }];
      // 각 결과의 이미지는 연결된 function response 바로 옆에 둔다.
      for (const image of canonicalMessageImages(item.output)) {
        const part = imagePart(image.image_url);
        if (!part) throw new Error("Gemini tool result images require base64 data URLs.");
        parts.push(part);
      }
      push("user", parts);
      continue;
    }
    // `developer`는 wire에 세 번째 role이 없는 system 성격 텍스트다. `systemInstruction`이 이미
    // 쓰였으므로 user 턴이 제자리다.
    const role: GeminiContent["role"] = item.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    const text = canonicalMessageText(item.content);
    if (text.length > 0) {
      const signature = role === "model" ? ownedSignature(item) : undefined;
      parts.push({ text, ...(signature === undefined ? {} : { thoughtSignature: signature }) });
    }
    for (const image of canonicalMessageImages(item.content)) {
      const part = imagePart(image.image_url);
      if (part) parts.push(part);
    }
    push(role, parts);
  }
  return contents;
}

/**
 * `functionResponse.name`은 호출된 함수 이름이어야 하는데 canonical 결과 항목은 call id만 싣는다.
 * 같은 요청 안에서 앞선 호출로 이름을 바로잡는다.
 */
export function linkFunctionResponseNames(contents: GeminiContent[]): GeminiContent[] {
  const namesByCallId = new Map<string, string>();
  for (const content of contents) {
    for (const part of content.parts) {
      if (part.functionCall?.id) namesByCallId.set(part.functionCall.id, part.functionCall.name);
    }
  }
  for (const content of contents) {
    for (const part of content.parts) {
      const response = part.functionResponse;
      if (!response?.id) continue;
      const name = namesByCallId.get(response.id);
      if (name) response.name = name;
    }
  }
  return contents;
}

/**
 * 요청한 effort에 대응하는 `thinkingConfig.thinkingLevel`. 카탈로그가 사다리를 선언한 Gemini 모델에만
 * 싣는다 — 라우터가 이미 같은 사다리로 클램프하지만 canonical을 직접 부르는 호출자에게도 같은 계약이
 * 서야 한다. 사다리 위의 요청은 가장 높은 단으로, `minimal`은 `low`로 내린다(Gemini 4 계열은
 * `minimal`을 지원하지 않는다: 공식 thinking 문서, 2026-11-18).
 *
 * effort가 없으면 싣지 않는다: Gemini 4는 thinking을 끌 수 없고 모델 기본값(argon·carbon medium,
 * hydrogen high)이 이미 켜져 있다. 값은 소문자다 — 2026-11-18 사령관 실측 요청(`thinkingLevel low`).
 */
function geminiThinkingLevel(model: string, effort: ReasoningEffort | undefined): string | undefined {
  if (effort === undefined) return undefined;
  const entry = GATEWAY_MODELS.find(
    (candidate) => candidate.provider === GEMINI_PROVIDER_ID && upstreamModelId(candidate) === model,
  );
  if (entry?.effort.supported !== true) return undefined;
  return clampReasoningEffort(effort === "minimal" ? "low" : effort, entry.effort.levels, model);
}

export interface BuildRequestOptions {
  readonly codec: ToolNameCodec;
  readonly ledger: GeminiSignatureLedger;
}

/** `POST /models/{model}:streamGenerateContent`의 본문. 모델은 URL이 정하므로 본문에는 없다. */
export function buildGeminiRequest(
  request: CanonicalResponseRequest,
  options: BuildRequestOptions,
): GeminiGenerateContentRequest {
  const contents = linkFunctionResponseNames(
    geminiContents(request.input, options.codec, options.ledger),
  );
  const declarations = geminiFunctionDeclarations(request.tools ?? [], options.codec);
  const toolConfig = geminiToolConfig(request.tool_choice, options.codec);
  const thinkingLevel = geminiThinkingLevel(request.model, request.reasoning?.effort);
  return {
    contents,
    ...(request.instructions === undefined || request.instructions.length === 0
      ? {}
      : { systemInstruction: { parts: [{ text: request.instructions }] as [{ text: string }] } }),
    ...(declarations.length > 0
      ? { tools: [{ functionDeclarations: declarations }] as [{ functionDeclarations: GeminiFunctionDeclaration[] }] }
      : {}),
    ...(toolConfig === undefined ? {} : { toolConfig }),
    generationConfig: {
      ...(request.max_output_tokens === undefined
        ? {}
        : { maxOutputTokens: clampGeminiOutputTokens(request.model, request.max_output_tokens) }),
      // 생각 요약(thought 파트)은 includeThoughts를 켜야 온다. 과금은 같다 — thoughtsTokenCount는
      // 요약을 받든 말든 출력 단가로 센다.
      ...(thinkingLevel === undefined
        ? {}
        : { thinkingConfig: { thinkingLevel, includeThoughts: true as const } }),
    },
  };
}
