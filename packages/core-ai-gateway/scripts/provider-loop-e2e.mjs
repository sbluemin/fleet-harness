#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import http from "node:http";

const CONFIRM_LIVE_PROVIDER = "--confirm-live-provider";
const GATEWAY_MODEL_PREFIX = "claude-gateway--";
const DEFAULT_OPERATIONS = 3;
const DEFAULT_TRIALS = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OPERATIONS = 20;
const MAX_TRIALS = 20;
const MAX_TIMER_MS = 2_147_483_647;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

const HELP = `Usage: pnpm --filter @dotobokuri/core-ai-gateway e2e:provider-loop -- --model <exact-gateway-model-id> [options] ${CONFIRM_LIVE_PROVIDER}

WARNING: this runner uses real provider quota. Build the package first:
  pnpm --filter @dotobokuri/core-ai-gateway build

Options:
  --model <id>             Required exact id beginning with ${GATEWAY_MODEL_PREFIX}
  --effort <level>         low|medium|high|xhigh|max|ultra
  --operations <count>     Positive integer, default ${DEFAULT_OPERATIONS}, maximum ${MAX_OPERATIONS}
  --trials <count>         Positive integer, default ${DEFAULT_TRIALS}, maximum ${MAX_TRIALS}
  --timeout-ms <count>     Positive integer, default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMER_MS}
  ${CONFIRM_LIVE_PROVIDER}  Required explicit consent to spend live provider quota
  --help                   Show this help before loading build artifacts or credentials

Example:
  pnpm --filter @dotobokuri/core-ai-gateway e2e:provider-loop -- --model 'claude-gateway--opencode--deepseek-v4-flash[1m]' --operations 3 --trials 5 --confirm-live-provider

FLEET_GATEWAY_WIRE_LOG records raw prompt and tool payloads. Use it only with an isolated
scratch path after explicit opt-in; credentials are not recorded, but the payloads are sensitive.
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

class RequestTimeoutError extends Error {
  constructor() {
    super("provider-loop request timed out");
    this.name = "RequestTimeoutError";
  }
}

class TrialTimeoutError extends Error {
  constructor() {
    super("provider-loop trial timed out");
    this.name = "TrialTimeoutError";
  }
}

function parseArguments(argv) {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalizedArgv.includes("--help")) return { help: true };

  const options = {
    effort: null,
    model: null,
    operations: DEFAULT_OPERATIONS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    trials: DEFAULT_TRIALS,
  };
  const seen = new Set();
  let confirmed = false;

  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const argument = normalizedArgv[index];
    if (argument === CONFIRM_LIVE_PROVIDER) {
      if (confirmed) throw new UsageError(`${CONFIRM_LIVE_PROVIDER} may be provided only once`);
      confirmed = true;
      continue;
    }

    const optionName = argument;
    if (!new Set(["--model", "--effort", "--operations", "--trials", "--timeout-ms"]).has(optionName)) {
      throw new UsageError(`Unknown argument ${JSON.stringify(argument)}`);
    }
    if (seen.has(optionName)) throw new UsageError(`${optionName} may be provided only once`);
    seen.add(optionName);

    const value = readOptionValue(normalizedArgv, index, optionName);
    index += 1;
    if (optionName === "--model" || optionName === "--effort") {
      options[optionName.slice(2)] = value;
    } else if (optionName === "--operations") {
      options.operations = parsePositiveInteger(optionName, value);
    } else if (optionName === "--trials") {
      options.trials = parsePositiveInteger(optionName, value);
    } else {
      options.timeoutMs = parsePositiveInteger(optionName, value);
    }
  }

  if (!options.model || !options.model.startsWith(GATEWAY_MODEL_PREFIX)) {
    throw new UsageError(`--model must be an exact id beginning with ${GATEWAY_MODEL_PREFIX}`);
  }
  if (options.effort !== null && !EFFORTS.has(options.effort)) {
    throw new UsageError("--effort must be one of low, medium, high, xhigh, max, ultra");
  }
  if (options.operations > MAX_OPERATIONS) {
    throw new UsageError(`--operations must not exceed ${MAX_OPERATIONS}`);
  }
  if (options.trials > MAX_TRIALS) {
    throw new UsageError(`--trials must not exceed ${MAX_TRIALS}`);
  }
  if (options.timeoutMs > MAX_TIMER_MS) {
    throw new UsageError(`--timeout-ms must not exceed ${MAX_TIMER_MS}`);
  }
  if (!confirmed) throw new UsageError(`missing required ${CONFIRM_LIVE_PROVIDER}`);

  return options;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new UsageError(`${optionName} requires a value`);
  }
  return value;
}

function parsePositiveInteger(optionName, value) {
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`${optionName} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`${optionName} must be a safe positive integer`);
  return parsed;
}

