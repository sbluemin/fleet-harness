import { describe, expect, it, vi } from "vitest";
import type { AgentHost, AgentSessionOptions } from "@fleet-console/sdk/agent";
import { ChatSession, toChatEvents, type ChatEvent } from "../server/chat-session.js";

describe("Scuttlebutt Console Agent integration", () => {
  it("requests only web tools, preserves the conversation, and maps completion and cancellation", async () => {
    let options!: AgentSessionOptions;
    const dispose = vi.fn(async () => undefined);
    const agent: AgentHost = { createSession: async (input) => {
      options = input;
      return {
        send: async () => { input.onEvent?.({ kind: "text", text: "Answer" }); input.onEvent?.({ kind: "result", isError: false, source: "message" }); },
        cancel: () => input.onEvent?.({ kind: "cancelled" }),
        dispose,
      };
    } };
    const events: ChatEvent[] = [];
    const session = new ChatSession({ agent, admiral: "tori", onEvent: event => events.push(event) });
    await session.start();
    expect(options.tools).toEqual({ builtins: ["WebSearch", "WebFetch"] });
    expect(options.continuation).toBe("conversation");
    await session.send("hello");
    session.cancel();
    expect(events).toEqual([{ type: "chunk", text: "Answer" }, { type: "complete" }, { type: "cancelled" }]);
    await session.dispose();
    await session.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    const operational = new ChatSession({ agent, admiral: "bori", consoleUse: { custom: [], consoleUse: { tools: ["console_launch"], allowControl: true }, promptAddendum: "Console execution enabled" } });
    await operational.start();
    expect(options.tools).toMatchObject({ builtins: ["WebSearch", "WebFetch"], consoleUse: { tools: ["console_launch"], allowControl: true } });
    expect(toChatEvents({ kind: "tool-start", name: "mcp__fleet-console-use__console_launch", input: { prompt: "/private/project task", text: "/private/project task" } }, value => value)).toEqual([{ type: "tool", title: "mcp__fleet-console-use__console_launch", status: "running" }]);
    await operational.dispose();
  });
});
