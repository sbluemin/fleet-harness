import { describe, expect, it } from "vitest";
import { fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";

import {
  CURSOR_CLIENT_VERSION,
  CURSOR_TOOL_BYTES_LIMIT,
  CURSOR_TOOL_COUNT_LIMIT,
  CURSOR_TOOL_PROVIDER_IDENTIFIER,
  CursorAdapter,
  CursorRequestBudgetError,
  buildCursorRunPlan,
  translateAnthropicRequest,
} from "../../../../src/index.js";
import type { AnthropicMessagesRequest, CanonicalResponseRequest } from "../../../../src/index.js";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  UserMessageSchema,
} from "../../../../src/upstream/cursor/native/generated/cursor-agent-protobuf.js";

describe("Cursor request budgets", () => {
  it("uses the verified Cursor tool transport version", () => {
    expect(CURSOR_CLIENT_VERSION).toBe("cli-2026.07.08-0c04a8a");
  });

  it("routes Anthropic WebSearch through Cursor native search instead of MCP protobuf", () => {
    const anthropic = {
      model: "claude-gateway--cursor--grok-4.5-fast",
      system: [{ type: "text", text: "Perform a web search." }],
      messages: [{ role: "user", content: "Search current Cursor provider docs." }],
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        allowed_domains: ["github.com"],
        max_uses: 8,
      }],
      tool_choice: { type: "tool", name: "web_search" },
      max_tokens: 1024,
      stream: true,
    } as unknown as AnthropicMessagesRequest;
    const canonical = translateAnthropicRequest(anthropic, {
      model: "grok-4.5-fast",
      nativeTools: ["web_search"],
    } as Parameters<typeof translateAnthropicRequest>[1]);

    const plan = buildCursorRunPlan(canonical, "conversation-native-web-search");

    expect(runRequest(plan).mcpTools).toBeUndefined();
    expect(systemText(plan)).toContain("Cursor-native web search is available");
    expect(systemText(plan)).toContain("github.com");
    expect(systemText(plan)).toContain("no more than 8 searches");
  });

  it("never sends a custom system prompt, which Cursor rejects the Run for", () => {
    const withInstructions = request({
      instructions: "Harness instructions.",
      tools: [tool("Read")],
    });

    expect(encodedRunRequest(buildCursorRunPlan(withInstructions, "conversation-custom-system-prompt")).customSystemPrompt)
      .toBeUndefined();
    expect(systemText(buildCursorRunPlan(withInstructions, "conversation-custom-system-prompt")))
      .toContain("Harness instructions.");
  });

  it("rejects an explicitly selected tool that cannot fit", () => {
    expect(() => buildCursorRunPlan(request({
      tools: [tool("selected", "x".repeat(CURSOR_TOOL_BYTES_LIMIT))],
      tool_choice: { type: "function", name: "selected" },
    }), "conversation-selected-tool")).toThrow(CursorRequestBudgetError);
  });
});

function request(overrides: Partial<CanonicalResponseRequest> = {}): CanonicalResponseRequest {
  return {
    model: "gpt-5.6-sol-high",
    input: [{ type: "message", role: "user", content: "active" }],
    stream: true,
    ...overrides,
  };
}

function tool(
  name: string,
  description = "tool",
  parameters: Record<string, unknown> = { type: "object", properties: { value: { type: "string" } } },
): NonNullable<CanonicalResponseRequest["tools"]>[number] {
  return {
    type: "function",
    name,
    description,
    parameters,
  };
}

interface WireTool {
  readonly name: string;
  readonly toolName: string;
  readonly inputSchema: string;
}

interface RunRequest {
  readonly modelDetails: {
    readonly modelId: string;
    readonly maxMode?: boolean;
  };
  readonly conversationState: {
    readonly rootPromptMessagesJson: readonly string[];
    readonly turns: readonly string[];
  };
  readonly action?: {
    readonly resumeAction?: { readonly requestContext?: RequestContext };
    readonly userMessageAction?: {
      readonly requestContext?: RequestContext;
      readonly userMessage?: {
        readonly text?: string;
        readonly selectedContext?: {
          readonly selectedImages?: ReadonlyArray<{
            readonly uuid?: string;
            readonly mimeType?: string;
            readonly data?: string;
            readonly path?: string;
          }>;
        };
      };
    };
  };
  readonly mcpTools?: { readonly mcpTools: readonly WireTool[] };
  readonly customSystemPrompt?: string;
}

interface RequestContext {
  readonly rules?: ReadonlyArray<{
    readonly fullPath?: string;
    readonly content?: string;
    readonly type?: { readonly global?: unknown };
  }>;
}

function runRequest(plan: ReturnType<typeof buildCursorRunPlan>): RunRequest {
  return (plan.payload as { readonly runRequest: RunRequest }).runRequest;
}

function encodeRunPlan(plan: ReturnType<typeof buildCursorRunPlan>): Uint8Array {
  return toBinary(
    AgentClientMessageSchema,
    fromJson(AgentClientMessageSchema, plan.payload as JsonValue),
  );
}

function encodedRunRequest(plan: ReturnType<typeof buildCursorRunPlan>): RunRequest {
  const encoded = encodeRunPlan(plan);
  const decoded = toJson(
    AgentClientMessageSchema,
    fromBinary(AgentClientMessageSchema, encoded),
  );
  return (decoded as unknown as { readonly runRequest: RunRequest }).runRequest;
}

function rootValues(plan: ReturnType<typeof buildCursorRunPlan>): Array<Record<string, unknown>> {
  return runRequest(plan).conversationState.rootPromptMessagesJson.map((id) => {
    const encoded = plan.blobs.get(id);
    if (!encoded) throw new Error(`Missing Cursor root blob: ${id}`);
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
  });
}

function systemText(plan: ReturnType<typeof buildCursorRunPlan>): string {
  const system = rootValues(plan)[0] as { readonly content?: unknown } | undefined;
  return typeof system?.content === "string" ? system.content : "";
}

function decodeBlob(
  plan: ReturnType<typeof buildCursorRunPlan>,
  id: string,
  schema: typeof ConversationStepSchema | typeof ConversationTurnStructureSchema,
): unknown {
  const encoded = plan.blobs.get(id);
  if (!encoded) throw new Error(`Missing Cursor blob: ${id}`);
  if (schema === ConversationStepSchema) {
    return toJson(schema, fromBinary(schema, Buffer.from(encoded, "base64")));
  }
  return toJson(schema, fromBinary(schema, Buffer.from(encoded, "base64")));
}
