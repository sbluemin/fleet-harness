import { describe, expect, it, vi } from "vitest";
import type { AgentHost, AgentSessionOptions } from "@fleet-console/sdk/agent";
import { createCoworkGatewayConnector } from "../server/codex/cowork/gateway-adapter.js";

describe("Cowork Console Agent integration", () => {
  it("requests isolated turns and scoped tools, maps terminal failures, and disposes the execution", async () => {
    let options!: AgentSessionOptions;
    const dispose = vi.fn(async () => undefined);
    const agent: AgentHost = { createSession: async input => {
      options = input;
      return { send: async () => undefined, cancel: () => input.onEvent?.({ kind: "cancelled" }), dispose };
    } };
    const tools = [{ name: "cowork", tools: [{ name: "wiki_draft_read", description: "Read the scoped draft", inputSchema: { type: "object" }, execute: async () => ({ content: [] }) }] }];
    const client = await createCoworkGatewayConnector({ agent }).connect({ systemPrompt: "Wiki editor", tools });
    expect(options).toMatchObject({ continuation: "oneshot", settlement: "result-required", timeoutMs: 600000, tools: { builtins: [], custom: tools } });
    const text = vi.fn(); const complete = vi.fn(); const error = vi.fn();
    client.on("messageChunk", text); client.on("promptComplete", complete); client.on("error", error);
    options.onEvent?.({ kind: "thinking", text: "private thought" });
    options.onEvent?.({ kind: "text", text: "draft" });
    options.onEvent?.({ kind: "result", isError: false, source: "message" });
    expect(text).toHaveBeenCalledExactlyOnceWith("draft");
    expect(complete).toHaveBeenCalledOnce();
    options.onEvent?.({ kind: "result", isError: true, source: "watchdog" });
    expect(error).toHaveBeenCalledWith({ message: "cowork_turn_timeout" });
    await client.cancelPrompt();
    options.onEvent?.({ kind: "result", isError: false, source: "message" });
    expect(complete).toHaveBeenCalledOnce();
    await client.disconnect();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
