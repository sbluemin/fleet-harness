// Minimal stand-in for `agy acp`: just enough JSON-RPC to exercise the session port without a real agy.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`);
const models = (process.env.FAKE_MODELS ?? "gemini-4-argon-low,gemini-4-argon-medium,gemini-4-argon-high").split(",");
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (body) => send({ method: "session/update", params: { sessionId: "s1", update: body } });
log({ argv: process.argv.slice(2) });

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log({ method: message.method, params: message.params });
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (message.method === "session/new") {
    send({ id: message.id, result: {
      sessionId: "s1",
      models: { availableModels: models.map((modelId) => ({ modelId, name: modelId })) },
      configOptions: [
        { id: "model", type: "select", currentValue: "", options: [...new Set(models.map((id) => id.replace(/-(low|medium|high)$/, "")))].map((value) => ({ value, name: value })) },
        { id: "thought_level", type: "select", currentValue: "medium", options: ["low", "medium", "high"].map((value) => ({ value, name: value })) },
      ],
    } });
  } else if (message.method === "session/set_config_option") send({ id: message.id, result: { configOptions: [] } });
  else if (message.method === "session/prompt") {
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
