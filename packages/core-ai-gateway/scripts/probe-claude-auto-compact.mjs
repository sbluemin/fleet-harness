#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  CLAUDE_COMPAT_CONTEXT_WINDOW,
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  projectClaudeContextInputTokens,
} from "../dist/index.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const MODEL_PREFIX = "claude-gateway--";
const ONE_MILLION_MARKER = "[1m]";

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Usage:
  pnpm --silent --filter @dotobokuri/core-ai-gateway probe:claude-auto-compact -- \\
    --model <gateway-id> --provider-window <n> --input-tokens <n> \\
    --expect <compact|no-compact>

Options:
  --model <id>             Gateway model id; use [1m] only for a real >=1M model
  --provider-window <n>    Real provider context window
  --input-tokens <n>       Real input usage returned by the pressure turn
  --expect <result>        Expected auto-compact result
  --auto-compact-window <n>  Optional explicit Claude Code compact ceiling
  --timeout-ms <ms>        Positive process timeout (default: ${DEFAULT_TIMEOUT_MS})
  --help                   Show this help without launching Claude Code

The probe maps real usage through core-ai-gateway's built implementation, clears
inherited auto-compact overrides, optionally injects the requested ceiling, and drives
the installed Claude Code against a local fixture. It contacts no provider or credential.
`);
    return;
  }

  const result = await runProbe(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  const expectedCompacting = options.expect === "compact";
  if (
    result.timedOut
    || result.exit.code !== 0
    || result.observedContextWindow !== result.expectedContextWindow
    || result.compacting !== expectedCompacting
    || (expectedCompacting && result.compactResult !== "success")
  ) process.exitCode = 1;
}

function parseArguments(argv) {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const options = {
    autoCompactWindow: undefined,
    expect: undefined,
    help: false,
    inputTokens: undefined,
    model: undefined,
    providerWindow: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const seen = new Set();

  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const argument = normalizedArgv[index];
    switch (argument) {
      case "--help":
        options.help = true;
        break;
      case "--model":
        rejectDuplicate(seen, argument);
        options.model = readValue(normalizedArgv, index, argument);
        index += 1;
        break;
      case "--provider-window":
        rejectDuplicate(seen, argument);
        options.providerWindow = positiveInteger(readValue(normalizedArgv, index, argument), argument);
        index += 1;
        break;
      case "--input-tokens":
        rejectDuplicate(seen, argument);
        options.inputTokens = positiveInteger(readValue(normalizedArgv, index, argument), argument);
        index += 1;
        break;
      case "--expect":
        rejectDuplicate(seen, argument);
        options.expect = readValue(normalizedArgv, index, argument);
        index += 1;
        break;
      case "--auto-compact-window":
        rejectDuplicate(seen, argument);
        options.autoCompactWindow = positiveInteger(readValue(normalizedArgv, index, argument), argument);
        index += 1;
        break;
      case "--timeout-ms":
        rejectDuplicate(seen, argument);
        options.timeoutMs = positiveInteger(readValue(normalizedArgv, index, argument), argument);
        index += 1;
        break;
      default:
        throw new UsageError(`Unknown argument ${JSON.stringify(argument)}`);
    }
  }

  if (options.help) return options;
  if (!options.model?.startsWith(MODEL_PREFIX)) {
    throw new UsageError(`--model must start with ${JSON.stringify(MODEL_PREFIX)}`);
  }
  if (options.providerWindow === undefined) throw new UsageError("--provider-window is required");
  if (options.inputTokens === undefined) throw new UsageError("--input-tokens is required");
  if (options.expect !== "compact" && options.expect !== "no-compact") {
    throw new UsageError("--expect must be compact or no-compact");
  }
  const marked = options.model.endsWith(ONE_MILLION_MARKER);
  if (marked !== (options.providerWindow >= CLAUDE_COMPAT_CONTEXT_WINDOW)) {
    throw new UsageError("[1m] must exactly match a provider window of at least 1M");
  }
  return options;
}

function readValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`${option} requires a value`);
  return value;
}

function positiveInteger(value, option) {
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`${option} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`${option} is too large`);
  return parsed;
}

function rejectDuplicate(seen, option) {
  if (seen.has(option)) throw new UsageError(`${option} may be provided only once`);
  seen.add(option);
}

