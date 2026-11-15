// Minimal stand-in for `agy acp`: just enough JSON-RPC to exercise the session port and the Messages bridge without a real agy.
//
// Prompt scripts (the prompt text decides what the fake "model" does):
//   TOOL:<name>:<json>     ask permission for `Run mcp_fleet_<name>`, call that MCP tool, then answer `got:<result text>`
//   TIMEOUT:<name>         call the MCP tool and give up on it after 50ms (agy's call deadline), then keep talking
//   UPSTREAM429            agy's upstream-error retry notices as ordinary message chunks, then a normal-looking answer
//   UPSTREAMNET            a code-less "⚠ network issue" message as the whole turn, ended normally (agy's network-error shape)
//   BUILTIN                ask permission for a built-in tool and run it anyway
//   anything else          answer `echo:<first 60 chars>` plus `history:yes|no` (whether a conversation_history block came)
// Without any of those the original fixed event stream is sent (the session port test relies on it).
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
const models = (process.env.FAKE_MODELS ?? "gemini-4-argon-low,gemini-4-argon-medium,gemini-4-argon-high").split(",");
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (body) => send({ method: "session/update", params: { sessionId: "s1", update: body } });
const argv = process.argv.slice(2);
log({ argv });
process.on("SIGTERM", () => { log({ terminated: true }); process.exit(0); });

const geminiDir = argv[argv.indexOf("--gemini-dir") + 1];
let mcp;
let nextMcpId = 0;
const outgoing = new Map();
let nextRequestId = 1000;

async function mcpRpc(method, params, signal) {
  const id = ++nextMcpId;
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...mcp.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal,
  });
  const body = await response.json();
  // A real MCP client matches the reply to its request by the exact JSON-RPC id (number stays number).
  if (body.id !== id) throw new Error(`JSON-RPC id mismatch: sent ${JSON.stringify(id)}, got ${JSON.stringify(body.id)}`);
  return body.result;
}

async function connectMcp() {
  let config;
  try { config = JSON.parse(readFileSync(`${geminiDir}/config/mcp_config.json`, "utf8")).mcpServers.fleet; } catch { return; }
  mcp = { url: config.url, headers: config.headers };
  await mcpRpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  const listed = await mcpRpc("tools/list", {});
  log({ mcpTools: listed.tools.map((tool) => tool.name), eager: Object.keys(config.tools ?? {}), timeoutSeconds: config.timeoutSeconds });
}

function request(method, params) {
  const id = ++nextRequestId;
  send({ id, method, params });
  return new Promise((resolve) => outgoing.set(id, resolve));
}

const promptText = (blocks) => blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

async function callTool(title, name, args, giveUpAfterMs) {
  const permission = await request("session/request_permission", {
    sessionId: "s1",
    toolCall: { toolCallId: "tc", title },
    options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }, { optionId: "deny", kind: "reject_once", name: "Deny" }],
  });
  log({ permission: title, outcome: permission?.outcome });
  if (permission?.outcome?.optionId !== "allow") return undefined;
  update({ sessionUpdate: "tool_call", toolCallId: "tc", title, kind: "other", status: "in_progress", rawInput: args });
  const controller = new AbortController();
  if (giveUpAfterMs !== undefined) setTimeout(() => controller.abort(), giveUpAfterMs);
  try {
    // agy adds a `toolSummary` argument to every MCP call.
    const result = await mcpRpc("tools/call", { name, arguments: { ...args, toolSummary: "fake" } }, controller.signal);
    update({ sessionUpdate: "tool_call_update", toolCallId: "tc", status: result.isError ? "failed" : "completed" });
    return result;
  } catch {
    update({ sessionUpdate: "tool_call_update", toolCallId: "tc", status: "failed" });
    return undefined;
  }
}

async function runPrompt(id, blocks) {
  const text = promptText(blocks);
  log({ prompt: text });
  let match;
  if ((match = /^TOOL:([^:]+):(.*)$/s.exec(text))) {
    const result = await callTool(`Run mcp_fleet_${match[1]}`, match[1], JSON.parse(match[2]));
    update({ sessionUpdate: "usage_update", used: 1500, size: 1048576 });
    say(`got:${result?.content?.map((block) => block.text).join("") ?? "none"}`);
  } else if ((match = /^TIMEOUT:(.+)$/s.exec(text))) {
    await callTool(`Run mcp_fleet_${match[1]}`, match[1], {}, 50);
    say("timed out after 3 minutes");
  } else if (text.startsWith("UPSTREAM429")) {
    say("\n⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    say("\n⚠ API error (attempt 2): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n");
    say("NOT-A-REAL-ANSWER");
  } else if (text.startsWith("UPSTREAMNET")) {
    say("\n⚠ There was a network issue connecting to the server, please try again.\n");
    if (text === "UPSTREAMNET:slow") await new Promise((resolve) => setTimeout(resolve, 2600));
  } else if (text.startsWith("BUILTIN")) {
    await callTool("Run run_command", "run_command", {});
    update({ sessionUpdate: "tool_call", toolCallId: "tb", title: "Run run_command", kind: "other", status: "in_progress", rawInput: {} });
    say("ran a shell command");
  } else if (process.env.FAKE_BRIDGE === "1") {
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering" } });
    update({ sessionUpdate: "usage_update", used: 1700, size: 1048576 });
    say(`echo:${text.slice(0, 60)} history:${text.includes("<conversation_history>") ? "yes" : "no"}`);
  } else {
    return false;
  }
  send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, thoughtTokens: 5, cachedReadTokens: 0, totalTokens: 125 } } });
  return true;
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && outgoing.has(message.id)) {
    outgoing.get(message.id)(message.result);
    outgoing.delete(message.id);
    return;
  }
  log({ method: message.method, params: message.params });
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (message.method === "session/new") {
    await connectMcp();
    send({ id: message.id, result: {
      sessionId: "s1",
      models: { availableModels: models.map((modelId) => ({ modelId, name: modelId })) },
      configOptions: [
        { id: "model", type: "select", currentValue: "", options: [...new Set(models.map((id) => id.replace(/-(low|medium|high)$/, "")))].map((value) => ({ value, name: value })) },
        { id: "thought_level", type: "select", currentValue: "medium", options: ["low", "medium", "high"].map((value) => ({ value, name: value })) },
      ],
    } });
  } else if (message.method === "session/set_config_option") send({ id: message.id, result: { configOptions: [] } });
  else if (message.method === "session/cancel") log({ cancelled: true });
  else if (message.method === "session/prompt") {
    if (await runPrompt(message.id, message.params.prompt)) return;
    update({ sessionUpdate: "available_commands_update", availableCommands: [] });
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "mcp_fleet_ping", kind: "other", status: "in_progress", rawInput: { a: 1 } });
    update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hel" } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    update({ sessionUpdate: "usage_update", used: 42, size: 1048576 });
    send({ id: message.id, result: { stopReason: "end_turn" } });
  }
});
