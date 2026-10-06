#!/usr/bin/env node
// Credential-free stand-in for the Claude Code CLI, used as CLAUDE_BIN in an isolated Console.
// No model, no network. See ../references/setup.md#no-cost-fake-claude.
//
// FAKE_CLAUDE_DIR (required): owned control directory for this run.
//   log.jsonl        one line per launch, control request, turn and exit (flag names and selected values only)
//   mcp/<pid>.json   the --mcp-config this launch received (local bearer tokens; mode 0600, never print)
//   ctx              optional context-token count reported to chat (default 1000)
//   fail_set_model   if present, set_model answers with an error
//   release          a chat message containing "SLOW" keeps its turn open until this file appears (max 120 s)
//   wake             optional JSON with wake options (kind: "peer"|"task", taskId, silenceMs, thinking, first, retry, error: "synthetic"|"result-only")
// FAKE_CLAUDE_VERSION (optional): the --version answer (default "2.1.999 (Claude Code)").
//
// Modes: `--version`; chat/SDK when `--input-format stream-json`; otherwise an interactive terminal
// that prints a banner and echoes input until SIGTERM/SIGHUP.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION || "2.1.999 (Claude Code)"}\n`);
  process.exit(0);
}

const dir = process.env.FAKE_CLAUDE_DIR;
if (!dir) {
  process.stderr.write("fake-claude: FAKE_CLAUDE_DIR is required\n");
  process.exit(2);
}
mkdirSync(join(dir, "mcp"), { recursive: true });
const log = (entry) => appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
// Accept both `--flag value` and `--flag=value`; the SDK passes some flags in the joined form.
const argAfter = (flag) => {
  const i = args.indexOf(flag);
  if (i >= 0) return args[i + 1];
  const joined = args.find((value) => value.startsWith(`${flag}=`));
  return joined === undefined ? undefined : joined.slice(flag.length + 1);
};

// --mcp-config is inline JSON or a file path. Keep the full config only in an owner-only file and log names/URLs.
let mcpServers = [];
const mcpArg = argAfter("--mcp-config");
if (mcpArg !== undefined) {
  try {
    const config = JSON.parse(mcpArg.trimStart().startsWith("{") ? mcpArg : readFileSync(mcpArg, "utf8"));
    const file = join(dir, "mcp", `${process.pid}.json`);
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    chmodSync(file, 0o600);
    mcpServers = Object.entries(config.mcpServers ?? {}).map(([name, server]) => ({ name, url: server?.url ?? null }));
  } catch (error) {
    log({ event: "mcp-config-unreadable", error: String(error?.message ?? error) });
  }
}

const sdk = argAfter("--input-format") === "stream-json";
let model = argAfter("--model") ?? "default";
const sessionId = argAfter("--session-id") ?? argAfter("--resume") ?? randomUUID();
log({
  event: "launch",
  mode: sdk ? "sdk" : "terminal",
  cwd: process.cwd(),
  model,
  sessionIdArg: argAfter("--session-id") ?? null,
  resume: argAfter("--resume") ?? null,
  mcpServers,
  // Flag names only: values and positional arguments (the launch prompt, inline settings) can hold sensitive input.
  // A prompt can itself start with "--", so keep only tokens shaped like a bare option name.
  flags: args.map((value) => value.split("=")[0]).filter((name) => /^--[a-z][a-z0-9-]*$/.test(name)).slice(0, 80),
});
const exit = (reason) => {
  log({ event: "exit", reason });
  process.exit(0);
};
process.on("SIGTERM", () => exit("SIGTERM"));
process.on("SIGHUP", () => exit("SIGHUP"));