function makeInitialPrompt(operations) {
  return `Perform exactly ${operations} sequential steps. For each step, call the record_step tool with the next integer step, wait for its result, and then call the next step. After all ${operations} steps are complete, reply with exactly LOOP_COMPLETE and nothing else.`;
}

function makeToolChoice(complete) {
  return complete
    ? { type: "none", disable_parallel_tool_use: true }
    : { type: "tool", name: "record_step", disable_parallel_tool_use: true };
}

function makeRequest(options, metadata, messages, complete) {
  return {
    model: options.model,
    messages,
    tools: [{
      name: "record_step",
      description: "Record one sequential workload step.",
      input_schema: {
        type: "object",
        properties: {
          step: {
            type: "integer",
            minimum: 1,
            maximum: options.operations,
          },
        },
        required: ["step"],
        additionalProperties: false,
      },
    }],
    tool_choice: makeToolChoice(complete),
    metadata,
    max_tokens: 256,
    stream: false,
    ...(options.effort === null ? {} : { output_config: { effort: options.effort } }),
  };
}

function createTrialMetrics() {
  return {
    gatewayRequests: 0,
    callerToolCalls: 0,
    callerToolResults: 0,
    callerErrors: 0,
    wallTimeMs: 0,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
    },
    cursorDiagnosticEvents: {},
  };
}

function addUsage(metrics, usage) {
  if (!usage || typeof usage !== "object") return;
  metrics.usage.inputTokens += nonNegativeNumber(usage.input_tokens);
  metrics.usage.cachedInputTokens += nonNegativeNumber(
    usage.cache_read_input_tokens ?? usage.cached_input_tokens,
  );
  metrics.usage.cacheWriteInputTokens += nonNegativeNumber(
    usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens,
  );
  metrics.usage.outputTokens += nonNegativeNumber(usage.output_tokens);
}

function nonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseAnthropicResponse(result) {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`upstream HTTP status ${result.status}`);
  }

  let response;
  try {
    response = JSON.parse(result.body);
  } catch {
    throw new Error("non-JSON Anthropic response");
  }
  if (!response || typeof response !== "object") throw new Error("invalid Anthropic response");
  if (response.type === "error" || response.error) throw new Error("Anthropic API error response");
  return response;
}

async function runTrial({ options, port, diagnostics }) {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const metrics = createTrialMetrics();
  const seenToolUseIds = new Set();
  const metadata = { user_id: `provider-loop-e2e-${randomUUID()}` };
  let messages = [{ role: "user", content: makeInitialPrompt(options.operations) }];
  let expectedStep = 1;

  for (;;) {
    const complete = expectedStep > options.operations;
    const result = await requestJson(
      port,
      makeRequest(options, metadata, messages, complete),
      deadline,
    );
    const response = parseAnthropicResponse(result);
    metrics.gatewayRequests += 1;
    addUsage(metrics, response.usage);

    const content = Array.isArray(response.content) ? response.content : [];
    const toolUses = content.filter((block) => block?.type === "tool_use");
    if (complete) {
      if (toolUses.length !== 0) throw new Error("final response unexpectedly contained tool_use");
      const text = content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text.trim())
        .join("");
      if (text !== "LOOP_COMPLETE") throw new Error("final response text was not LOOP_COMPLETE");
      break;
    }

    if (toolUses.length !== 1) throw new Error("response did not contain exactly one tool_use");
    const toolUse = toolUses[0];
    if (typeof toolUse.id !== "string" || toolUse.id.length === 0) {
      throw new Error("record_step tool_use had no id");
    }
    if (seenToolUseIds.has(toolUse.id)) throw new Error("duplicate tool_use id");
    seenToolUseIds.add(toolUse.id);
    if (toolUse.name !== "record_step") throw new Error("unexpected tool name");
    if (!Number.isInteger(toolUse.input?.step) || toolUse.input.step !== expectedStep) {
      throw new Error("record_step returned an unexpected step");
    }

    metrics.callerToolCalls += 1;
    messages = [
      ...messages,
      { role: "assistant", content },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "ok" }],
      },
    ];
    metrics.callerToolResults += 1;
    expectedStep += 1;
  }

  metrics.wallTimeMs = Date.now() - startedAt;
  return metrics;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not expose an ephemeral port"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0 });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function requestJson(port, body, deadline) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new TrialTimeoutError());
      return;
    }

    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/ai-gateway/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-provider-loop-e2e",
      },
    });
    const timer = setTimeout(() => {
      request.destroy(new RequestTimeoutError());
    }, Math.min(remaining, MAX_TIMER_MS));
    const chunks = [];

    request.on("response", (response) => {
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        clearTimeout(timer);
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(JSON.stringify(body));
  });
}

