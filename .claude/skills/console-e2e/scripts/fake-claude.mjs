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
//   fault            one-shot failure for the next SDK child of this directory: JSON {mode, exitCode?, onlyOnResume?, nonstandard?}
//   fault-<sessionId>   the same spec scoped to this launch's --session-id/--resume and tried first; another launch's file is left in place
//                    mode "exit-on-spawn" exits at child start and "exit-mid-turn" at the first host turn (exitCode, default 1);
//                    "result-error" and "compact-failed-error" answer that turn with an error result carrying a valid errors
//                    array (a string instead when nonstandard is true), and a compact failure also reports compact_result
//                    "failed". onlyOnResume: true skips a non-resume launch without consuming the file, then tries the
//                    next candidate. A spec is selected once and deleted at child start; it governs that child's lifetime.
//                    Later host turns are logged but unanswered, and ask/wake/sdk-calls stay unconsumed. Each new SDK child
//                    selects again. An unreadable, unconsumable, malformed or unknown spec is a fixture setup failure:
//                    stderr, exit 2, file kept.
//   sdk-mcp/tools-<pid>.json  written by every SDK launch the host gave in-process MCP servers (Commodore's fleet-commodore):
//                    each server's advertised tools with description and inputSchema (field limits included)
//   sdk-calls        one-shot in-process tool calls on the next turn: {"sessionId"?: string, "calls": [{"server", "tool", "args"?}]};
//                    taken only by a launch holding every named server (log `sdk-calls-skipped` otherwise)
//   sdk-calls-<sessionId>  same, scoped to this launch's --session-id/--resume
//   reply.md            one-shot chat reply for the next turn in this directory, streamed then consumed
//   reply-<sessionId>.md  same, scoped to this launch; tried before reply.md. Empty files are discarded.
//                    FAKE_CLAUDE_REPLIES wins when it matches; otherwise reply.md, else the fixed canned reply.
//   sdk-mcp/calls-<ts>-<pid>.json  each call's args, isError, error code and full JSON-RPC result (mode 0600)
// FAKE_CLAUDE_VERSION (optional): the --version answer (default "2.1.999 (Claude Code)").
// FAKE_CLAUDE_TOOLS (optional): JSON array of tool names advertised in init.tools (default []).
// FAKE_CLAUDE_MODELS (optional): JSON array of rows ({value, resolvedModel, displayName, supportedEffortLevels}) returned verbatim as
//   initialize.models (default []). Synthetic lineup, not evidence of what the real CLI supports.
// FAKE_CLAUDE_REPLIES (optional): directory of best-effort one-shot reply fixtures; <sessionId>.md, then
//   <model-prefix>.md (model id up to "["). Unset or no match falls through to reply.md, then the fixed reply.
// FAKE_CLAUDE_STRUCTURED_OUTPUT (optional): JSON value (any type) returned as result.structured_output on the normal turn
//   result, only for launches given --json-schema (or --json-schema=...). Repeats on every such turn (not consumed, unlike
//   REPLIES); no schema validation. Unset, unparsable (log `structured-output-config-ignored`) or a launch without
//   --json-schema leaves the field absent; this is not a fake failure. Synthetic output is not model judgment and not
//   evidence of real CLI schema handling.
//
// Sign-in fixture (`auth` argv). Opt-in: it is active only when FAKE_CLAUDE_AUTH_MODE is set (success|fail|unconfirmed|no-url).
//   Without it `auth ...` keeps its earlier behavior, so a CLAUDE_BIN-only fixture is never turned into a signed-out CLI.
//   Active, the only accepted forms are exactly `auth login` and `auth status --json`; anything else exits 2 and only its
//   reason is logged, never the raw argv or mode. Synthetic state only: no child process, network, browser, Keychain, model or account.
//   Each FAKE_CLAUDE_DIR owns its own state, so two directories never share a sign-in, and removing the directory
//   removes the state. It starts signed out. Success here means "the fake received a code-shaped input and its own
//   auth status now answers loggedIn"; it is not a real sign-in and not equivalence with the real CLI.
//   auth-state.json  {loggedIn: boolean}; absent = signed out. `auth status --json` prints {loggedIn, authMethod} and
//                    exits 0 when signed in, 1 when not (like the real CLI; read loggedIn, not the exit code).
//   mode             FAKE_CLAUDE_AUTH_MODE (required to opt in); a one-word <FAKE_CLAUDE_DIR>/auth-mode file overrides it per run:
//                      success     a code-shaped input signs the fake in and `auth login` exits 0
//                      fail        a code-shaped input exits 1 and the state stays signed out
//                      unconfirmed a code-shaped input exits 0 but the state stays signed out (status says loggedIn false)
//                      no-url      `auth login` never prints a login page (start failure) and waits until signalled
//   `auth login` prints a synthetic login page URL after "visit:" and waits. Before any input it is pending and the
//   state is unchanged. A line is code-shaped when it matches `<non-space, no #>#<non-space, no #>`; other lines get a
//   message on stderr and keep waiting. The input value is never stored or logged (log.jsonl records only
//   {event:"auth-input", shape:"ok"}). SIGINT/SIGTERM is a cancel: log {event:"auth-signal"}, exit 0, state unchanged
//   (a piped SIGINT exits 0 on the real CLI too, so a cancel must never be read as a sign-in). stdin EOF before input exits 1.
//   The login page is the fixed value below. It passes the product's Anthropic https allowlist and is only printed, never
//   opened or fetched. log.jsonl gets {event:"auth-launch", argv}, auth-rejected {reason}, auth-status, auth-input, auth-signal, auth-exit.
//   Owned state only: FAKE_CLAUDE_DIR must be an absolute path that is not the user's home, an ancestor of it, or inside
//   a `~/.claude*` or `~/.config` tree, or the branch exits 2 before reading or writing anything. The lexical path and the
//   realpath of its nearest existing ancestor are both checked, so a symlink in the middle of the path does not hide a protected
//   location (best effort; a path swapped after the check is not covered). The only file it writes
//   is <FAKE_CLAUDE_DIR>/auth-state.json (plus log.jsonl). Use a per-objective directory or the isolated Console's own;
//   this is an owned slot, not a sandbox: a symlinked directory or state/log/mode file is refused (exit 2), nothing more is claimed.
//   Without FAKE_CLAUDE_AUTH_MODE, none of the auth state, guard or modes above exist.
//   Reuse scope: the argv, code shape, URL line and exit-code semantics mirror the unit-test fake
//   runtime/fleet-console/features/ai-gateway/runtime/tests/fixtures/fake-claude-cli.mjs, which stays unchanged and
//   keeps owning product unit tests. This branch only adds directory-owned state, modes and the argv guard.
//   Safe check (runs the product adapter against this file with a guarded executor, no real CLI/Keychain/browser/network):
//     pnpm --filter @dotobokuri/fleet-console exec vitest run tests/execution/claude-auth-fixture.test.ts
//   Not executed or verified here, so never claim them from this fixture: the deployed host's executable fallback to the
//   bundled CLI when no CLI is found (start.ts), its post-sign-in Quota refresh (any provider, outside this fixture), the
//   real credential store/Keychain, the host browser opener, external URLs, and any model or account call. With CLAUDE_BIN
//   absent, observe the UI state only: pressing Sign in there can launch the bundled CLI. An injected resolver returning
//   undefined (spawn 0 times) is covered only by the unit test above, not by the deployed host.
//
// Modes: `--version`; `auth ...` (above); chat/SDK when `--input-format stream-json`; otherwise an interactive terminal
// that prints a banner and echoes input until SIGTERM/SIGHUP.
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
// The sign-in fixture is opt-in: only an explicit FAKE_CLAUDE_AUTH_MODE turns `auth ...` into it. Without it `auth` argv
// behaves exactly as before (no auth state, nothing answered as signed out), so existing CLAUDE_BIN-only fixtures keep working.
const authFixture = args[0] === "auth" && Boolean(process.env.FAKE_CLAUDE_AUTH_MODE);
if (!authFixture && args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION || "2.1.999 (Claude Code)"}\n`);
  process.exit(0);
}

const dir = process.env.FAKE_CLAUDE_DIR;
if (!dir) {
  process.stderr.write("fake-claude: FAKE_CLAUDE_DIR is required\n");
  process.exit(2);
}
if (authFixture) {
  const AUTH_LOGIN_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=synthetic-fixture&state=synthetic-fixture";
  // Owned-directory guard first: nothing is created, read or logged in a directory that fails it. Both the process HOME
  // (an isolated Console overrides it) and the account's real home count.
  // Best effort, not OS isolation: the lexical path and the realpath of its nearest existing ancestor (so a symlink in the
  // middle of the path cannot hide a protected location) are both checked against each home and its realpath. A path swapped
  // after this check is not covered.
  const realish = (target) => {
    const rest = [];
    let current = resolve(target);
    for (;;) {
      try {
        return join(realpathSync(current), ...rest.reverse());
      } catch {
        const up = dirname(current);
        if (up === current) return resolve(target);
        rest.push(basename(current));
        current = up;
      }
    }
  };
  const homes = [...new Set([homedir(), userInfo().homedir].flatMap((home) => [resolve(home), realish(home)]))];
  const candidates = [...new Set([resolve(dir), realish(dir)])];
  const owned = isAbsolute(dir) && candidates.every((candidate) => homes.every((home) => {
    const to = relative(candidate, home);
    const from = relative(home, candidate).split(sep).join("/");
    const isHomeOrAncestor = !to.startsWith("..") && !isAbsolute(to);
    const inTree = !from.startsWith("..") && !isAbsolute(from) && (from.startsWith(".claude") || /^\.config(\/|$)/.test(from));
    return !isHomeOrAncestor && !inTree;
  }));
  if (!owned) {
    process.stderr.write("fake-claude: FAKE_CLAUDE_DIR must be an owned directory outside the home and its Claude/config trees\n");
    process.exit(2);
  }
  // Owned slot, not a sandbox: refuse a directory or state/log/mode file that is a symlink, so the fixture never follows one out.
  const isLink = (file) => { try { return lstatSync(file).isSymbolicLink(); } catch { return false; } };
  const refuse = (what) => {
    process.stderr.write(`fake-claude: ${what} must not be a symlink\n`);
    process.exit(2);
  };
  if (isLink(dir)) refuse("FAKE_CLAUDE_DIR");
  mkdirSync(dir, { recursive: true });
  for (const name of ["log.jsonl", "auth-state.json", "auth-mode"]) if (isLink(join(dir, name))) refuse(name);
  const authLog = (entry) => appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
  const authExit = (code, reason) => {
    authLog({ event: "auth-exit", code, reason });
    process.exit(code);
  };
  const stateFile = join(dir, "auth-state.json");
  const loggedIn = () => {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8"))?.loggedIn === true;
    } catch {
      return false;
    }
  };
  const mode = (() => {
    try {
      const fromFile = readFileSync(join(dir, "auth-mode"), "utf8").trim();
      if (fromFile) return fromFile;
    } catch {}
    return process.env.FAKE_CLAUDE_AUTH_MODE;
  })();
  const isLogin = args.length === 2 && args[1] === "login";
  const isStatus = args.length === 3 && args[1] === "status" && args[2] === "--json";
  if (!isLogin && !isStatus) {
    authLog({ event: "auth-rejected", reason: "argv" });
    process.stderr.write("fake-claude: only `auth login` and `auth status --json` are accepted\n");
    process.exit(2);
  }
  if (!["success", "fail", "unconfirmed", "no-url"].includes(mode)) {
    authLog({ event: "auth-rejected", reason: "mode" });
    process.stderr.write("fake-claude: unknown auth mode\n");
    process.exit(2);
  }
  authLog({ event: "auth-launch", argv: isLogin ? "auth login" : "auth status --json" });
  if (isStatus) {
    const signedIn = loggedIn();
    authLog({ event: "auth-status", loggedIn: signedIn });
    process.stdout.write(`${JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? "claude.ai" : "none" })}\n`);
    authExit(signedIn ? 0 : 1, "status");
  }
  const cancel = (signal) => {
    authLog({ event: "auth-signal", signal });
    authExit(0, signal);
  };
  process.on("SIGINT", () => cancel("SIGINT"));
  process.on("SIGTERM", () => cancel("SIGTERM"));
  process.stdout.write("Opening browser to sign in…\n");
  if (mode === "no-url") {
    setInterval(() => {}, 1 << 30);
  } else {
    process.stdout.write(`If the browser didn't open, visit: \u001b]8;;${AUTH_LOGIN_URL}\u001b\\${AUTH_LOGIN_URL}\u001b]8;;\u001b\\\n`);
    process.stdout.write("Paste code here if prompted > ");
    const lines = createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      if (!/^[^\s#]+#[^\s#]+$/.test(line)) {
        process.stderr.write("That doesn't look like the full code.\n");
        return;
      }
      authLog({ event: "auth-input", shape: "ok" });
      if (mode === "success") writeFileSync(stateFile, `${JSON.stringify({ loggedIn: true })}\n`);
      authExit(mode === "fail" ? 1 : 0, mode);
    });
    lines.on("close", () => authExit(1, "stdin-closed"));
  }
  // Only signals, a code-shaped input or stdin EOF leave this branch; keep the module from falling into the chat/terminal paths.
  await new Promise(() => {});
}
mkdirSync(join(dir, "mcp"), { recursive: true });
const log = (entry) => appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
// Configured init.tools: a JSON array only; unset or unparsable advertises [] as before.
const configuredTools = (() => {
  const raw = process.env.FAKE_CLAUDE_TOOLS;
  if (raw === undefined || raw === "") return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) {
      log({ event: "tools-config-ignored", reason: "not-array" });
      return [];
    }
    return value.filter((name) => typeof name === "string");
  } catch (error) {
    log({ event: "tools-config-ignored", reason: String(error?.message ?? error) });
    return [];
  }
})();
// Configured initialize.models: a JSON array only; unset or unparsable answers [] as before.
const configuredModels = (() => {
  const raw = process.env.FAKE_CLAUDE_MODELS;
  if (raw === undefined || raw === "") return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) {
      log({ event: "models-config-ignored", reason: "not-array" });
      return [];
    }
    return value;
  } catch (error) {
    log({ event: "models-config-ignored", reason: String(error?.message ?? error) });
    return [];
  }
})();
const structuredOutput = (() => {
  const raw = process.env.FAKE_CLAUDE_STRUCTURED_OUTPUT;
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    log({ event: "structured-output-config-ignored", reason: String(error?.message ?? error) });
    return undefined;
  }
})();
// Best-effort one-shot reply fixtures under FAKE_CLAUDE_REPLIES; null (unset) keeps the fixed canned reply.
const repliesDir = process.env.FAKE_CLAUDE_REPLIES || null;
const readScriptedReply = (sessionId, turnModel) => {
  if (!repliesDir) return null;
  const role = String(turnModel).replace(/\[.*$/, "");
  for (const name of [`${sessionId}.md`, `${role}.md`]) {
    const file = join(repliesDir, name);
    try {
      const text = readFileSync(file, "utf8");
      try { unlinkSync(file); } catch {}
      log({ event: "scripted-reply", sessionId, file: name });
      return text;
    } catch (error) {
      if (error.code !== "ENOENT") log({ event: "reply-file-error", sessionId, file: name, error: String(error?.message ?? error) });
    }
  }
  return null;
};
// One-shot reply in FAKE_CLAUDE_DIR. Same stream path as FAKE_CLAUDE_REPLIES, so the host records the text.
const readDirReply = (sessionId) => {
  for (const name of [`reply-${sessionId}.md`, "reply.md"]) {
    const file = join(dir, name);
    try {
      const text = readFileSync(file, "utf8");
      try { unlinkSync(file); } catch {}
      if (!text.trim()) continue;
      log({ event: "scripted-reply", sessionId, file: name });
      return text;
    } catch (error) {
      if (error.code !== "ENOENT") log({ event: "reply-file-error", sessionId, file: name, error: String(error?.message ?? error) });
    }
  }
  return null;
};
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

const withStructured = structuredOutput !== undefined && argAfter("--json-schema") !== undefined;
const sdk = argAfter("--input-format") === "stream-json";
let model = argAfter("--model") ?? "default";
const sessionIdArg = argAfter("--session-id") ?? null;
const resumeArg = argAfter("--resume") ?? null;
const sessionId = sessionIdArg ?? resumeArg ?? randomUUID();
log({
  event: "launch",
  mode: sdk ? "sdk" : "terminal",
  cwd: process.cwd(),
  model,
  sessionIdArg,
  resume: resumeArg,
  mcpServers,
  // Flag names only: values and positional arguments (the launch prompt, inline settings) can hold sensitive input.
  // A prompt can itself start with "--", so keep only tokens shaped like a bare option name.
  flags: args.map((value) => value.split("=")[0]).filter((name) => /^--[a-z][a-z0-9-]*$/.test(name)).slice(0, 80),
});
// Failure fixture: one spec per SDK child, selected and deleted at child start; later file changes cannot affect it.
// Each new SDK child selects again. Terminal launches never select or consume one.
const fault = (() => {
  if (!sdk) return null;
  const fail = (file, reason) => {
    log({ event: "fault-config-error", file, reason });
    process.stderr.write(`fake-claude: invalid fault spec ${file}: ${reason}\n`);
    process.exit(2);
  };
  for (const name of [`fault-${sessionId}`, "fault"]) {
    const file = join(dir, name);
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      fail(name, "unreadable");
    }
    let spec;
    try {
      spec = JSON.parse(raw);
    } catch {
      fail(name, "not JSON");
    }
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) fail(name, "not an object");
    const allowed = ["mode", "exitCode", "onlyOnResume", "nonstandard"];
    if (Object.keys(spec).some((key) => !allowed.includes(key))) fail(name, "unknown option");
    if (!["exit-on-spawn", "exit-mid-turn", "result-error", "compact-failed-error"].includes(spec.mode)) fail(name, "unknown mode");
    const exitMode = spec.mode === "exit-on-spawn" || spec.mode === "exit-mid-turn";
    if (spec.exitCode !== undefined && (!exitMode || !Number.isInteger(spec.exitCode) || spec.exitCode < 0 || spec.exitCode > 255)) fail(name, "bad exitCode");
    if (spec.nonstandard !== undefined && (exitMode || typeof spec.nonstandard !== "boolean")) fail(name, "bad nonstandard");
    if (spec.onlyOnResume !== undefined && typeof spec.onlyOnResume !== "boolean") fail(name, "bad onlyOnResume");
    if (spec.onlyOnResume === true && !resumeArg) continue;
    try {
      unlinkSync(file);
    } catch {
      // An unconsumed spec could run again on a later child, so setup fails instead of injecting it.
      fail(name, "not consumable");
    }
    log({ event: "fault-launch", file: name, mode: spec.mode, exitCode: spec.exitCode ?? null, sessionId, sessionIdArg, resume: resumeArg });
    return spec;
  }
  return null;
})();
if (fault?.mode === "exit-on-spawn") {
  log({ event: "fault-exit", reason: "exit-on-spawn", code: fault.exitCode ?? 1 });
  process.exit(fault.exitCode ?? 1);
}
let abortAsk = () => {};
// Observable queue snapshot for exit logging; wired to the SDK turn queue below (terminal mode stays null).
const pendingState = { queue: null, isTurnOpen: () => false };
const exit = (reason) => {
  abortAsk(reason);
  const queue = pendingState.queue;
  const queueDepth = queue ? queue.length : 0;
  const queuedChars = queue ? queue.reduce((total, text) => total + (typeof text === "string" ? text.length : 0), 0) : 0;
  log({ event: "exit", reason, turnOpen: pendingState.isTurnOpen(), queueDepth, queuedChars });
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
  pendingState.queue = queue;
  pendingState.isTurnOpen = () => turnOpen;
  // Dequeue helper: records the consume moment; the following turn-start marks processing.
  const takeNext = () => {
    const next = queue.shift();
    if (next !== undefined) log({ event: "turn-dequeue", sessionId, chars: next.length, queueDepth: queue.length });
    return next;
  };
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

  // hostStarted is false for the idle ask hold the fake opens itself; SDK call plans wait for a host-started turn.
  const emitInit = () => {
    if (inited) return;
    out({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd(), tools: configuredTools, mcp_servers: [...mcpServers.map(({ name }) => name), ...sdkServers].map((name) => ({ name, status: "connected" })), permissionMode: "default", slash_commands: [], apiKeySource: "none", claude_code_version: "2.1.999", output_style: "default", agents: [], skills: [], plugins: [], uuid: randomUUID() });
    inited = true;
  };
  let faultFired = false;
  // The first host-started turn answers with the injected failure; later host turns are not answered.
  const runFaultTurn = async () => {
    turnOpen = true;
    turnAborted = false;
    log({ event: "turn-start", model, faultMode: fault.mode });
    emitInit();
    const tokens = ctx();
    const usage = { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
    if (fault.mode === "exit-mid-turn") {
      log({ event: "fault-exit", reason: "exit-mid-turn", code: fault.exitCode ?? 1 });
      process.exit(fault.exitCode ?? 1);
    }
    if (fault.mode === "compact-failed-error") {
      out({ type: "system", subtype: "status", compact_result: "failed", ...envelope() });
      log({ event: "fault-emit", phase: "compact-failed", sessionId });
    }
    const errorText = "fake turn error";
    out({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: errorText, errors: fault.nonstandard === true ? errorText : [errorText], stop_reason: null, session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID() });
    log({ event: "fault-emit", phase: "result-error", sessionId, nonstandard: fault.nonstandard === true });
    log({ event: "turn-end", model, error: "fault" });
    turnOpen = false;
    if (stdinEnded) exit("stdin-end");
  };

  // The fault branch runs before takeAsk() so an injected child consumes no ask fixture.
  const runTurn = async (text, ask, hostStarted = true) => {
    if (fault && hostStarted && !faultFired) {
      faultFired = true;
      await runFaultTurn();
      return;
    }
    const shouldAsk = ask === undefined ? takeAsk() : ask;
    turnOpen = true;
    turnAborted = false;
    const turnModel = model;
    log({ event: "turn-start", model: turnModel, chars: text.length });
    emitInit();
    const tokens = ctx();
    const usage = { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 8 };
    out({ type: "stream_event", event: { type: "message_start", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: turnModel, content: [], usage: { input_tokens: 0, output_tokens: 0 } } }, ...envelope() });
    out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: null }, usage }, ...envelope() });
    await sdkReady;
    const sdkCalls = hostStarted ? takeSdkCalls() : [];
    if (sdkCalls.length > 0) await runSdkCalls(sdkCalls, turnModel, usage);
    let interrupted = turnAborted;
    if (interrupted) {
      // An interrupt during the calls ends the turn without the canned wait.
    } else if (shouldAsk) {
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
    const scripted = interrupted ? null : (readScriptedReply(sessionId, turnModel) ?? readDirReply(sessionId));
    if (scripted !== null) {
      out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, ...envelope() });
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: scripted } }, ...envelope() });
      out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, ...envelope() });
    }
    const reply = interrupted ? "fake turn interrupted" : scripted ?? `fake reply from model=${turnModel}`;
    out({ type: "assistant", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: turnModel, content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null, usage }, ...envelope() });
    out({ type: "result", subtype: "success", is_error: false, duration_ms: 200, duration_api_ms: 100, num_turns: 1, result: reply, ...(withStructured && !interrupted ? { structured_output: structuredOutput } : {}), stop_reason: "end_turn", session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID() });
    log({ event: "turn-end", model: turnModel, contextTokens: tokens, ...(interrupted ? { interrupted: true } : {}) });
    turnOpen = false;
    const next = takeNext();
    if (next !== undefined) void runTurn(next);
    else if (stdinEnded) exit("stdin-end");
  };

  const runWakeTurn = async (wake) => {
    turnOpen = true;
    const turnModel = model;
    log({ event: "turn-start", model: turnModel, wakeKind: wake.kind ?? "peer", wake });
    emitInit();
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

    const next = takeNext();
    if (next !== undefined) void runTurn(next);
    else if (stdinEnded) exit("stdin-end");
  };

  const wakePollingTimer = setInterval(() => {
    // An injected child neither consumes an ask fixture nor opens a wake turn; uninjected launches keep both.
    if (fault) return;
    if (turnOpen) return;
    if (inited && takeAsk()) {
      void runTurn("", true, false);
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
          // This fixture emits no hook events; the capability keeps SDK initialization compatible.
          // Hook enforcement must still be verified against the real CLI, not this canned protocol.
          respond(id, { commands: [], models: configuredModels, agents: [], account: {}, output_style: "default", available_output_styles: ["default"], hook_on_failure_supported: true });
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
        if (fault && faultFired) {
          log({ event: "fault-ignored-user", sessionId, chars: text.length });
        } else if (turnOpen) {
          queue.push(text);
          log({ event: "turn-queued", sessionId, chars: text.length, queueDepth: queue.length });
        } else void runTurn(text);
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
