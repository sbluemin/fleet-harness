#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";

import {
  CURSOR_SUBSCRIPTION_MODELS,
  CursorAdapter,
} from "../dist/index.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const CURSOR_SCOPE_PREFIX = "cursor--";
const MODES = new Set(["standard", "max", "both"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

const HELP = `Usage:
  pnpm --silent --filter @dotobokuri/core-ai-gateway probe:cursor-context -- --model <id> [--model <id> ...] [options]
  pnpm --silent --filter @dotobokuri/core-ai-gateway probe:cursor-context -- --all [options]

Options:
  --model <id>       Cursor catalog base, scoped, or upstream model id; repeatable
  --all              Probe every Cursor catalog model (explicit quota-consuming opt-in)
  --mode <mode>      standard, max, or both (default: standard)
  --effort <effort>  low, medium, high, xhigh, max, or ultra
  --timeout-ms <ms>  Positive per-probe timeout in milliseconds (default: 60000)
  --help              Show this help without accessing credentials or the network

Modes are probed sequentially. "both" runs standard and Max Mode once per model.
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

class CredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialError";
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const selections = resolveSelections(options);
  const probeModes = options.mode === "both" ? ["standard", "max"] : [options.mode];
  const accessToken = resolveCursorAccessToken();
  const observedAt = new Date().toISOString();
  const results = [];

  for (const selection of selections) {
    for (const mode of probeModes) {
      process.stderr.write(
        `[cursor-context-probe] probing ${selection.requestedModel} in ${mode} mode\n`,
      );
      const result = await probeCursorContextWindow({
        accessToken,
        effort: options.effort,
        mode,
        selection,
        timeoutMs: options.timeoutMs,
      });
      results.push(result);
      if (result.error) {
        process.stderr.write(
          `[cursor-context-probe] ${selection.requestedModel} (${mode}) failed: ${result.error}\n`,
        );
      }
    }
  }

  process.stdout.write(`${JSON.stringify({ observedAt, results }, null, 2)}\n`);
  if (results.some((result) => result.error)) process.exitCode = 1;
}

function parseArguments(argv) {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const options = {
    all: false,
    effort: null,
    help: false,
    mode: "standard",
    models: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const seen = new Set();

  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const argument = normalizedArgv[index];
    switch (argument) {
      case "--help":
        options.help = true;
        break;
      case "--all":
        options.all = true;
        break;
      case "--model": {
        const value = readOptionValue(normalizedArgv, index, argument);
        options.models.push(value);
        index += 1;
        break;
      }
      case "--mode": {
        rejectDuplicateOption(seen, argument);
        const value = readOptionValue(normalizedArgv, index, argument);
        if (!MODES.has(value)) {
          throw new UsageError(`Unknown mode ${JSON.stringify(value)}; expected standard, max, or both`);
        }
        options.mode = value;
        index += 1;
        break;
      }
      case "--effort": {
        rejectDuplicateOption(seen, argument);
        const value = readOptionValue(normalizedArgv, index, argument);
        if (!EFFORTS.has(value)) {
          throw new UsageError(
            `Unknown effort ${JSON.stringify(value)}; expected low, medium, high, xhigh, max, or ultra`,
          );
        }
        options.effort = value;
        index += 1;
        break;
      }
      case "--timeout-ms": {
        rejectDuplicateOption(seen, argument);
        const value = readOptionValue(normalizedArgv, index, argument);
        if (!/^[1-9]\d*$/.test(value)) {
          throw new UsageError("--timeout-ms must be a positive integer");
        }
        const timeoutMs = Number(value);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs > MAX_TIMEOUT_MS) {
          throw new UsageError(`--timeout-ms must not exceed ${MAX_TIMEOUT_MS}`);
        }
        options.timeoutMs = timeoutMs;
        index += 1;
        break;
      }
      default:
        throw new UsageError(`Unknown argument ${JSON.stringify(argument)}`);
    }
  }

  if (options.help) return options;
  if (options.all === (options.models.length > 0)) {
    throw new UsageError("Select exactly one form: one or more --model values, or --all");
  }
  return options;
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new UsageError(`${option} requires a value`);
  }
  return value;
}

function rejectDuplicateOption(seen, option) {
  if (seen.has(option)) throw new UsageError(`${option} may be provided only once`);
  seen.add(option);
}

function resolveSelections(options) {
  if (options.all) {
    return CURSOR_SUBSCRIPTION_MODELS.map((model) => ({
      model,
      requestedModel: cursorBaseModelId(model),
    }));
  }

  return options.models.map((requestedModel) => {
    const matches = CURSOR_SUBSCRIPTION_MODELS.filter((model) => {
      const baseId = cursorBaseModelId(model);
      const upstreamId = model.upstreamId ?? baseId;
      return requestedModel === baseId
        || requestedModel === model.id
        || requestedModel === upstreamId;
    });
    if (matches.length === 0) {
      throw new UsageError(`Unknown Cursor model ${JSON.stringify(requestedModel)}`);
    }
    if (matches.length > 1) {
      throw new UsageError(`Ambiguous Cursor model ${JSON.stringify(requestedModel)}`);
    }
    return { model: matches[0], requestedModel };
  });
}

function cursorBaseModelId(model) {
  return model.id.startsWith(CURSOR_SCOPE_PREFIX)
    ? model.id.slice(CURSOR_SCOPE_PREFIX.length)
    : model.id;
}

function resolveCursorAccessToken() {
  const environmentToken = process.env.CURSOR_ACCESS_TOKEN?.trim();
  if (environmentToken) return environmentToken;

  if (process.platform === "darwin") {
    try {
      const keychainToken = execFileSync(
        "security",
        [
          "find-generic-password",
          "-s",
          "cursor-access-token",
          "-a",
          "cursor-user",
          "-w",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      if (keychainToken) return keychainToken;
    } catch {
      // Fall through to the credential-safe error below.
    }
  }

  throw new CredentialError(
    "Cursor access token unavailable; set CURSOR_ACCESS_TOKEN or add the macOS Keychain item cursor-access-token/cursor-user",
  );
}

async function probeCursorContextWindow({
  accessToken,
  effort,
  mode,
  selection,
  timeoutMs,
}) {
  const maxMode = mode === "max";
  const controller = new AbortController();
  let checkpoint = null;
  let timeoutTriggered = false;
  let wireModel = null;

  const adapter = new CursorAdapter({
    idleTimeoutMs: timeoutMs,
    maxMode,
    diagnostics: (event) => {
      if (
        wireModel === null
        && event.event === "turn.start"
        && typeof event.wireModel === "string"
        && event.wireModel.length > 0
      ) {
        wireModel = event.wireModel;
      }
      if (
        checkpoint === null
        && event.event === "server.frame"
        && isPositiveInteger(event.contextWindow)
      ) {
        checkpoint = {
          contextTokens: isNonNegativeInteger(event.contextTokens) ? event.contextTokens : null,
          contextWindow: event.contextWindow,
        };
        controller.abort();
      }
    },
  });
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, timeoutMs);

  const baseResult = () => ({
    requestedModel: selection.requestedModel,
    wireModel,
    effort,
    mode,
    maxMode,
    contextTokens: checkpoint?.contextTokens ?? null,
    contextWindow: checkpoint?.contextWindow ?? null,
  });

  try {
    const response = await adapter.stream(
      {
        model: selection.model.id,
        input: [{ type: "message", role: "user", content: "Reply exactly OK." }],
        tools: [],
        max_output_tokens: 16,
        metadata: { user_id: `cursor-context-probe-${randomUUID()}` },
        ...(effort === null ? {} : { reasoning: { summary: "auto", effort } }),
        stream: true,
      },
      { apiKey: accessToken, signal: controller.signal },
    );
    if (!response.ok) {
      return {
        ...baseResult(),
        error: `Cursor returned HTTP status ${response.status} before reporting a context checkpoint`,
      };
    }

    for await (const _event of response.events) {
      // Diagnostics carry the authoritative checkpoint; response events are drained for lifecycle.
    }
    if (checkpoint !== null) return baseResult();
    if (timeoutTriggered) {
      return {
        ...baseResult(),
        error: `Timed out after ${timeoutMs} ms before Cursor reported a context checkpoint`,
      };
    }
    return {
      ...baseResult(),
      error: "Cursor stream ended before reporting a context checkpoint",
    };
  } catch (error) {
    if (checkpoint !== null) return baseResult();
    if (timeoutTriggered) {
      return {
        ...baseResult(),
        error: `Timed out after ${timeoutMs} ms before Cursor reported a context checkpoint`,
      };
    }
    return {
      ...baseResult(),
      error: `Cursor probe failed before reporting a context checkpoint (${safeErrorName(error)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function safeErrorName(error) {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) ? name : "Error";
}

main().catch((error) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\nRun with --help for usage.\n`);
    process.exitCode = 2;
    return;
  }
  if (error instanceof CredentialError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`Cursor context probe failed (${safeErrorName(error)})\n`);
  process.exitCode = 1;
});