async function runProbe(options) {
  const requests = [];
  const outputEvents = [];
  const sessionId = randomUUID();
  const modelWindow = options.model.endsWith(ONE_MILLION_MARKER)
    ? CLAUDE_COMPAT_CONTEXT_WINDOW
    : CLAUDE_DEFAULT_CONTEXT_WINDOW;
  const projectedInputTokens = projectClaudeContextInputTokens(
    options.inputTokens,
    options.providerWindow,
  );
  const configDir = await mkdtemp(path.join(os.tmpdir(), "fleet-compact-probe-"));
  let server;
  let child;
  let timedOut = false;

  try {
    server = http.createServer((req, res) => {
      void handleFixtureRequest(req, res, {
        inputTokens: projectedInputTokens,
        model: options.model,
        providerWindow: options.providerWindow,
        requests,
      }).catch((error) => {
        if (res.headersSent) return res.end();
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(error) } }));
      });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP port");

    const environment = { ...process.env };
    for (const name of [
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
      "CLAUDE_CODE_AUTO_COMPACT",
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_DISABLE_1M_CONTEXT",
      "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    ]) delete environment[name];
    delete environment.INIT_CWD;
    Object.assign(environment, {
      ...(options.autoCompactWindow === undefined
        ? {}
        : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(options.autoCompactWindow) }),
      ANTHROPIC_API_KEY: "sk-ant-fleet-gateway-smoke",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
    });

    child = spawn("claude", [
      "--bare",
      "--print",
      "--model", options.model,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--session-id", sessionId,
      "--tools", "",
    ], { env: environment, stdio: ["pipe", "pipe", "pipe"] });

    let stdoutBuffer = "";
    let stderr = "";
    let sentTurns = 0;
    const prompts = [
      "Fixture warmup turn one. Reply with OK.",
      "Fixture warmup turn two. Reply with OK.",
      "Fixture warmup turn three. Reply with OK.",
      "Fixture pressure turn. Reply with OK.",
      "Fixture trigger turn. Reply with DONE.",
    ];
    const sendNext = () => {
      const content = prompts[sentTurns];
      if (content === undefined) return child.stdin.end();
      child.stdin.write(`${JSON.stringify({
        type: "user",
        session_id: sessionId,
        message: { role: "user", content },
      })}\n`);
      sentTurns += 1;
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          outputEvents.push(event);
          if (event.type === "result") sendNext();
        } catch {
          // Claude's stream-json contract is authoritative; ignore incidental text.
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs);
    sendNext();
    const exit = await waitForExit(child);
    clearTimeout(timeout);

    const statusEvents = outputEvents.filter((event) => event.type === "system" && event.subtype === "status");
    const resultEvents = outputEvents.filter((event) => event.type === "result");
    const modelUsage = resultEvents.findLast((event) => event.modelUsage?.[options.model])
      ?.modelUsage?.[options.model];
    const classified = requests.map(classifyRequest);
    return {
      claudeCodeVersion: outputEvents.find((event) => event.type === "system" && event.subtype === "init")
        ?.claude_code_version ?? null,
      model: options.model,
      autoCompactWindow: options.autoCompactWindow ?? null,
      providerWindow: options.providerWindow,
      actualInputTokens: options.inputTokens,
      projectedInputTokens,
      expected: options.expect,
      expectedContextWindow: modelWindow,
      observedContextWindow: modelUsage?.contextWindow ?? null,
      compacting: statusEvents.some((event) => event.status === "compacting"),
      compactResult: statusEvents.findLast((event) => Object.hasOwn(event, "compact_result"))
        ?.compact_result ?? null,
      requestCounts: {
        workload: classified.filter((kind) => kind === "workload").length,
        auxiliary: classified.filter((kind) => kind === "auxiliary").length,
      },
      timedOut,
      exit,
      stderr: stderr.trim() || null,
    };
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    if (server) await closeServer(server);
    await rm(configDir, { recursive: true, force: true });
  }
}

async function handleFixtureRequest(req, res, fixture) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  fixture.requests.push({ body, method: req.method, pathname });

  if ((req.method === "HEAD" || req.method === "GET") && pathname === "/api/hello") {
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }
  if (req.method === "GET" && pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [{
        type: "model",
        id: fixture.model,
        display_name: fixture.model,
        created_at: "2026-08-11T00:00:00Z",
        max_input_tokens: fixture.providerWindow,
      }],
      has_more: false,
    }));
    return;
  }
  if (req.method !== "POST" || pathname !== "/v1/messages") {
    res.writeHead(404).end();
    return;
  }

  const kind = classifyRequest({ body, method: req.method, pathname });
  const lastText = lastUserText(body);
  const reportedInputTokens = lastText.includes("Fixture pressure turn") ? fixture.inputTokens : 1_000;
  const text = kind === "auxiliary"
    ? '{"title":"Context fixture"}'
    : lastText.includes("Fixture trigger turn") ? "DONE" : "OK";
  writeAnthropicSse(res, fixture.model, text, reportedInputTokens);
}

function classifyRequest(request) {
  if (request.method !== "POST" || request.pathname !== "/v1/messages") return "auxiliary";
  const systemText = Array.isArray(request.body?.system)
    ? request.body.system.map((block) => typeof block?.text === "string" ? block.text : "").join("\n")
    : String(request.body?.system ?? "");
  if (systemText.includes("Generate a concise, sentence-case title")) return "auxiliary";
  return "workload";
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const user = [...messages].reverse().find((message) => message?.role === "user");
  if (typeof user?.content === "string") return user.content;
  if (!Array.isArray(user?.content)) return "";
  return user.content.map((block) => typeof block?.text === "string" ? block.text : "").join("\n");
}

function writeAnthropicSse(res, model, text, inputTokens) {
  const id = `msg_${randomUUID()}`;
  const events = [
    ["message_start", { type: "message_start", message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  res.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

main().catch((error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
});
