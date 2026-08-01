import { describe, expect, it } from "vitest";
import { fromBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";

import {
  CURSOR_CLIENT_VERSION,
  CURSOR_EXTERNAL_ROOT_BLOB_LIMIT,
  CURSOR_EXTERNAL_ROOT_BYTE_LIMIT,
  CURSOR_TOOL_BYTES_LIMIT,
  CURSOR_TOOL_COUNT_LIMIT,
  CursorRequestBudgetError,
  UnsupportedReasoningEffortError,
  buildCursorRunPlan,
} from "../src/index.js";
import type { CanonicalResponseRequest } from "../src/index.js";
import {
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  UserMessageSchema,
} from "../src/generated/cursor-agent-protobuf.js";

describe("Cursor request budgets", () => {
  it("uses the verified Cursor tool transport version", () => {
    expect(CURSOR_CLIENT_VERSION).toBe("cli-2026.07.08-0c04a8a");
  });

  it.each([
    ["gpt-5.6-luna", "low", "gpt-5.6-luna-low"],
    ["gpt-5.6-luna", "ultra", "gpt-5.6-luna-max"],
    ["kimi-k3", "medium", "kimi-k3-low"],
    ["kimi-k3", "xhigh", "kimi-k3-high"],
    ["grok-4.5-fast", "low", "cursor-grok-4.5-low-fast"],
  ] as const)("writes Cursor model %s with effort %s as %s", (model, effort, expected) => {
    const plan = buildCursorRunPlan(request({
      model,
      reasoning: { summary: "auto", effort },
    }), "conversation-effort");

    expect(runRequest(plan).modelDetails.modelId).toBe(expected);
  });

  it("uses the registry default when a Cursor reasoning model has no explicit effort", () => {
    const plan = buildCursorRunPlan(request({ model: "kimi-k3" }), "conversation-default-effort");

    expect(runRequest(plan).modelDetails.modelId).toBe("kimi-k3-max");
  });

  it("rejects an explicit effort when the model has no supported lower rung", () => {
    expect(() => buildCursorRunPlan(request({
      model: "glm-5.2",
      reasoning: { summary: "auto", effort: "medium" },
    }), "conversation-no-lower-effort")).toThrow(UnsupportedReasoningEffortError);
  });

  it("encodes tool schemas as protobuf Value bytes for Cursor's binary transport", () => {
    const schema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    };
    const plan = buildCursorRunPlan(request({ tools: [tool("probe_tool", "probe", schema)] }), "conversation-schema");
    const encoded = runRequest(plan).mcpTools?.mcpTools[0]?.inputSchema;

    expect(encoded).toBeTypeOf("string");
    expect(toJson(ValueSchema, fromBinary(ValueSchema, Buffer.from(encoded!, "base64")))).toEqual(schema);
    expect(systemText(plan)).toContain("available tool names are exactly `probe_tool`");
    expect(systemText(plan)).toContain("including every required field");
  });

  it("directs gateway models to prefer dedicated client tools over Bash", () => {
    const plan = buildCursorRunPlan(request({
      tools: [tool("Bash"), tool("Edit"), tool("Read"), tool("Write")],
    }), "conversation-tool-discipline");
    const instructions = systemText(plan);

    expect(instructions).toContain("Do not invoke Cursor-native tools in gateway mode");
    expect(instructions).toContain("Prefer purpose-built client tools over `Bash`");
    expect(instructions).toContain("`Read` for reading files");
    expect(instructions).toContain("`Edit` for exact file changes");
    expect(instructions).toContain("Never use `Bash` with Python, sed, perl, or heredocs");
    expect(instructions).toContain("neither `Grep` nor `Glob` is advertised");
  });

  it("caps every tool catalog while retaining execution-critical tools", () => {
    const filler = Array.from({ length: CURSOR_TOOL_COUNT_LIMIT + 20 }, (_, index) => tool(`mcp__filler__tool_${index}`));
    const tools = [
      ...filler,
      tool("exec_command"),
      tool("apply_patch"),
      tool("mcp__selected__chosen"),
      tool("tool_search"),
    ];
    const plan = buildCursorRunPlan(request({
      tools,
      tool_choice: { type: "function", name: "mcp__selected__chosen" },
    }), "conversation-tools");
    const run = runRequest(plan);
    const kept = run.mcpTools?.mcpTools ?? [];
    const names = kept.map((entry) => entry.toolName);

    expect(kept).toHaveLength(CURSOR_TOOL_COUNT_LIMIT);
    expect(names).toEqual(expect.arrayContaining([
      "exec_command",
      "apply_patch",
      "mcp__selected__chosen",
      "tool_search",
    ]));
    expect(systemText(plan)).toContain("Cursor transport limits expose 330 of 354 tools");
    expect(systemText(plan)).toContain("Use tool_search");
  });

  it("measures the tool catalog against the transport byte ceiling", () => {
    const tools = Array.from({ length: 20 }, (_, index) => tool(
      `large_tool_${index}`,
      "x".repeat(20_000),
    ));
    const plan = buildCursorRunPlan(request({ tools }), "conversation-tool-bytes");
    const run = runRequest(plan);
    const kept = run.mcpTools?.mcpTools ?? [];
    const encoded = Buffer.byteLength(JSON.stringify({ mcpTools: run.mcpTools }), "utf8");

    expect(kept.length).toBeLessThan(tools.length);
    expect(encoded).toBeLessThanOrEqual(CURSOR_TOOL_BYTES_LIMIT);
    expect(systemText(plan)).toContain("Omitted and unavailable this turn");
  });

  it("rejects an explicitly selected tool that cannot fit", () => {
    expect(() => buildCursorRunPlan(request({
      tools: [tool("selected", "x".repeat(CURSOR_TOOL_BYTES_LIMIT))],
      tool_choice: { type: "function", name: "selected" },
    }), "conversation-selected-tool")).toThrow(CursorRequestBudgetError);
  });

  it("keeps the newest complete external-model turns under the root count ceiling", () => {
    const input: CanonicalResponseRequest["input"] = [];
    for (let index = 0; index < 220; index += 1) {
      input.push({ type: "message", role: "user", content: `user-${index}` });
      input.push({ type: "message", role: "assistant", content: `assistant-${index}` });
    }
    input.push({ type: "message", role: "user", content: "active-user" });
    const plan = buildCursorRunPlan(request({ input }), "conversation-roots");
    const roots = rootValues(plan);

    expect(roots.length).toBeLessThanOrEqual(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT);
    expect(roots[1]).toMatchObject({ role: "user" });
    expect(JSON.stringify(roots)).not.toContain("user-0");
    expect(JSON.stringify(roots)).toContain("assistant-219");
    expect(JSON.stringify(roots)).not.toContain("active-user");
  });

  it("retains and UTF-8-safely truncates an active trailing tool result", () => {
    const plan = buildCursorRunPlan(request({
      input: [
        { type: "message", role: "user", content: "run the tool" },
        { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output: "🧪".repeat(180_000) },
      ],
    }), "conversation-tool-result");
    const roots = rootValues(plan);
    const serializedRoots = roots.map((root) => JSON.stringify(root));

    expect(serializedRoots.join("\n")).toContain("truncated for Cursor external replay budget");
    expect(serializedRoots.join("\n")).not.toContain("�");
    expect(Buffer.byteLength(serializedRoots.join(""), "utf8")).toBeLessThanOrEqual(
      CURSOR_EXTERNAL_ROOT_BYTE_LIMIT,
    );
  });

  it("fails explicitly when the required system prompt alone exceeds the root budget", () => {
    expect(() => buildCursorRunPlan(request({
      instructions: "p".repeat(CURSOR_EXTERNAL_ROOT_BYTE_LIMIT),
    }), "conversation-system-limit")).toThrow(CursorRequestBudgetError);
  });

  it("does not prune native Composer replay roots", () => {
    const input = Array.from({ length: CURSOR_EXTERNAL_ROOT_BLOB_LIMIT + 10 }, (_, index) => ({
      type: "message" as const,
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `message-${index}`,
    }));
    input.push({ type: "message", role: "user", content: "active" });
    const plan = buildCursorRunPlan(request({ model: "composer-2.5", input }), "conversation-native");

    expect(rootValues(plan).length).toBe(CURSOR_EXTERNAL_ROOT_BLOB_LIMIT + 11);
  });

  it("forwards multimodal image parts on the active Cursor user message", () => {
    const plan = buildCursorRunPlan(request({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "이미지도 읽을수 있어?" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,aW1hZ2U=",
              detail: "auto",
            },
          ],
        },
      ],
    }), "conversation-image");
    const action = runRequest(plan).action;
    const image = action?.userMessageAction?.userMessage?.selectedContext?.selectedImages?.[0];

    expect(action?.userMessageAction?.userMessage?.text).toBe("이미지도 읽을수 있어?");
    expect(image).toMatchObject({
      mimeType: "image/png",
      path: "claude-image-1.png",
      data: "aW1hZ2U=",
    });
    expect(image?.uuid).toEqual(expect.any(String));
  });

  it("keeps prior multimodal turns text-only in Cursor roots and images on turn blobs", () => {
    const plan = buildCursorRunPlan(request({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "first" },
            {
              type: "input_image",
              image_url: "data:image/jpeg;base64,Zmlyc3Q=",
              detail: "auto",
            },
          ],
        },
        { type: "message", role: "assistant", content: "ok" },
        { type: "message", role: "user", content: "follow-up" },
      ],
    }), "conversation-image-history");
    const roots = rootValues(plan);
    const turnId = runRequest(plan).conversationState.turns[0];
    if (!turnId) throw new Error("Missing Cursor conversation turn");
    const turn = decodeBlob(plan, turnId, ConversationTurnStructureSchema) as {
      readonly agentConversationTurn?: { readonly userMessage?: string };
    };
    const userMessageId = turn.agentConversationTurn?.userMessage;
    if (!userMessageId) throw new Error("Missing Cursor user message blob");
    const encoded = plan.blobs.get(userMessageId);
    if (!encoded) throw new Error("Missing Cursor user message bytes");
    const userMessage = toJson(
      UserMessageSchema,
      fromBinary(UserMessageSchema, Buffer.from(encoded, "base64")),
    ) as {
      readonly selectedContext?: {
        readonly selectedImages?: ReadonlyArray<{ readonly mimeType?: string; readonly data?: string }>;
      };
    };

    expect(JSON.stringify(roots)).not.toContain("image_url");
    expect(roots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "first" }],
      }),
    ]));
    expect(userMessage.selectedContext?.selectedImages?.[0]).toMatchObject({
      mimeType: "image/jpeg",
      data: "Zmlyc3Q=",
    });
  });

  it("replays an Auto tool result through Cursor's native conversation-turn blobs", () => {
    const plan = buildCursorRunPlan(request({
      model: "default",
      input: [
        { type: "message", role: "user", content: "Run pwd" },
        { type: "function_call", call_id: "call-pwd", name: "exec_command", arguments: '{"cmd":"pwd"}' },
        { type: "function_call_output", call_id: "call-pwd", output: "/workspace/project\n" },
      ],
    }), "conversation-auto-result");
    const turnId = runRequest(plan).conversationState.turns[0];
    if (!turnId) throw new Error("Missing native Cursor conversation turn");
    const turn = decodeBlob(plan, turnId, ConversationTurnStructureSchema) as {
      readonly agentConversationTurn?: { readonly steps?: readonly string[] };
    };
    const stepId = turn.agentConversationTurn?.steps?.[0];
    if (!stepId) throw new Error("Missing native Cursor tool step");
    const step = decodeBlob(plan, stepId, ConversationStepSchema) as {
      readonly toolCall?: {
        readonly mcpToolCall?: {
          readonly args?: { readonly toolName?: string; readonly args?: Record<string, string> };
          readonly result?: { readonly success?: { readonly content?: unknown } };
        };
      };
    };

    expect(step).toMatchObject({
      toolCall: {
        mcpToolCall: {
          args: { toolName: "exec_command" },
          result: { success: { content: [{ text: { text: "/workspace/project\n" } }] } },
        },
      },
    });
    const encodedCommand = step.toolCall?.mcpToolCall?.args?.args?.cmd;
    expect(toJson(ValueSchema, fromBinary(ValueSchema, Buffer.from(encodedCommand!, "base64")))).toBe("pwd");
    expect(JSON.stringify(rootValues(plan))).toContain("is_error: false");
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
  readonly toolName: string;
  readonly inputSchema: string;
}

interface RunRequest {
  readonly modelDetails: {
    readonly modelId: string;
  };
  readonly conversationState: {
    readonly rootPromptMessagesJson: readonly string[];
    readonly turns: readonly string[];
  };
  readonly action?: {
    readonly userMessageAction?: {
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
}

function runRequest(plan: ReturnType<typeof buildCursorRunPlan>): RunRequest {
  return (plan.payload as { readonly runRequest: RunRequest }).runRequest;
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
