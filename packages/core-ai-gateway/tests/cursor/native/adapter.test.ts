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
} from "../../../src/index.js";
import type { AnthropicMessagesRequest, CanonicalResponseRequest } from "../../../src/index.js";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  UserMessageSchema,
} from "../../../src/cursor/native/generated/cursor-agent-protobuf.js";

describe("Cursor request budgets", () => {
  it("uses the verified Cursor tool transport version", () => {
    expect(CURSOR_CLIENT_VERSION).toBe("cli-2026.07.08-0c04a8a");
  });

  it("advertises provider-native web search to the Anthropic gateway", () => {
    expect(new CursorAdapter().capabilities.nativeTools).toEqual(["web_search"]);
  });

  it.each([
    ["grok-4.5", "low", "cursor-grok-4.5-low"],
    ["grok-4.5", "medium", "cursor-grok-4.5-medium"],
    ["grok-4.5-fast", "low", "cursor-grok-4.5-low-fast"],
    ["claude-opus-5", "xhigh", "claude-opus-5-thinking-xhigh"],
    ["claude-opus-5", "max", "claude-opus-5-thinking-max"],
    ["claude-opus-5-1m", "xhigh", "claude-opus-5-thinking-xhigh"],
    ["claude-fable-5-1m", "high", "claude-fable-5-high"],
    ["composer-2.5", "high", "composer-2.5"],
  ] as const)("writes Cursor model %s with effort %s as %s", (model, effort, expected) => {
    const plan = buildCursorRunPlan(request({
      model,
      reasoning: { summary: "auto", effort },
    }), "conversation-effort");

    expect(runRequest(plan).modelDetails.modelId).toBe(expected);
  });

  it("uses the registry default when a Cursor reasoning model has no explicit effort", () => {
    const plan = buildCursorRunPlan(request({ model: "grok-4.5" }), "conversation-default-effort");

    expect(runRequest(plan).modelDetails.modelId).toBe("cursor-grok-4.5-high");
  });

  it("keeps supported Cursor catalog models out of Max Mode unless explicitly enabled", () => {
    const plan = buildCursorRunPlan(request({ model: "grok-4.5" }), "conversation-grok-standard");

    expect(encodedRunRequest(plan).modelDetails).toMatchObject({ modelId: "cursor-grok-4.5-high" });
    expect(encodedRunRequest(plan).modelDetails).not.toHaveProperty("maxMode");
  });

  it.each([
    ["claude-opus-5-1m", "high", "claude-opus-5-high"],
    ["claude-fable-5-1m", "high", "claude-fable-5-high"],
  ] as const)("encodes Cursor Max Mode for catalog model %s", (model, effort, wireModel) => {
    const plan = buildCursorRunPlan(request({
      model,
      reasoning: { summary: "auto", effort },
    }), `conversation-${model}`);

    expect(encodedRunRequest(plan).modelDetails).toMatchObject({
      modelId: wireModel,
      maxMode: true,
    });
  });

  it("encodes Cursor Max Mode when explicitly enabled", () => {
    const plan = buildCursorRunPlan(request(), "conversation-max-mode", { maxMode: true });

    expect(encodedRunRequest(plan).modelDetails.maxMode).toBe(true);
  });

  it("omits Cursor Max Mode by default", () => {
    const plan = buildCursorRunPlan(request(), "conversation-default-mode");

    expect(runRequest(plan).modelDetails).not.toHaveProperty("maxMode");
    expect(encodedRunRequest(plan).modelDetails).not.toHaveProperty("maxMode");
  });

  it("omits Cursor Max Mode when explicitly disabled", () => {
    const deterministicRequest = request({ input: [] });
    const defaultPlan = buildCursorRunPlan(deterministicRequest, "conversation-standard-mode");
    const disabledPlan = buildCursorRunPlan(
      deterministicRequest,
      "conversation-standard-mode",
      { maxMode: false },
    );

    expect(runRequest(disabledPlan).modelDetails).not.toHaveProperty("maxMode");
    expect(encodedRunRequest(disabledPlan).modelDetails).not.toHaveProperty("maxMode");
    expect(encodeRunPlan(disabledPlan)).toEqual(encodeRunPlan(defaultPlan));
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
    expect(systemText(plan)).not.toContain("available tool names are exactly");
    expect(systemText(plan)).not.toContain("including every required field");
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

  it("keeps gateway tool policy out of the replayed system root", () => {
    const plan = buildCursorRunPlan(request({
      tools: [tool("Bash"), tool("Edit"), tool("Read"), tool("Write")],
    }), "conversation-tool-discipline");

    expect(systemText(plan)).toBe("You are a helpful assistant.");
  });

  it("repeats the tool discipline as an always-applied rule on every turn", () => {
    const toolTurn = request({
      tools: [tool("Bash"), tool("Read"), tool("Grep")],
      input: [
        { type: "message", role: "user", content: "Run pwd" },
        { type: "function_call", call_id: "call-pwd", name: "Bash", arguments: '{"cmd":"pwd"}' },
        { type: "function_call_output", call_id: "call-pwd", output: "/repo" },
      ],
    });
    // A tool continuation resumes rather than sending a message, so the rule has to ride the
    // request context of both actions to reach the model on the turn it picks the next tool.
    const prompt = encodedRunRequest(buildCursorRunPlan(request({
      tools: [tool("Bash"), tool("Read"), tool("Grep")],
    }), "conversation-rules-prompt"));
    const resume = encodedRunRequest(buildCursorRunPlan(toolTurn, "conversation-rules-resume"));

    for (const context of [prompt.action?.userMessageAction?.requestContext, resume.action?.resumeAction?.requestContext]) {
      const rule = context?.rules?.[0];
      expect(rule?.content).toContain("Native search, shell requests are routed through the caller's tools and permissions");
      expect(rule?.content).not.toContain("Native read requests are routed through the caller's tools");
      expect(rule?.content).not.toContain("cannot preserve partial-file metadata");
      expect(rule?.content).toContain("Native mutation, fetch");
      expect(rule?.content).not.toContain("Do not invoke Cursor-native tools");
      expect(rule?.type?.global).toBeDefined();
      expect(rule?.fullPath).toContain(CURSOR_TOOL_PROVIDER_IDENTIFIER);
    }
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

  it("sends a no-tools rule when no client tool is advertised", () => {
    // Claude Code title-generation turns hit the gateway with tools:[] but still embed the user
    // prompt. Without a rule, Cursor only sees its native catalog and every exec is rejected.
    const plan = buildCursorRunPlan(request(), "conversation-no-tools");
    const encoded = encodedRunRequest(plan);
    const rules = encoded.action?.userMessageAction?.requestContext?.rules;

    expect(rules).toHaveLength(1);
    expect(rules?.[0]?.content).toContain("No tool is available on this turn");
    expect(rules?.[0]?.content).toContain("answer in plain text");
    expect(systemText(plan)).toBe("You are a helpful assistant.");
  });

  it("isolates PascalCase Claude tools from Cursor's native tool namespace", () => {
    const plan = buildCursorRunPlan(request({
      tools: [tool("Read"), tool("read_file")],
    }), "conversation-tool-alias");
    const wireTools = runRequest(plan).mcpTools?.mcpTools ?? [];

    expect(wireTools.map((entry) => entry.toolName)).toEqual([
      expect.stringMatching(/^cc_read_[a-f0-9]{8}$/),
      "read_file",
    ]);
    expect(plan.redirectTools.find((tool) => tool.clientName === "Read")?.toolName)
      .toMatch(/^cc_read_[a-f0-9]{8}$/);
  });

  it("advertises Read directly without routing it as native, while routing Grep and Bash", () => {
    const plan = buildCursorRunPlan(request({
      tools: [tool("Read"), tool("Grep"), tool("Bash")],
    }), "conversation-guidance-eligibility");
    const names = runRequest(plan).mcpTools?.mcpTools.map((entry) => entry.toolName) ?? [];
    const guidance = encodedRunRequest(plan).action?.userMessageAction?.requestContext?.rules?.[0]?.content ?? "";

    expect(names).toContain(plan.redirectTools.find((tool) => tool.clientName === "Read")?.toolName);
    expect(names).not.toContain(plan.redirectTools.find((tool) => tool.clientName === "Grep")?.toolName);
    expect(names).not.toContain(plan.redirectTools.find((tool) => tool.clientName === "Bash")?.toolName);
    expect(guidance).not.toContain("Native read requests are routed");
    expect(guidance).toContain("Native search, shell requests are routed");
  });

  it("loads only ToolSearch-selected deferred tools into the next Cursor catalog", () => {
    const tools = [
      tool("ToolSearch"),
      tool("Read"),
      { ...tool("mcp__fleet__wiki_read"), defer_loading: true },
      { ...tool("mcp__fleet__wiki_orient"), defer_loading: true },
      { ...tool("mcp__fleet__wiki_resolve"), defer_loading: true },
    ];
    const initialPlan = buildCursorRunPlan(request({ tools }), "conversation-tool-search-initial");
    const initialNames = runRequest(initialPlan).mcpTools?.mcpTools.map((entry) => entry.toolName) ?? [];
    const toolSearchWireName = initialNames.find((name) => name.startsWith("cc_tool_search_"));

    expect(toolSearchWireName).toMatch(/^cc_tool_search_[a-f0-9]{8}$/);
    expect(initialNames).toHaveLength(2);
    expect(initialNames.some((name) => name.startsWith("cc_read_"))).toBe(true);
    expect(initialNames).not.toContain("mcp__fleet__wiki_read");
    const initialRule = encodedRunRequest(initialPlan).action?.userMessageAction?.requestContext?.rules?.[0]?.content;
    expect(initialRule).toContain(`Use \`${toolSearchWireName}\` for deferred tools.`);
    expect(systemText(initialPlan)).not.toContain(toolSearchWireName);

    const continuationPlan = buildCursorRunPlan(request({
      tools,
      input: [
        { type: "message", role: "user", content: "Use fleet wiki_read." },
        {
          type: "function_call",
          call_id: "call-tool-search",
          name: "ToolSearch",
          arguments: '{"query":"select:mcp__fleet__wiki_read,mcp__fleet__wiki_orient"}',
        },
        {
          type: "function_call_output",
          call_id: "call-tool-search",
          output: "selected",
          tool_references: [
            "mcp__fleet__wiki_read",
            "mcp__fleet__wiki_orient",
          ],
        },
      ],
    }), "conversation-tool-search-continuation");
    const continuationNames = runRequest(continuationPlan).mcpTools?.mcpTools
      .map((entry) => entry.toolName) ?? [];

    expect(continuationNames).toEqual(expect.arrayContaining([
      toolSearchWireName,
      "mcp__fleet__wiki_read",
      "mcp__fleet__wiki_orient",
    ]));
    expect(continuationNames).not.toContain("mcp__fleet__wiki_resolve");
  });

  it("keeps native redirect schemas local instead of forcing duplicates onto the wire", () => {
    const tools = [
      tool("ToolSearch"),
      { ...tool("Read"), defer_loading: true },
      { ...tool("Bash"), defer_loading: true },
      { ...tool("Grep"), defer_loading: true },
      { ...tool("mcp__fleet__wiki_read"), defer_loading: true },
    ];
    const plan = buildCursorRunPlan(request({ tools }), "conversation-hot-path-local");
    const names = runRequest(plan).mcpTools?.mcpTools.map((entry) => entry.toolName) ?? [];

    expect(names.some((name) => name.startsWith("cc_tool_search_"))).toBe(true);
    expect(names.some((name) => name.startsWith("cc_read_"))).toBe(false);
    expect(names.some((name) => name.startsWith("cc_bash_"))).toBe(false);
    expect(names.some((name) => name.startsWith("cc_grep_"))).toBe(false);
    expect(names).not.toContain("mcp__fleet__wiki_read");
    expect(plan.redirectTools.map((tool) => tool.clientName)).toEqual(expect.arrayContaining([
      "ToolSearch",
      "Read",
      "Bash",
      "Grep",
    ]));
  });

  it("keeps an explicitly selected caller Read on the wire", () => {
    const plan = buildCursorRunPlan(request({
      tools: [tool("Read"), tool("Grep")],
      tool_choice: { type: "function", name: "Read" },
    }), "conversation-explicit-redirect-tool");
    const names = runRequest(plan).mcpTools?.mcpTools.map((entry) => entry.toolName) ?? [];

    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^cc_read_[a-f0-9]{8}$/);
    expect(plan.redirectTools.map((tool) => tool.clientName)).toEqual(["Read", "Grep"]);
  });

  it("keeps deferred tools eager when the client did not advertise ToolSearch", () => {
    const plan = buildCursorRunPlan(request({
      tools: [{ ...tool("mcp__fleet__wiki_read"), defer_loading: true }],
    }), "conversation-no-tool-search");

    expect(runRequest(plan).mcpTools?.mcpTools.map((entry) => entry.toolName)).toEqual([
      "mcp__fleet__wiki_read",
    ]);
  });

  it("reports only the tools Cursor actually puts on the wire", () => {
    const canonical = request({
      tools: [
        tool("ToolSearch"),
        tool("Read"),
        { ...tool("mcp__fleet__wiki_read"), defer_loading: true },
        { ...tool("mcp__fleet__wiki_orient"), defer_loading: true },
      ],
    });
    const plan = buildCursorRunPlan(canonical, "conversation-wire-tools");

    // The pre-flight sizing view must agree with the payload, not the declaration.
    expect(new CursorAdapter().wireTools(canonical).map((entry) => entry.name)).toEqual([
      "ToolSearch",
      "Read",
    ]);
    expect(runRequest(plan).mcpTools?.mcpTools).toHaveLength(2);
  });

  it("reports the capped survivors when the declared catalog overruns the byte budget", () => {
    const canonical = request({
      tools: [
        tool("ToolSearch"),
        ...Array.from(
          { length: 40 },
          (_, index) => tool(`mcp__bulk__tool_${index}`, "d".repeat(8_000)),
        ),
      ],
    });

    const reported = new CursorAdapter().wireTools(canonical);
    const wire = runRequest(buildCursorRunPlan(canonical, "conversation-wire-cap"))
      .mcpTools?.mcpTools ?? [];

    expect(reported.length).toBeLessThan(41);
    expect(reported).toHaveLength(wire.length);
  });

  it("defers a tool-budget rejection to the streaming path instead of pre-flight sizing", () => {
    const canonical = request({
      // The selected tool alone overruns the byte budget, so no catalog can carry it.
      tools: [tool("mcp__bulk__oversized", "d".repeat(CURSOR_TOOL_BYTES_LIMIT + 1))],
      tool_choice: { type: "function", name: "mcp__bulk__oversized" },
    });

    expect(() => buildCursorRunPlan(canonical, "conversation-wire-throw"))
      .toThrow(CursorRequestBudgetError);
    expect(new CursorAdapter().wireTools(canonical)).toEqual([]);
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
    expect(names).not.toContain("exec_command");
    expect(plan.redirectTools.some((tool) => tool.clientName === "exec_command")).toBe(true);
    expect(names).toEqual(expect.arrayContaining([
      "apply_patch",
      "mcp__selected__chosen",
      "tool_search",
    ]));
    expect(systemText(plan)).toContain("Cursor transport limits expose 330 of 353 tools");
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

  // Replay size carries no gateway ceiling. A local 512 KiB / 192-root cap used to
  // refuse these, which cut sessions off near 48% of the model's window; measuring
  // against Cursor on 2026-08-05 saw 857,987 bytes across 117 roots accepted without
  // a refusal, so the model's context window is the only limit left.
  it("keeps every external replay root instead of capping the conversation", () => {
    const input: CanonicalResponseRequest["input"] = [];
    for (let index = 0; index < 220; index += 1) {
      input.push({ type: "message", role: "user", content: `user-${index}` });
      input.push({ type: "message", role: "assistant", content: `assistant-${index}` });
    }
    input.push({ type: "message", role: "user", content: "active-user" });
    const plan = buildCursorRunPlan(request({ input }), "conversation-roots");

    // 440 history roots plus the system root; the active message replays next turn.
    expect(rootValues(plan).length).toBe(441);
    expect(plan.replayRootCount).toBe(442);
    expect(plan.replayBytes).toBeGreaterThan(0);
  });

  it("carries an oversized trailing tool result instead of truncating it", () => {
    const output = "🧪".repeat(180_000);
    const plan = buildCursorRunPlan(request({
      input: [
        { type: "message", role: "user", content: "run the tool" },
        { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output },
      ],
    }), "conversation-tool-result");

    expect(plan.replayBytes).toBeGreaterThan(Buffer.byteLength(output, "utf8"));
  });

  it("carries a system prompt of any size", () => {
    const instructions = "p".repeat(600_000);
    const plan = buildCursorRunPlan(request({ instructions }), "conversation-system-limit");

    expect(systemText(plan)).toContain(instructions);
  });

  it("does not prune native Composer replay roots", () => {
    const input = Array.from({ length: 202 }, (_, index) => ({
      type: "message" as const,
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `message-${index}`,
    }));
    input.push({ type: "message", role: "user", content: "active" });
    const plan = buildCursorRunPlan(request({ model: "composer-2.5", input }), "conversation-native");

    expect(rootValues(plan).length).toBe(203);
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
        {
          type: "function_call_output",
          call_id: "call-pwd",
          output: "/workspace/project\n",
          is_error: true,
        },
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
          result: {
            success: {
              content: [{ text: { text: "/workspace/project\n" } }],
              isError: true,
            },
          },
        },
      },
    });
    const encodedCommand = step.toolCall?.mcpToolCall?.args?.args?.cmd;
    expect(toJson(ValueSchema, fromBinary(ValueSchema, Buffer.from(encodedCommand!, "base64")))).toBe("pwd");
    expect(JSON.stringify(rootValues(plan))).toContain("is_error: true");
  });

  it("replays an external-model tool result through the same structured tool step", () => {
    const plan = buildCursorRunPlan(request({
      model: "grok-4.5",
      input: [
        { type: "message", role: "user", content: "Run pwd" },
        { type: "function_call", call_id: "call-pwd", name: "exec_command", arguments: '{"cmd":"pwd"}' },
        { type: "function_call_output", call_id: "call-pwd", output: "/workspace/project\n" },
      ],
    }), "conversation-external-result");
    const turns = runRequest(plan).conversationState.turns.map((turnId) => (
      decodeBlob(plan, turnId, ConversationTurnStructureSchema)
    )) as Array<{
      readonly agentConversationTurn?: { readonly steps?: readonly string[] };
    }>;
    const stepId = turns[0]?.agentConversationTurn?.steps?.[0];
    if (!stepId) throw new Error("Missing external-model Cursor tool step");
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
    const turnSteps = turns.flatMap((turn) => turn.agentConversationTurn?.steps ?? [])
      .map((id) => decodeBlob(plan, id, ConversationStepSchema));
    expect(JSON.stringify(turnSteps)).not.toContain("[Tool Result]");
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
