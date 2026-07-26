import { EventEmitter } from "node:events";

import type {
  AcpPermissionRequestParams,
  AcpPermissionResponse,
  IUnifiedAgentClient,
} from "@dotobokuri/core-unified-agent";
import { describe, expect, it, vi } from "vitest";

import {
  ChatSession,
  isWebToolName,
  resolveWebPermissionRequest,
  SCUTTLEBUTT_AGENT,
  SCUTTLEBUTT_SYSTEM_PROMPT,
} from "../server/chat-session.js";

describe("Scuttlebutt permission gate", () => {
  it.each([
    ["WebSearch", true],
    ["webfetch", true],
    ["mcp__claude__WebSearch", true],
    ["mcp__server__nested__WEBFETCH", true],
    ["server.WebSearch", true],
    ["server/WebFetch", true],
    ["server:WebSearch", true],
    ["Bash", false],
    ["Edit", false],
    ["Read", false],
    ["Unknown", false],
    ["SearchTheWeb", false],
  ])("classifies %s", (title, expected) => {
    expect(isWebToolName(title)).toBe(expected);
  });

  it("selects allow_once before allow_always only for web tools", () => {
    expect(resolveFor("mcp__claude__WebSearch")).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(resolveFor("Bash")).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
  });

  // 브리지가 실제로 보내는 모양 — 도구 이름이 없고 title은 검색어나 "Fetch <url>" 뿐이다.
  it("allows the web tool payloads the Claude bridge actually sends", () => {
    expect(resolveFor('"fleet console"', { query: "fleet console" }, undefined, "fetch")).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(resolveFor("Fetch https://example.com", { url: "https://example.com", prompt: "summarize" }, undefined, "fetch")).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  it("keeps the fetch kind from widening past web search and fetch", () => {
    expect(resolveFor("something else", { path: "/etc/passwd" }, undefined, "fetch")).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    expect(resolveFor("ls -la", { command: "ls -la" }, undefined, "execute")).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    expect(resolveFor("Read a file", { query: "still not a fetch" }, undefined, "read")).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
  });

  it("recognizes a qualified rawInput tool name and cancels without a matching option", () => {
    expect(resolveFor("not-a-tool", { tool_name: "server:WebFetch" })).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(resolveFor("WebSearch", {}, [])).toEqual({ outcome: { outcome: "cancelled" } });
    expect(resolveFor("Read", {}, [{ kind: "allow_once", optionId: "unsafe" }])).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });
});

describe("ChatSession", () => {
  it("connects with the frozen read-only contract and redacts every outbound text field", async () => {
    const cwd = "/private/fleet/plugins/scuttlebutt/workspace";
    const client = new FakeClient();
    const events: unknown[] = [];
    const session = new ChatSession({
      cwd,
      onEvent: (event) => events.push(event),
      buildClient: async () => client as unknown as IUnifiedAgentClient,
    });

    await session.start();
    expect(client.connect).toHaveBeenCalledWith({
      cwd,
      model: "sonnet",
      effort: "low",
      autoApprove: false,
      yoloMode: false,
      fsAccess: false,
      strictMcp: true,
      systemPrompt: SCUTTLEBUTT_SYSTEM_PROMPT,
      systemPromptMode: "replace",
      mcpServers: [],
    });

    client.emit("messageChunk", `See ${cwd}/result.md`, "provider-session");
    client.emit("toolCall", `${cwd}/WebSearch`, `${cwd}/running`, "provider-session");
    client.emit("error", new Error(`failed at ${cwd}/secret`));
    client.emit("exit", 1, cwd);
    expect(JSON.stringify(events)).not.toContain(cwd);
    expect(JSON.stringify(events)).not.toContain("provider-session");

    await session.dispose();
    expect(client.cancelPrompt).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it("defines the fixed provider contract in one server constant", () => {
    expect(SCUTTLEBUTT_AGENT).toEqual({
      cliId: "claude",
      model: "sonnet",
      effort: "low",
    });
  });

  it("preserves the RISEN system prompt structure", () => {
    expect(SCUTTLEBUTT_SYSTEM_PROMPT).toContain("# Role");
    expect(SCUTTLEBUTT_SYSTEM_PROMPT).toContain("# Instructions");
    expect(SCUTTLEBUTT_SYSTEM_PROMPT).toContain("# Steps");
    expect(SCUTTLEBUTT_SYSTEM_PROMPT).toContain("# End goal");
    expect(SCUTTLEBUTT_SYSTEM_PROMPT).toContain("# Narrowing");
  });
});

function resolveFor(
  title: string,
  rawInput: unknown = {},
  options: readonly { kind: string; optionId: string }[] = [
    { kind: "allow_always", optionId: "allow-always" },
    { kind: "allow_once", optionId: "allow-once" },
    { kind: "reject_always", optionId: "reject-always" },
    { kind: "reject_once", optionId: "reject-once" },
  ],
  kind?: string,
): AcpPermissionResponse {
  let response: AcpPermissionResponse | undefined;
  resolveWebPermissionRequest({
    options,
    toolCall: { title, rawInput, kind, toolCallId: "provider-tool-call" },
  } as AcpPermissionRequestParams, (value) => {
    response = value;
  });
  return response!;
}

class FakeClient extends EventEmitter {
  readonly connect = vi.fn(async () => ({ cli: "claude", protocol: "acp" }));
  readonly sendMessage = vi.fn(async () => ({ stopReason: "end_turn" }));
  readonly cancelPrompt = vi.fn(async () => undefined);
  readonly disconnect = vi.fn(async () => undefined);
}
