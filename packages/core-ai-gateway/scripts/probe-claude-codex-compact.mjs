#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIRM_LIVE_PROVIDER = "--confirm-live-provider";
const DEFAULT_MODEL = "claude-gateway--codex--gpt-5.6-luna";
const DEFAULT_MODE = "both";
const DEFAULT_TIMEOUT_MS = 300_000;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

const HELP = `Usage: pnpm --filter @dotobokuri/core-ai-gateway probe:claude-codex-compact -- [options] ${CONFIRM_LIVE_PROVIDER}

WARNING: this probe runs the installed Claude Code against the live ChatGPT Codex backend
and spends real Luna quota. Build the package first:
  pnpm --filter @dotobokuri/core-ai-gateway build

Options:
  --mode <mode>            auto|manual|both (default: ${DEFAULT_MODE})
  --model <id>             Exact Codex Luna gateway id (default: ${DEFAULT_MODEL})
  --timeout-ms <count>     Positive per-scenario timeout (default: ${DEFAULT_TIMEOUT_MS})
  --output <path>          Optional JSON result file; stdout always prints the result
  --simulate-compact-failure  Inject a pre-send compact failure and verify Claude fallback
  ${CONFIRM_LIVE_PROVIDER}  Required explicit consent to spend live provider quota
  --help                   Show this help before loading credentials, node-pty, or network code

The probe installs isolated PreCompact/PostCompact hooks, runs a loopback Anthropic
Messages proxy, converts Claude's auto or manual compact turn into the Codex Responses v2
compaction_trigger contract, asks Luna to render the opaque compacted state as Claude's
plain-text handoff summary, and proves the same blob is replayed on the following turn.
Credentials, prompts, summaries, and opaque blobs are never written to the result.
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

class ProbeTimeoutError extends Error {
  constructor(label) {
    super(`${label} timed out`);
    this.name = "ProbeTimeoutError";
  }
}

function parseArguments(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.includes("--help")) return { help: true };
  const options = {
    mode: DEFAULT_MODE,
    model: DEFAULT_MODEL,
    output: undefined,
    simulateCompactFailure: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const seen = new Set();
  let confirmed = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    if (argument === CONFIRM_LIVE_PROVIDER) {
      if (confirmed) throw new UsageError(`${CONFIRM_LIVE_PROVIDER} may be provided only once`);
      confirmed = true;
      continue;
    }
    if (argument === "--simulate-compact-failure") {
      if (options.simulateCompactFailure) throw new UsageError(`${argument} may be provided only once`);
      options.simulateCompactFailure = true;
      continue;
    }
    if (!["--mode", "--model", "--timeout-ms", "--output"].includes(argument)) {
      throw new UsageError(`Unknown argument ${JSON.stringify(argument)}`);
    }
    if (seen.has(argument)) throw new UsageError(`${argument} may be provided only once`);
    seen.add(argument);
    const value = normalized[index + 1];
    if (!value || value.startsWith("--")) throw new UsageError(`${argument} requires a value`);
    index += 1;
    if (argument === "--mode") options.mode = value;
    else if (argument === "--model") options.model = value;
    else if (argument === "--output") options.output = path.resolve(value);
    else options.timeoutMs = positiveInteger(value, argument);
  }
  if (!new Set(["auto", "manual", "both"]).has(options.mode)) {
    throw new UsageError("--mode must be auto, manual, or both");
  }
  if (!/^claude-gateway--codex--gpt-5\.6-luna(?:-(?:low|medium|high|xhigh|max))?$/.test(options.model)) {
    throw new UsageError("--model must be an exact Codex gpt-5.6-luna gateway id");
  }
  if (!confirmed) throw new UsageError(`missing required ${CONFIRM_LIVE_PROVIDER}`);
  return options;
}

function positiveInteger(value, option) {
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`${option} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`${option} must be a safe positive integer`);
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - startedAt >= timeoutMs) return reject(new ProbeTimeoutError(label));
      setTimeout(check, 50);
    };
    check();
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function removeClaudeSessionArtifacts(sessionId) {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  let projectEntries;
  try {
    projectEntries = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(projectEntries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const projectDir = path.join(projectsDir, entry.name);
      let entries;
      try {
        entries = await readdir(projectDir, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      await Promise.all(entries
        .filter((candidate) => candidate.name === `${sessionId}.jsonl` || candidate.name === sessionId)
        .map((candidate) => rm(path.join(projectDir, candidate.name), { recursive: true, force: true })));
    }));
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Stable semantic fingerprint for a redraw-heavy ANSI terminal tail. */
function terminalFingerprint(value) {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[^A-Za-z0-9?+/]/g, "")
    .toLowerCase();
}

async function createIsolatedClaudeEnvironment(options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet-claude-codex-compact-"));
  const homeDir = path.join(directory, "home");
  const configDir = path.join(homeDir, ".claude");
  const settingsPath = path.join(directory, "settings.json");
  const hookPath = path.join(directory, "compact-hook.mjs");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const hookSource = `let text = "";\nfor await (const chunk of process.stdin) text += chunk;\nconst input = JSON.parse(text);\nconst response = await fetch(process.env.FLEET_COMPACT_PROBE_HOOK_URL, {\n  method: "POST",\n  headers: {"content-type":"application/json","x-probe-token":process.env.FLEET_COMPACT_PROBE_TOKEN,"x-fleet-compact-token":process.env.FLEET_COMPACT_PROBE_TOKEN},\n  body: JSON.stringify(input),\n});\nif (!response.ok) process.exitCode = 1;\n`;
  await writeFile(hookPath, hookSource, { mode: 0o700 });
  const canonicalDirectory = await realpath(directory);
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const projectState = {
    allowedTools: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
  };
  await writeFile(path.join(homeDir, ".claude.json"), JSON.stringify({
    numStartups: 1,
    installMethod: "native",
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.251",
    customApiKeyResponses: { approved: ["sk-ant-fleet-compact-probe"], rejected: [] },
    projects: {
      [directory]: projectState,
      [canonicalDirectory]: projectState,
      [repositoryRoot]: projectState,
      [canonicalRepositoryRoot]: projectState,
    },
  }), { mode: 0o600 });
  await writeFile(settingsPath, JSON.stringify({
    hooks: {
      PreCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)}`, timeout: 30 }] }],
      PostCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)}`, timeout: 30 }] }],
    },
    permissions: { defaultMode: "dontAsk" },
  }), { mode: 0o600 });
  return { directory, homeDir, configDir, settingsPath };
}

