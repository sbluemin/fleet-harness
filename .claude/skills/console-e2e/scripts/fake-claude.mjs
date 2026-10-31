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
//   ask              one-shot ExitPlanMode approval hold on the next turn, or while initialized and idle
//   ask-<sessionId>  same hold, scoped to this launch's --session-id/--resume (use with a shared directory)
//                    empty file or JSON {sessionId?: string}; mismatched targets leave the file untouched
//   sdk-mcp/tools-<pid>.json  written by every SDK launch the host gave in-process MCP servers (Commodore's fleet-commodore):
//                    each server's advertised tools with description and inputSchema (field limits included)
//   sdk-calls        one-shot in-process tool calls on the next turn: {"sessionId"?: string, "calls": [{"server", "tool", "args"?}]};
//                    taken only by a launch holding every named server (log `sdk-calls-skipped` otherwise)
//   sdk-calls-<sessionId>  same, scoped to this launch's --session-id/--resume
//   sdk-mcp/calls-<ts>-<pid>.json  each call's args, isError, error code and full JSON-RPC result (mode 0600)
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
let abortAsk = () => {};
const exit = (reason) => {
  abortAsk(reason);
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
  let turnAborted = false;
  let stdinEnded = false;
  const queue = [];
  let pendingAsk = null;
  const takeAsk = () => {
    // A launch may not consume another Objective's request in a shared control directory.
    for (const name of [`ask-${sessionId}`, "ask"]) {
      const file = join(dir, name);
      try {
        const raw = readFileSync(file, "utf8").trim();
        const options = raw ? JSON.parse(raw) : {};
        if (options.sessionId !== undefined && options.sessionId !== sessionId) continue;
        unlinkSync(file);
        return true;
      } catch (error) {
        if (error.code !== "ENOENT") log({ event: "ask-file-error", sessionId, file: name, error: String(error?.message ?? error) });
      }
    }
    return false;
  };
  abortAsk = (reason) => {
    if (!pendingAsk) return;
    const { requestId, toolUseId, resolve } = pendingAsk;
    pendingAsk = null;
    log({ event: "ask-aborted", sessionId, requestId, toolUseId, reason });
    resolve(true);
  };
  const holdForAnswer = (turnModel, usage) => {
    const toolUseId = `toolu_${randomUUID().replace(/-/g, "")}`;
    const requestId = `ask-${randomUUID()}`;
    const input = { plan: "Fake plan: wait for the person's approval." };
    const answered = new Promise((resolve) => { pendingAsk = { requestId, toolUseId, resolve }; });
    out({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: turnModel, content: [{ type: "tool_use", id: toolUseId, name: "ExitPlanMode", input }], stop_reason: "tool_use", stop_sequence: null, usage }, ...envelope() });
    log({ event: "ask-emit", sessionId, requestId, toolUseId });
    out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input, tool_use_id: toolUseId, permission_suggestions: [] } });
    return answered;
  };

  // In-process SDK MCP servers (Commodore's fleet-commodore) are not in --mcp-config: the SDK names them in
  // `initialize` and answers JSON-RPC over the `mcp_message` control request, as it does for the real CLI.
  let sdkServers = [];
  let sdkReady = Promise.resolve();
  const sdkWaiters = new Map();
  let sdkRpcId = 1;
  const sdkMcp = (server, method, params, notification = false) => new Promise((resolve) => {
    const requestId = `sdkmcp-${randomUUID()}`;
    const message = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: sdkRpcId++, method, params };
    const timer = setTimeout(() => { sdkWaiters.delete(requestId); resolve({ error: "timeout" }); }, 30_000);
    sdkWaiters.set(requestId, (response) => {
      clearTimeout(timer);
      if (response?.subtype !== "success") resolve({ error: response?.error ?? response?.subtype ?? "no_response" });
      else resolve(response.response?.mcp_response ?? { error: "no_mcp_response" });
    });
    out({ type: "control_request", request_id: requestId, request: { subtype: "mcp_message", server_name: server, message } });
  });
  const sdkFile = (name, value) => {
    mkdirSync(join(dir, "sdk-mcp"), { recursive: true });
    const file = join(dir, "sdk-mcp", name);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  };
  const rpcErrorText = (error) => String(error?.message ?? (typeof error === "string" ? error : JSON.stringify(error))).slice(0, 200);
  // Connect like the CLI does at startup and save each server's advertised tools (description, inputSchema with its limits).
  const connectSdkServers = async () => {
    const servers = {};
    for (const server of sdkServers) {
      const init = await sdkMcp(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
      if (init.error) {
        servers[server] = { error: rpcErrorText(init.error) };
        continue;
      }
      await sdkMcp(server, "notifications/initialized", {}, true);
      const listed = await sdkMcp(server, "tools/list", {});
      servers[server] = listed.error ? { error: rpcErrorText(listed.error) } : { tools: listed.result?.tools ?? [] };
      log({ event: "sdk-tools", server, count: servers[server].tools?.length ?? null, ...(listed.error ? { error: servers[server].error } : {}) });
    }
    sdkFile(`tools-${process.pid}.json`, { at: new Date().toISOString(), pid: process.pid, sessionId, cwd: process.cwd(), servers });
  };
  // `sdk-calls-<sessionId>` or `sdk-calls`: {"sessionId"?, "calls": [{"server", "tool", "args"?}]}. A launch takes it only when it
  // holds every named SDK server, so an Objective launch never consumes a Commodore plan in a shared directory.
  const takeSdkCalls = () => {
    for (const name of [`sdk-calls-${sessionId}`, "sdk-calls"]) {
      const file = join(dir, name);
      try {
        const plan = JSON.parse(readFileSync(file, "utf8"));
        if (plan.sessionId !== undefined && plan.sessionId !== sessionId) continue;
        const calls = Array.isArray(plan.calls) ? plan.calls : [];
        const missing = [...new Set(calls.map((call) => call?.server))].filter((server) => !sdkServers.includes(server));
        if (calls.length === 0 || missing.length > 0) {
          log({ event: "sdk-calls-skipped", file: name, missing, calls: calls.length });
          continue;
        }
        unlinkSync(file);
        return calls;
      } catch (error) {
        if (error.code !== "ENOENT") log({ event: "sdk-calls-file-error", file: name, error: String(error?.message ?? error) });
      }
    }
    return [];
  };
  // Each call is framed as the model's tool_use and the CLI's tool_result inside the open turn, so the host records it.
  const runSdkCalls = async (calls, turnModel, usage) => {
    const results = [];
    for (const [index, call] of calls.entries()) {
      if (turnAborted) {
        log({ event: "sdk-calls-aborted", remaining: calls.length - index });
        break;
      }
      const args = call.args ?? {};
      const toolUseId = `toolu_${randomUUID().replace(/-/g, "")}`;
      out({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: turnModel, content: [{ type: "tool_use", id: toolUseId, name: `mcp__${call.server}__${call.tool}`, input: args }], stop_reason: "tool_use", stop_sequence: null, usage }, ...envelope() });
      const reply = await sdkMcp(call.server, "tools/call", { name: call.tool, arguments: args });
      const result = reply.result ?? null;
      const text = (result?.content ?? []).map((block) => block?.text ?? "").join("");
      let errorCode = result?.structuredContent?.error ?? null;
      try {
        errorCode ??= JSON.parse(text)?.error ?? null;
      } catch {}
      const isError = Boolean(reply.error || result?.isError);
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text || (reply.error ? rpcErrorText(reply.error) : ""), is_error: isError }] }, ...envelope() });
      results.push({ server: call.server, tool: call.tool, args, isError, errorCode, ...(reply.error ? { rpcError: reply.error } : {}), result });
      log({ event: "sdk-call", server: call.server, tool: call.tool, isError, errorCode: errorCode === null ? null : String(errorCode).slice(0, 64), ...(reply.error ? { rpcError: rpcErrorText(reply.error) } : {}) });
    }
    const at = new Date().toISOString();
    sdkFile(`calls-${at.replace(/[:.]/g, "-")}-${process.pid}.json`, { at, pid: process.pid, sessionId, calls: results });
  };

  const runTurn = async (text, ask = takeAsk()) => {
    turnOpen = true;
    turnAborted = false;
    const turnModel = model;
    log({ event: "turn-start", model: turnModel, chars: text.length });
    if (!inited) {
      out({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), tools: [], mcp_servers: [...mcpServers.map(({ name }) => name), ...sdkServers].map((name) => ({ name, status: "connected" })), permissionMode: "default", slash_commands: [], apiKeySource: "none", claude_code_version: "2.1.999", output_style: "default", agents: [], skills: [], plugins: [], uuid: randomUUID() });
      inited = true;
    }
    const tokens = ctx();
    const usage = { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 8 };
    out({ type: "stream_event", event: { type: "message_start", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: turnModel, content: [], usage: { input_tokens: 0, output_tokens: 0 } } }, ...envelope() });
    out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: null }, usage }, ...envelope() });
    await sdkReady;
    const sdkCalls = takeSdkCalls();
    if (sdkCalls.length > 0) await runSdkCalls(sdkCalls, turnModel, usage);
    let interrupted = turnAborted;
    if (interrupted) {
      // An interrupt during the calls ends the turn without the canned wait.
    } else if (ask) {
      interrupted = await holdForAnswer(turnModel, usage);
    } else if (text.includes("SLOW")) {
      const release = join(dir, "release");
      const deadline = Date.now() + 120_000;
      while (!existsSync(release) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      try {
        unlinkSync(release);
      } catch {}
    } else {
      await new Promise((r) => setTimeout(r, 150));
    }
    const reply = interrupted ? "fake turn interrupted" : `fake reply from model=${turnModel}`;
    out({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: turnModel, content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null, usage }, ...envelope() });
    out({ type: "result", subtype: "success", is_error: false, duration_ms: 200, duration_api_ms: 100, num_turns: 1, result: reply, stop_reason: "end_turn", session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID() });
    log({ event: "turn-end", model: turnModel, contextTokens: tokens, ...(interrupted ? { interrupted: true } : {}) });
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
      out({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), tools: [], mcp_servers: [...mcpServers.map(({ name }) => name), ...sdkServers].map((name) => ({ name, status: "connected" })), permissionMode: "default", slash_commands: [], apiKeySource: "none", claude_code_version: "2.1.999", output_style: "default", agents: [], skills: [], plugins: [], uuid: randomUUID() });
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
    if (inited && takeAsk()) {
      void runTurn("", true);
      return;
    }
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
      if (message.type === "control_response") {
        const sdkWaiter = sdkWaiters.get(message.response?.request_id);
        if (sdkWaiter) {
          sdkWaiters.delete(message.response.request_id);
          sdkWaiter(message.response);
          continue;
        }
        if (pendingAsk && message.response?.request_id === pendingAsk.requestId) {
          const { requestId, toolUseId, resolve } = pendingAsk;
          pendingAsk = null;
          const answer = message.response?.response;
          log({ event: "ask-answered", sessionId, requestId, toolUseId, behavior: answer?.behavior ?? message.response?.subtype ?? null, hasMessage: typeof answer?.message === "string" && answer.message.length > 0 });
          resolve(false);
        }
        continue;
      }
      if (message.type === "control_request") {
        const req = message.request ?? {};
        const id = message.request_id;
        log({ event: "control", subtype: req.subtype ?? null, model: req.model ?? null, turnOpen });
        if (req.subtype === "initialize") {
          respond(id, { commands: [], models: [], agents: [], account: {}, output_style: "default", available_output_styles: ["default"] });
          sdkServers = Array.isArray(req.sdkMcpServers) ? req.sdkMcpServers.filter((name) => typeof name === "string") : [];
          if (sdkServers.length > 0) {
            log({ event: "sdk-mcp-servers", servers: sdkServers });
            sdkReady = connectSdkServers().catch((error) => log({ event: "sdk-tools-error", error: String(error?.message ?? error) }));
          }
        } else if (req.subtype === "set_model") {
          if (existsSync(join(dir, "fail_set_model"))) {
            out({ type: "control_response", response: { subtype: "error", request_id: id, error: "fake set_model failure" } });
          } else {
            model = req.model ?? "default";
            respond(id, {});
          }
        } else if (req.subtype === "interrupt") {
          if (turnOpen) turnAborted = true;
          abortAsk("interrupt");
          respond(id, {});
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
    if (turnOpen) turnAborted = true;
    abortAsk("stdin-end");
    if (!turnOpen) exit("stdin-end");
  });
}
