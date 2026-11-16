// Minimal stand-in for `agy acp`: just enough JSON-RPC to exercise the session port and the Messages bridge without a real agy.
//
// Prompt scripts (the prompt text decides what the fake "model" does):
//   TOOL:<name>:<json>     ask permission for `Run mcp_fleet_<name>`, call that MCP tool, then answer `got:<result text>`
//   TIMEOUT:<name>         call the MCP tool and give up on it when the client sends session/cancel (stands in for agy's call deadline),
//                          then keep talking
//   UPSTREAM429            agy's upstream-error retry notice as an ordinary message chunk; the turn then stays open (agy keeps retrying)
//                          until the client cancels it, and only then a normal-looking answer comes
//   UPSTREAMNET            a code-less "⚠ network issue" message as the whole turn, ended normally (agy's network-error shape)
// A second session/prompt while a TOOL prompt is blocked on its MCP call is steering (agy 1.5.9): the first prompt is answered end_turn at
// once, and when the tool result comes the turn continues as `got:<result> steered:<text>` and ends with the steering prompt's response.
//   ENDEARLY:<name>        call the MCP tool, then end the prompt when the client sends session/cancel while the call stays held
//                          (a turn that is over but whose call is still pending)
//   BUILTIN                ask permission for a built-in tool and run it anyway
//   anything else          answer `echo:<first 60 chars>` plus `history:yes|no` (whether a conversation_history block came)
// Without any of those the original fixed event stream is sent (the session port test relies on it).
// The fake never waits on a clock: every step that a real agy would take after some time follows a message from the client instead.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
const models = (process.env.FAKE_MODELS ?? "gemini-4-argon-low,gemini-4-argon-medium,gemini-4-argon-high").split(",");
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (body) => send({ method: "session/update", params: { sessionId: "s1", update: body } });
const argv = process.argv.slice(2);
log({ argv, pid: process.pid });

const geminiDir = argv[argv.indexOf("--gemini-dir") + 1];
let mcp;
let listedTools = [];
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
  // The session-port tests point at an address nothing listens on: a failed connect is logged, not fatal.
  try { await mcpRpc("initialize", { protocolVersion: "2025-11-25", capabilities: {} }); } catch (error) { log({ mcpUnreachable: String(error) }); return; }
  const listed = await mcpRpc("tools/list", {});
  listedTools = listed.tools.map((tool) => tool.name);
  log({ mcpTools: listedTools, mcpSchemas: listed.tools.map((tool) => tool.inputSchema), eager: Object.keys(config.tools ?? {}), timeoutSeconds: config.timeoutSeconds });
}

function request(method, params) {
  const id = ++nextRequestId;
  send({ id, method, params });
  return new Promise((resolve) => outgoing.set(id, resolve));
}

const promptText = (blocks) => blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

// Resolves on the client's next session/cancel.
let onCancel;
const nextCancel = () => new Promise((resolve) => { onCancel = resolve; });

async function callTool(title, name, args, giveUp) {
  const permission = await request("session/request_permission", {
    sessionId: "s1",
    toolCall: { toolCallId: "tc", title },
    options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }, { optionId: "deny", kind: "reject_once", name: "Deny" }],
  });
  log({ permission: title, outcome: permission?.outcome });
  if (permission?.outcome?.optionId !== "allow") return undefined;
  update({ sessionUpdate: "tool_call", toolCallId: "tc", title, kind: "other", status: "in_progress", rawInput: args });
  const controller = new AbortController();
  void giveUp?.then(() => controller.abort());
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

let running; // the TOOL prompt blocked on its MCP call: { id, steerId?, steerText? }

async function runPrompt(id, blocks) {
  const text = promptText(blocks);
  log({ prompt: text });
  let match;
  if ((match = /^TOOL:([^:]+):(.*)$/s.exec(text))) {
    running = { id };
    const result = await callTool(`Run mcp_fleet_${match[1]}`, match[1], JSON.parse(match[2]));
    update({ sessionUpdate: "usage_update", used: 1500, size: 1048576 });
    log({ resultBlocks: result?.content?.map((block) => block.type) });
    say(`got:${result?.content?.map((block) => block.text).join("") ?? "none"}`);
    const steer = running;
    running = undefined;
    if (steer.steerId !== undefined) {
      say(` steered:${steer.steerText}`);
      send({ id: steer.steerId, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, thoughtTokens: 5, cachedReadTokens: 0, totalTokens: 125 } } });
      return true;
    }
  } else if ((match = /^ENDEARLY:(.+)$/s.exec(text))) {
    const cancelled = nextCancel();
    void callTool(`Run mcp_fleet_${match[1]}`, match[1], {});
    await cancelled;
    log({ endedEarly: true });
  } else if ((match = /^TIMEOUT:(.+)$/s.exec(text))) {
    await callTool(`Run mcp_fleet_${match[1]}`, match[1], {}, nextCancel());
    say("timed out after 3 minutes");
  } else if (text.startsWith("UPSTREAM429")) {
    const cancelled = nextCancel();
    say("\n⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n");
    await cancelled;
    say("NOT-A-REAL-ANSWER");
  } else if (text.startsWith("UPSTREAMNET")) {
    say("\n⚠ There was a network issue connecting to the server, please try again.\n");
  } else if ((match = /^USAGE:(\d+)/s.exec(text))) {
    const used = Number(match[1]);
    update({ sessionUpdate: "usage_update", used, size: 1048576 });
    say(`usage:${used}`);
  } else if (text.includes("Create a detailed plaintext handoff summary")) {
    if (text.includes("FORCE_COMPACT_TOOL")) {
      await callTool("Run run_command", "run_command", {});
      update({ sessionUpdate: "tool_call", toolCallId: "tb", title: "Run run_command", kind: "other", status: "in_progress", rawInput: {} });
      say("should-have-failed");
    } else if (listedTools.length > 0) {
      // Reproduces the real agy failure when tools stay exposed on compaction: calls a tool with no text.
      await callTool(`Run mcp_fleet_${listedTools[0]}`, listedTools[0], {});
    } else {
      update({ sessionUpdate: "usage_update", used: 320, size: 1048576 });
      say(`Compacted summary (${listedTools.length} tools) history:${text.includes("<conversation_history>") ? "yes" : "no"}`);
    }
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
  else if (message.method === "session/cancel") {
    log({ cancelled: true });
    const resolve = onCancel;
    onCancel = undefined;
    resolve?.();
  }
  else if (message.method === "session/prompt" && running) {
    running.steerText = promptText(message.params.prompt);
    running.steerId = message.id;
    log({ steering: running.steerText, steerImages: message.params.prompt.filter((block) => block.type === "image").length });
    send({ id: running.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1, thoughtTokens: 0, cachedReadTokens: 0, totalTokens: 11 } } });
  } else if (message.method === "session/prompt") {
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
