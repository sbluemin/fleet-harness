import { createHash } from "node:crypto";

import {
  canonicalMessageImages,
  canonicalMessageText,
  type CanonicalFunctionTool,
  type CanonicalInputItem,
  type CanonicalResponseRequest,
  type CanonicalToolChoice,
} from "../../../canonical/index.js";
import { resolveAntigravityModelSelection } from "../models.js";

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
  inline_data?: { mime_type: string; data: string };
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type GeminiFunctionCallingMode = "NONE" | "ANY" | "VALIDATED";

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: { role: "user"; parts: [{ text: string }] };
  tools?: [{ functionDeclarations: GeminiFunctionDeclaration[] }];
  toolConfig?: {
    functionCallingConfig: {
      mode: GeminiFunctionCallingMode;
      allowedFunctionNames?: string[];
    };
  };
  generationConfig: {
    maxOutputTokens?: number;
    thinkingConfig?: { thinkingLevel: string };
  };
  sessionId: string;
}

/**
 * The Cloud Code Assist envelope. The Gemini body is nested under `request`;
 * everything beside it identifies the client rather than the turn.
 */
export interface AntigravityEnvelope {
  model: string;
  userAgent: "antigravity";
  requestType: "agent";
  project?: string;
  requestId: string;
  request: GeminiGenerateContentRequest;
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
 * The largest `maxOutputTokens` this wire accepts.
 *
 * The context window and the output ceiling are different numbers: the catalog window for
 * Gemini 3.7 Flash is 1M, and the wire still refuses an output request above 64k with the
 * contentless `Request contains an invalid argument` — no field name, no limit, just a 400
 * that kills the turn before a token is produced.
 *
 * Measured 2026-08-23 against `daily-cloudcode-pa.googleapis.com`: 65,536 and below are
 * accepted, 131,072 is refused, with and without tools. A client that asks for more is not
 * making a mistake — Grok Build asks for 128,000 on every turn because that is the ceiling
 * it reads from its own config — so clamping is right and refusing is not. A caller cannot
 * receive more than the provider will emit anyway.
 */
const GEMINI_MAX_OUTPUT_TOKENS = 65_536;

function clampGeminiOutputTokens(requested: number): number {
  return requested > GEMINI_MAX_OUTPUT_TOKENS ? GEMINI_MAX_OUTPUT_TOKENS : requested;
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
  return Object.keys(schema).length === 0 ? geminiOpenValueApproximation() : schema;
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
        if (Array.isArray(raw)) out.anyOf = raw.map((entry) => sanitizeGeminiSchema(entry));
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
  return { inline_data: { mime_type: mimeType, data } };
}

/**
 * The signature a prior assistant turn produced, as it comes back from the client.
 *
 * Cloud Code Assist requires the blob it issued for a `functionCall` to be echoed
 * on that same part next turn — measured 2026-08-22, omitting it fails the request
 * with `400 INVALID_ARGUMENT` ("Function call is missing a thought_signature in
 * functionCall parts"). The canonical seam already round-trips a provider
 * reasoning blob through the Anthropic wire, so the blob rides the conversation
 * the client replays instead of a cache Fleet would have to key, size, and expire.
 * {@link AntigravitySignatureLedger} is the fallback for the turns where the
 * client did not carry it back.
 */
export interface AntigravitySignatureLedger {
  /** Remember the blob this call id was issued with. */
  record(callId: string, signature: string): void;
  /** The blob for a call id, when the client did not return one. */
  recall(callId: string): string | undefined;
}

/**
 * Blobs are addressed by the upstream's own `functionCall.id`, which Claude Code
 * echoes verbatim as `tool_use.id` and returns as `tool_result.tool_use_id`, so
 * the key is exact rather than a hash of the call's arguments. The ledger is
 * in-memory and bounded: it exists only to survive a client that dropped a
 * thinking block (compaction, a non-replaying caller), never as the system of
 * record.
 */
export function createAntigravitySignatureLedger(maxEntries = 512): AntigravitySignatureLedger {
  const entries = new Map<string, string>();
  return {
    record(callId, signature) {
      if (callId.length === 0 || signature.length === 0) return;
      // Re-insert so the map's iteration order stays least-recently-used first.
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
 * A signature the upstream could plausibly have issued.
 *
 * Every other provider's reasoning id also reaches `reasoning_encrypted`, and
 * forwarding one of those makes the upstream reject the turn for a Base64 decode
 * failure rather than for the real cause. Length and alphabet are the two cheap
 * tests that separate a real blob (observed 264-1128 characters of base64) from a
 * foreign identifier.
 */
export function isAntigravitySignature(value: unknown): value is string {
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

function signatureFor(
  item: { reasoning_encrypted?: string },
  callId: string,
  ledger: AntigravitySignatureLedger,
): string | undefined {
  if (isAntigravitySignature(item.reasoning_encrypted)) return item.reasoning_encrypted;
  const recalled = ledger.recall(callId);
  return isAntigravitySignature(recalled) ? recalled : undefined;
}

/**
 * Fold the canonical input list into Gemini `contents`.
 *
 * Consecutive items of one role merge into a single entry: the wire alternates
 * roles, and a tool round-trip otherwise produces one content per result.
 */
export function geminiContents(
  input: readonly CanonicalInputItem[],
  codec: ToolNameCodec,
  ledger: AntigravitySignatureLedger,
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
      push("user", [{
        functionResponse: {
          name: codec.toWire(item.call_id),
          response: { result: item.output },
          id: item.call_id,
        },
      }]);
      continue;
    }
    // `developer` carries system-shaped text the wire has no third role for; the
    // user turn is where it belongs once `systemInstruction` is already spoken for.
    const role: GeminiContent["role"] = item.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    const text = canonicalMessageText(item.content);
    if (text.length > 0) {
      const signature = role === "model" && isAntigravitySignature(item.reasoning_encrypted)
        ? item.reasoning_encrypted
        : undefined;
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
 * `functionResponse.name` must name the function that was called, but the
 * canonical result item carries only the call id. Repair it from the call that
 * preceded it in the same request.
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
 * A stable per-conversation id in the shape the wire uses (`-<uint63>`).
 *
 * The upstream is stateless — the whole history is replayed every turn — so this
 * only groups a conversation's requests for the provider's own telemetry. It is
 * derived from the first user text so it stays the same across the turns of one
 * conversation without Fleet holding any session state.
 */
export function antigravitySessionId(input: readonly CanonicalInputItem[]): string {
  const anchor = input.find(
    (item): item is Extract<CanonicalInputItem, { type: "message" }> =>
      item.type === "message" && item.role === "user",
  );
  const text = anchor ? canonicalMessageText(anchor.content) : "";
  const digest = createHash("sha256").update(text, "utf8").digest();
  const masked = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${masked.toString()}`;
}

export interface BuildEnvelopeOptions {
  readonly project?: string;
  readonly requestId: string;
  readonly codec: ToolNameCodec;
  readonly ledger: AntigravitySignatureLedger;
}

export function buildAntigravityEnvelope(
  request: CanonicalResponseRequest,
  options: BuildEnvelopeOptions,
): AntigravityEnvelope {
  const selection = resolveAntigravityModelSelection(request.model, request.reasoning?.effort);
  const contents = linkFunctionResponseNames(
    geminiContents(request.input, options.codec, options.ledger),
  );
  const declarations = geminiFunctionDeclarations(request.tools ?? [], options.codec);
  const toolConfig = geminiToolConfig(request.tool_choice, options.codec);
  return {
    model: selection.wireModelId,
    userAgent: "antigravity",
    requestType: "agent",
    ...(options.project === undefined ? {} : { project: options.project }),
    requestId: options.requestId,
    request: {
      contents,
      ...(request.instructions === undefined || request.instructions.length === 0
        ? {}
        : { systemInstruction: { role: "user" as const, parts: [{ text: request.instructions }] as [{ text: string }] } }),
      ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] as [{ functionDeclarations: GeminiFunctionDeclaration[] }] } : {}),
      ...(toolConfig === undefined ? {} : { toolConfig }),
      generationConfig: {
        ...(request.max_output_tokens === undefined
          ? {}
          : { maxOutputTokens: clampGeminiOutputTokens(request.max_output_tokens) }),
        ...(selection.thinkingLevel === undefined
          ? {}
          : { thinkingConfig: { thinkingLevel: selection.thinkingLevel } }),
      },
      sessionId: antigravitySessionId(request.input),
    },
  };
}