function safeErrorName(error) {
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) ? name : "Error";
}

function makeDiagnosticSink(diagnostics) {
  return (event) => {
    if (typeof event?.event !== "string") return;
    diagnostics[event.event] = (diagnostics[event.event] ?? 0) + 1;
  };
}

function validateTarget(gateway, options) {
  const target = gateway.findGatewayModel(options.model);
  if (!target || gateway.toClaudeGatewayModelId(target) !== options.model) {
    throw new UsageError(`--model must be an exact discovery id: ${options.model}`);
  }
  if (options.effort !== null) {
    if (!target.effort.supported || !target.effort.levels.includes(options.effort)) {
      throw new UsageError(`--effort ${options.effort} is not supported by model ${options.model}`);
    }
  }
  return target;
}

function aggregateUsage(trials) {
  return trials.reduce((total, trial) => {
    total.inputTokens += trial.usage.inputTokens;
    total.cachedInputTokens += trial.usage.cachedInputTokens;
    total.cacheWriteInputTokens += trial.usage.cacheWriteInputTokens;
    total.outputTokens += trial.usage.outputTokens;
    return total;
  }, {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
  });
}

function aggregateDiagnosticEvents(trials) {
  return trials.reduce((total, trial) => {
    for (const [event, count] of Object.entries(trial.cursorDiagnosticEvents)) {
      total[event] = (total[event] ?? 0) + count;
    }
    return total;
  }, {});
}

function createTrialServer(router) {
  return http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const handled = await router.handle({ req: request, res: response, pathname });
      if (!handled && !response.writableEnded) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
      }
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "gateway_failure" }));
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  });
}

async function runTrialWithLifecycle({ gateway, infra, options, target }) {
  const diagnostics = {};
  const diagnosticSink = makeDiagnosticSink(diagnostics);
  const authService = infra.createAuthService();
  const router = gateway.createAiGatewayRouter({
    originator: "core-ai-gateway-provider-loop-e2e",
    readAuth: gateway.readCodexSubscriptionAuth,
    readCursorToken: gateway.readCursorSubscriptionToken,
    readXaiToken: gateway.readXaiSubscriptionToken,
    readKimiApiKey: () => authService.getApiKey(gateway.KIMI_AUTH_PROVIDER_ID),
    readOpencodeApiKey: () => authService.getApiKey(gateway.OPENCODE_AUTH_PROVIDER_ID),
    cursorDiagnostics: diagnosticSink,
  });
  const server = createTrialServer(router);
  let serverClosed = false;

  try {
    const port = await listen(server);
    const metrics = await runTrial({ options, port, diagnostics });
    router.dispose();
    const routerDisposed = true;
    await closeServer(server);
    serverClosed = !server.listening;
    if (!serverClosed) throw new Error("loopback server remained open");
    metrics.cursorDiagnosticEvents = Object.freeze({ ...diagnostics });
    metrics.cleanup = { routerDisposed, loopbackServerClosed: true };
    return metrics;
  } finally {
    if (!serverClosed) {
      router.dispose();
      await closeServer(server);
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  // Validate the gateway model immediately after its dynamic import and before core-infra.
  const gateway = await import("../dist/index.js");
  const target = validateTarget(gateway, options);
  const infra = await import("@dotobokuri/core-infra");
  const trials = [];

  for (let trialIndex = 1; trialIndex <= options.trials; trialIndex += 1) {
    try {
      trials.push(await runTrialWithLifecycle({ gateway, infra, options, target }));
    } catch (error) {
      process.stderr.write(
        `provider-loop trial failure: ${safeErrorName(error)} provider=${target.provider} model=${options.model} trial=${trialIndex}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  process.stdout.write(`${JSON.stringify({
    observedAt: new Date().toISOString(),
    model: options.model,
    provider: target.provider,
    upstreamModel: gateway.upstreamModelId(target),
    effort: options.effort,
    logicalOperations: options.operations,
    successfulTrials: trials.length,
    trials,
    usage: aggregateUsage(trials),
    cursorDiagnosticEvents: aggregateDiagnosticEvents(trials),
  })}\n`);
}

try {
  await main();
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`provider-loop failure: ${safeErrorName(error)}\n`);
    process.exitCode = 1;
  }
}
