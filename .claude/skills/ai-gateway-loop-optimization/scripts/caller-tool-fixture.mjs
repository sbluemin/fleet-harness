#!/usr/bin/env node
// Scripted Anthropic Messages endpoint: answers every main-loop turn with the next tool_use from a
// steps file, so a real Claude Code process runs its own tools without a model or credentials.
// Usage: node caller-tool-fixture.mjs --steps <steps.json> --port-file <path> [--log <path>]
// steps.json: [{ "name": "Grep", "input": { ... } }, ...]. The log records request shape only
// (path, tool names, result count), never prompts or tool output.
import fs from "node:fs";
import http from "node:http";

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const stepsPath = option("--steps");
const portFile = option("--port-file");
const logPath = option("--log");
if (!stepsPath || !portFile) {
  console.error("usage: caller-tool-fixture.mjs --steps <steps.json> --port-file <path> [--log <path>]");
  process.exit(2);
}
const steps = JSON.parse(fs.readFileSync(stepsPath, "utf8"));
const log = (entry) => { if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`); };

function streamMessage(res, block, stopReason) {
  const events = [
    ["message_start", { message: { id: `msg_fixture_${Date.now()}`, type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ["content_block_start", { index: 0, content_block: block.type === "text" ? { type: "text", text: "" } : { type: "tool_use", id: block.id, name: block.name, input: {} } }],
    ["content_block_delta", { index: 0, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", {}],
  ];
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const url = (req.url ?? "").split("?")[0];
    if (url.endsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"input_tokens":10}');
      return;
    }
    if (!url.endsWith("/v1/messages")) {
      log({ url, kind: "other" });
      res.writeHead(404);
      res.end("{}");
      return;
    }
    let request = {};
    try { request = JSON.parse(body); } catch { /* answered as an auxiliary turn */ }
    const toolNames = (request.tools ?? []).map((tool) => tool.name).filter((name) => !name.startsWith("mcp__"));
    // Auxiliary turns (titles, suggestions) carry no tool catalog and get a plain answer.
    const mainLoop = toolNames.length > 0;
    const results = (request.messages ?? []).flatMap((message) => (
      Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_result") : []
    ));
    log({ url, mainLoop, toolNames, resultCount: results.length });
    const step = mainLoop ? steps[results.length] : undefined;
    if (step === undefined) {
      streamMessage(res, { type: "text", text: mainLoop ? "done" : "ok" }, "end_turn");
      return;
    }
    streamMessage(res, {
      type: "tool_use",
      id: `toolu_fixture${String(results.length).padStart(3, "0")}`,
      name: step.name,
      input: step.input,
    }, "tool_use");
  });
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