if (!sdk) {
  process.stdout.write(`fake-claude terminal session=${sessionId} model=${model}\r\n`);
  process.stdin.on("data", (chunk) => {
    log({ event: "terminal-input", bytes: chunk.length });
    process.stdout.write(chunk);
  });
  setInterval(() => {}, 1 << 30);
} else {
  const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const ctx = () => {
    try {
      return Number(readFileSync(join(dir, "ctx"), "utf8").trim()) || 1000;
    } catch {
      return 1000;
    }
  };
  const capacity = () => (model.endsWith("[1m]") ? 1_000_000 : 200_000);
  const respond = (requestId, response) => out({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  const envelope = () => ({ parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
  let inited = false;
  let turnOpen = false;
  let stdinEnded = false;
  const queue = [];

  const runTurn = async (text) => {
    turnOpen = true;
    const turnModel = model;
    log({ event: "turn-start", model: turnModel, chars: text.length });
    if (!inited) {
      out({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), tools: [], mcp_servers: mcpServers.map(({ name }) => ({ name, status: "connected" })), permissionMode: "default", slash_commands: [], apiKeySource: "none", claude_code_version: "2.1.999", output_style: "default", agents: [], skills: [], plugins: [], uuid: randomUUID() });
      inited = true;
    }
    const tokens = ctx();
    const usage = { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 8 };
    out({ type: "stream_event", event: { type: "message_start", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: turnModel, content: [], usage: { input_tokens: 0, output_tokens: 0 } } }, ...envelope() });
    out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: null }, usage }, ...envelope() });
    if (text.includes("SLOW")) {
      const release = join(dir, "release");
      const deadline = Date.now() + 120_000;
      while (!existsSync(release) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      try {
        unlinkSync(release);
      } catch {}
    } else {
      await new Promise((r) => setTimeout(r, 150));
    }
    const reply = `fake reply from model=${turnModel}`;
    out({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: turnModel, content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null, usage }, ...envelope() });
    out({ type: "result", subtype: "success", is_error: false, duration_ms: 200, duration_api_ms: 100, num_turns: 1, result: reply, stop_reason: "end_turn", session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID() });
    log({ event: "turn-end", model: turnModel, contextTokens: tokens });
    turnOpen = false;
    const next = queue.shift();
    if (next !== undefined) void runTurn(next);
    else if (stdinEnded) exit("stdin-end");
  };

  const runWakeTurn = async (wake) => {
    turnOpen = true;
    const turnModel = model;
    log({ event: "turn-start", model: turnModel, wakeKind: wake.kind ?? "peer", wake });
    if (!inited) {
      out({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), tools: [], mcp_servers: mcpServers.map(({ name }) => ({ name, status: "connected" })), permissionMode: "default", slash_commands: [], apiKeySource: "none", claude_code_version: "2.1.999", output_style: "default", agents: [], skills: [], plugins: [], uuid: randomUUID() });
      inited = true;
    }
    const tokens = ctx();
    const usage = { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 8 };

    if (wake.kind === "task") {
      log({ event: "wake-emit", phase: "task_notification", at: new Date().toISOString() });
      out({ type: "system", subtype: "task_notification", task_id: wake.taskId ?? randomUUID(), status: "completed", ...envelope() });
    }

    if (wake.retry === true) {
      log({ event: "wake-emit", phase: "api_retry", at: new Date().toISOString() });
      out({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, delay_ms: 500, ...envelope() });
    }

    if (wake.error === "result-only") {
      const errorText = 'API Error: 402 {"error":"Credit balance too low"}';
      log({ event: "wake-emit", phase: "result_only_402", at: new Date().toISOString() });
      out({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null, errors: [errorText], session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID() });
      log({ event: "turn-end", model: turnModel, error: "402-result-only" });
      turnOpen = false;
      return;
    }

    log({ event: "wake-emit", phase: "message_start", at: new Date().toISOString() });
    out({ type: "stream_event", event: { type: "message_start", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: turnModel, content: [], usage: { input_tokens: 0, output_tokens: 0 } } }, ...envelope() });
    out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: null }, usage }, ...envelope() });

    if (wake.error === "synthetic") {
      const errorText = 'API Error: 402 {"error":"Credit balance too low"}';
      log({ event: "wake-emit", phase: "synthetic_assistant_402", at: new Date().toISOString() });
      out({ type: "assistant", message: { id: randomUUID(), type: "message", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: errorText }], stop_reason: "stop_sequence", stop_sequence: "", usage }, error: "unknown", isApiErrorMessage: true, apiErrorStatus: 402, ...envelope() });
      out({ type: "result", subtype: "success", is_error: true, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: errorText, stop_reason: "stop_sequence", session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID() });
      log({ event: "turn-end", model: turnModel, error: "402-synthetic" });
      turnOpen = false;
      return;
    }

    if (wake.thinking === true) {
      log({ event: "wake-emit", phase: "thinking_start", at: new Date().toISOString() });
      out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, ...envelope() });
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "wake reasoning..." } }, ...envelope() });
      out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, ...envelope() });
    }

    if (typeof wake.silenceMs === "number" && wake.silenceMs > 0) {
      log({ event: "wake-emit", phase: "silence_start", ms: wake.silenceMs, at: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, wake.silenceMs));
    }

    if (wake.first === "tool") {
      log({ event: "wake-emit", phase: "tool_use", at: new Date().toISOString() });
      const toolContent = [{ type: "tool_use", id: `call_${randomUUID()}`, name: "Bash", input: { command: "echo wake" } }];
      out({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: turnModel, content: toolContent, stop_reason: "tool_use", stop_sequence: null, usage }, ...envelope() });
    } else {
      log({ event: "wake-emit", phase: "text", at: new Date().toISOString() });
      const textContent = [{ type: "text", text: `fake wake reply from model=${turnModel}` }];
      out({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: turnModel, content: textContent, stop_reason: "end_turn", stop_sequence: null, usage }, ...envelope() });
    }

    out({ type: "result", subtype: "success", is_error: false, duration_ms: 200, duration_api_ms: 100, num_turns: 1, result: "wake finished", stop_reason: "end_turn", session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID() });
    log({ event: "turn-end", model: turnModel, contextTokens: tokens });
    turnOpen = false;

    const next = queue.shift();
    if (next !== undefined) void runTurn(next);
    else if (stdinEnded) exit("stdin-end");
  };

  const wakePollingTimer = setInterval(() => {
    if (turnOpen) return;
    const wakeFile = join(dir, "wake");
    if (existsSync(wakeFile)) {
      try {
        const raw = readFileSync(wakeFile, "utf8");
        unlinkSync(wakeFile);
        const wake = JSON.parse(raw);
        void runWakeTurn(wake);
      } catch (err) {
        log({ event: "wake-parse-error", error: String(err?.message ?? err) });
      }
    }
  }, 200);

  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "control_request") {
        const req = message.request ?? {};
        const id = message.request_id;
        log({ event: "control", subtype: req.subtype ?? null, model: req.model ?? null, turnOpen });
        if (req.subtype === "initialize") {
          respond(id, { commands: [], models: [], agents: [], account: {}, output_style: "default", available_output_styles: ["default"] });
        } else if (req.subtype === "set_model") {
          if (existsSync(join(dir, "fail_set_model"))) {
            out({ type: "control_response", response: { subtype: "error", request_id: id, error: "fake set_model failure" } });
          } else {
            model = req.model ?? "default";
            respond(id, {});
          }
        } else if (req.subtype === "get_context_usage") {
          const total = ctx();
          respond(id, { totalTokens: total, maxTokens: capacity(), rawMaxTokens: capacity(), percentage: Math.round((total / capacity()) * 100), model, isAutoCompactEnabled: false, categories: [{ name: "Messages", tokens: total, color: "x" }], memoryFiles: [], mcpTools: [], gridRows: [] });
        } else {
          respond(id, {});
        }
        continue;
      }
      if (message.type === "user") {
        const content = message.message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => block?.text ?? "").join("") : "";
        if (turnOpen) queue.push(text);
        else void runTurn(text);
      }
    }
  });
  process.stdin.on("end", () => {
    stdinEnded = true;
    if (!turnOpen) exit("stdin-end");
  });
}