function claudeEnvironment(base, isolated, hookUrl, hookToken) {
  const env = { ...base };
  for (const name of [
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
    "CLAUDE_CODE_AUTO_COMPACT",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_DISABLE_1M_CONTEXT",
    "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    "INIT_CWD",
  ]) delete env[name];
  Object.assign(env, {
    ANTHROPIC_API_KEY: "sk-ant-fleet-compact-probe",
    HOME: isolated.homeDir,
    CLAUDE_CONFIG_DIR: isolated.configDir,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
    FLEET_COMPACT_PROBE_HOOK_URL: hookUrl,
    FLEET_COMPACT_PROBE_TOKEN: hookToken,
  });
  return env;
}

async function createProbeRuntime(gateway, options, trigger) {
  const { createProductProbeRuntime } = await import("./probe-claude-codex-product-runtime.mjs");
  return createProductProbeRuntime(gateway, options, trigger);
}

async function runAutoScenario(gateway, options) {
  const runtime = await createProbeRuntime(gateway, options, "auto");
  const isolated = await createIsolatedClaudeEnvironment(options);
  const sessionId = randomUUID();
  const canary = `AUTO-${randomUUID().slice(0, 8).toUpperCase()}`;
  runtime.setExpectedCanary(canary);
  const hookUrl = `http://127.0.0.1:${runtime.port}/v1/compact-events`;
  const env = claudeEnvironment(process.env, isolated, hookUrl, runtime.hookToken);
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${runtime.port}`;
  const outputEvents = [];
  let child;
  let timedOut = false;
  try {
    child = spawn("claude", [
      "--print",
      "--model", options.model,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-hook-events",
      "--session-id", sessionId,
      "--tools", "",
      "--settings", isolated.settingsPath,
      "--setting-sources", "user",
      "--autocompact", "auto",
    ], { cwd: isolated.directory, env, stdio: ["pipe", "pipe", "pipe"] });
    const prompts = [
      `Remember the exact canary MODEL_CANARY=${canary}. Reply exactly STORED_AUTO.`,
      `The durable session state is MODEL_CANARY=${canary}; preserve it across any context compaction. FLEET_PRESSURE_CHECKPOINT. Reply exactly PRESSURE_READY.`,
      "Continue after the pressure checkpoint. Reply exactly AFTER_AUTO_COMPACT.",
      "Reply exactly RECALL_AUTO=<the exact MODEL_CANARY value from before compaction>.",
    ];
    let sent = 0;
    const sendNext = () => {
      const content = prompts[sent++];
      if (content === undefined) child.stdin.end();
      else child.stdin.write(`${JSON.stringify({ type: "user", session_id: sessionId, message: { role: "user", content } })}\n`);
    };
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          outputEvents.push(event);
          if (event.type === "result") sendNext();
        } catch { /* stream-json 외 진단 텍스트는 판정에 쓰지 않는다. */ }
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
    const statuses = outputEvents.filter((event) => event.type === "system" && event.subtype === "status");
    const resultText = outputEvents.filter((event) => event.type === "result").map((event) => String(event.result ?? "")).join("\n");
    const compactPathSucceeded = options.simulateCompactFailure
      ? runtime.diagnostics.some((event) => event.event === "openai_compact_failure_injected")
        && runtime.diagnostics.some((event) => event.event === "claude_summary_fallback")
        && runtime.diagnostics.some(
          (event) => event.event === "claude_fallback_summary_rendered" && event.containsCanary,
        )
        && !runtime.diagnostics.some((event) => event.event === "openai_compact_completed")
      : runtime.diagnostics.some((event) => event.event === "openai_compact_completed")
        && runtime.diagnostics.some((event) => event.event === "openai_compaction_replayed" && event.outputContainsCanary);
    const success = !timedOut
      && exit.code === 0
      && statuses.some((event) => event.status === "compacting")
      && statuses.some((event) => event.compact_result === "success")
      && runtime.diagnostics.some((event) => event.event === "pre_compact_hook" && event.trigger === "auto")
      && runtime.diagnostics.some((event) => event.event === "post_compact_hook" && event.trigger === "auto")
      && compactPathSucceeded
      && resultText.includes(canary);
    return {
      mode: "auto",
      success,
      claudeCodeVersion: outputEvents.find((event) => event.type === "system" && event.subtype === "init")?.claude_code_version ?? null,
      timedOut,
      exit,
      compactingObserved: statuses.some((event) => event.status === "compacting"),
      compactResult: statuses.findLast((event) => Object.hasOwn(event, "compact_result"))?.compact_result ?? null,
      resultContainsCanary: resultText.includes(canary),
      stderrPresent: stderr.trim().length > 0,
      diagnostics: runtime.diagnostics,
    };
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    await runtime.close();
    await rm(isolated.directory, { recursive: true, force: true });
  }
}

async function runManualScenario(gateway, options) {
  const runtime = await createProbeRuntime(gateway, options, "manual");
  const isolated = await createIsolatedClaudeEnvironment(options);
  const canary = `MANUAL-${randomUUID().slice(0, 8).toUpperCase()}`;
  const manualDirective = `DIRECTIVE-${randomUUID().slice(0, 8).toUpperCase()}`;
  runtime.setExpectedCanary(canary);
  runtime.setExpectedManualDirective(manualDirective);
  const hookUrl = `http://127.0.0.1:${runtime.port}/v1/compact-events`;
  const env = claudeEnvironment(process.env, isolated, hookUrl, runtime.hookToken);
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${runtime.port}`;
  // Manual slash commands require the interactive TUI. Reuse only the real Claude
  // installation's onboarding/auth state; config, hooks, transcript and provider routing
  // remain isolated, and the caller credential terminates at this loopback proxy.
  env.HOME = os.homedir();
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const sessionId = randomUUID();
  const require = createRequire(path.join(repositoryRoot, "runtime/fleet-console/package.json"));
  const nodePty = require("node-pty");
  let pty;
  let terminalBytes = 0;
  let terminalTail = "";
  let lastTerminalDataAt = Date.now();
  let exited = false;
  try {
    pty = nodePty.spawn("claude", [
      "--model", options.model,
      "--tools", "",
      "--permission-mode", "dontAsk",
      "--settings", isolated.settingsPath,
      "--setting-sources", "",
      "--session-id", sessionId,
      "--autocompact", "auto",
    ], {
      cols: 120,
      rows: 40,
      cwd: repositoryRoot,
      env,
      name: "xterm-256color",
    });
    pty.onData((data) => {
      terminalBytes += Buffer.byteLength(data);
      terminalTail = (terminalTail + data).slice(-16_384);
      lastTerminalDataAt = Date.now();
    });
    const exitPromise = new Promise((resolve) => pty.onExit((event) => {
      exited = true;
      resolve({ code: event.exitCode, signal: event.signal });
    }));
    const composerReady = () => {
      const fingerprint = terminalFingerprint(terminalTail);
      return fingerprint.includes("?forshortcuts")
        || fingerprint.includes("shift+tabtocycle")
        || fingerprint.includes("bypasspermissionson")
        || fingerprint.includes("howcanclaudehelpyou");
    };
    const submitInteractiveText = async (text, expectedKind, label) => {
      const hasExpectedIngress = () => runtime.diagnostics.some(
        (event) => event.event === "anthropic_request" && event.kind === expectedKind,
      );
      pty.write("\x15");
      pty.write(`${text}\r`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!hasExpectedIngress()) pty.write("\r");
      await waitFor(hasExpectedIngress, 30_000, label);
    };
    await waitFor(composerReady, 30_000, "manual Claude TUI readiness");
    await submitInteractiveText(
      `Remember the exact canary MODEL_CANARY=${canary}. Reply exactly STORED_MANUAL.`,
      "initial",
      "manual initial ingress",
    );
    await waitFor(
      () => runtime.diagnostics.filter((event) => event.event === "openai_turn_completed" && event.kind === "initial").length >= 1,
      options.timeoutMs,
      "manual initial turn",
    );
    await waitFor(() => Date.now() - lastTerminalDataAt >= 1_000, 30_000, "manual initial composer settle");
    await submitInteractiveText(
      `The durable session state is MODEL_CANARY=${canary}; preserve it across manual compaction. Reply exactly MANUAL_READY.`,
      "boundary",
      "manual boundary ingress",
    );
    await waitFor(
      () => runtime.diagnostics.some((event) => event.event === "openai_turn_completed" && event.kind === "boundary"),
      options.timeoutMs,
      "manual boundary turn",
    );
    await waitFor(() => Date.now() - lastTerminalDataAt >= 1_000, 30_000, "manual boundary composer settle");
    pty.write("\x15");
    pty.write("/compact");
    await waitFor(
      () => terminalFingerprint(terminalTail).includes("freeupcontextbysummarizingtheconversationsofar"),
      10_000,
      "manual compact completion menu",
    );
    pty.write(" ");
    await new Promise((resolve) => setTimeout(resolve, 300));
    pty.write(`Preserve MODEL_CANARY=${canary} exactly, preserve the current task state, and preserve ${manualDirective}.`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    pty.write("\r");
    await waitFor(
      () => runtime.diagnostics.some((event) => event.event === "pre_compact_hook" && event.trigger === "manual"),
      30_000,
      "manual PreCompact hook",
    );
    await waitFor(
      () => runtime.diagnostics.some((event) => event.event === "post_compact_hook" && event.trigger === "manual"),
      options.timeoutMs,
      "manual PostCompact hook",
    );
    await waitFor(() => Date.now() - lastTerminalDataAt >= 1_000, 30_000, "manual post-compact composer settle");
    await submitInteractiveText(
      "Reply exactly RECALL_MANUAL=<the exact MODEL_CANARY value> DIRECTIVE=<the exact DIRECTIVE value from the compact instructions>.",
      "recall",
      "manual recall ingress",
    );
    await waitFor(
      () => runtime.diagnostics.some((event) => event.event === "openai_compaction_replayed" && event.outputContainsCanary),
      options.timeoutMs,
      "manual compact replay",
    );
    pty.write("/exit\r");
    const exit = await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "timeout" }), 10_000)),
    ]);
    if (!exited) pty.kill();
    const compactPathSucceeded = options.simulateCompactFailure
      ? runtime.diagnostics.some((event) => event.event === "openai_compact_failure_injected")
        && runtime.diagnostics.some((event) => event.event === "claude_summary_fallback")
        && runtime.diagnostics.some(
          (event) => event.event === "claude_fallback_summary_rendered" && event.containsCanary,
        )
        && !runtime.diagnostics.some((event) => event.event === "openai_compact_completed")
      : runtime.diagnostics.some(
          (event) => event.event === "openai_compact_request" && event.customInstructionsApplied,
        )
        && runtime.diagnostics.some((event) => event.event === "openai_compact_completed")
        && runtime.diagnostics.some(
          (event) => event.event === "openai_compaction_replayed"
            && event.outputContainsCanary
            && event.outputContainsManualDirective,
        );
    const success = runtime.diagnostics.some(
      (event) => event.event === "pre_compact_hook"
        && event.trigger === "manual"
        && event.customInstructionsPresent,
    )
      && runtime.diagnostics.some((event) => event.event === "post_compact_hook" && event.trigger === "manual")
      && compactPathSucceeded;
    return {
      mode: "manual",
      success,
      exit,
      terminalBytes,
      terminalTailSha256: sha256(terminalTail),
      diagnostics: runtime.diagnostics,
    };
  } catch (error) {
    if (process.env.FLEET_COMPACT_PROBE_TUI_LOG) {
      await writeFile(path.resolve(process.env.FLEET_COMPACT_PROBE_TUI_LOG), terminalTail, { mode: 0o600 });
    }
    const recentDiagnostics = runtime.diagnostics.slice(-20);
    const diagnostic = new Error(`${error instanceof Error ? error.message : String(error)}; terminalTailSha256=${sha256(terminalTail)}; terminalBytes=${terminalBytes}; recentDiagnostics=${JSON.stringify(recentDiagnostics)}`);
    diagnostic.name = error instanceof Error ? error.name : "Error";
    throw diagnostic;
  } finally {
    if (pty && !exited) {
      try { pty.kill(); } catch { /* 이미 종료된 PTY다. */ }
    }
    await runtime.close();
    await removeClaudeSessionArtifacts(sessionId);
    await rm(isolated.directory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const gateway = await import("../dist/index.js");
  const scenarios = [];
  if (options.mode === "auto" || options.mode === "both") {
    scenarios.push(await runAutoScenario(gateway, options));
  }
  if (options.mode === "manual" || options.mode === "both") {
    scenarios.push(await runManualScenario(gateway, options));
  }
  const result = {
    observedAt: new Date().toISOString(),
    model: options.model,
    provider: "codex",
    compactContract: "responses-v2-compaction-trigger",
    simulatedCompactFailure: options.simulateCompactFailure,
    legacyCompactEndpointExpected: false,
    successful: scenarios.every((scenario) => scenario.success),
    scenarios,
  };
  const serialized = `${JSON.stringify(result)}\n`;
  if (options.output) await writeFile(options.output, serialized, { mode: 0o600 });
  process.stdout.write(serialized);
  if (!result.successful) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`claude-codex compact probe failed: ${JSON.stringify(safeError(error))}\n`);
    process.exitCode = 1;
  }
}
