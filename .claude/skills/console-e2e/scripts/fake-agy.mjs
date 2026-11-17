#!/usr/bin/env node
// Credential-free stand-in for the agy CLI, used as FLEET_ANTIGRAVITY_CLI (absolute path) in an isolated Console on macOS/Linux.
// No model and no provider. The ACP side is the AI Gateway runtime's unit fake, imported unchanged in its FAKE_BRIDGE mode:
// runtime/fleet-console/features/ai-gateway/runtime/tests/acp/fake-agy.mjs (its header lists the prompt scripts it reacts to).
//
// Console calls it as:
//   --version                        quota reads it once per binary path+mtime, after Antigravity is turned on → "1.5.9"
//   -p /usage --output-format json   each Antigravity quota refresh → gemini-5h/weekly and 3p-5h/weekly at fixed fractions
//   acp --gemini-dir <dir> ...       one launch per Gateway agy session open, including the tool-less compaction session.
//                                    Chat turns answer `echo:<first 60 chars> history:yes|no`; the handoff-summary
//                                    (compaction) prompt answers `Compacted summary (0 tools) history:yes|no` in a tool-less
//                                    session and calls a tool instead when tools are exposed (a synthetic failure branch).
// FAKE_MODELS (optional, read at each acp launch): comma-separated availableModels rung ids. Default: the gemini-4-hydrogen and
//   claude-opus-5-5 rungs. Opening any other catalog model fails like an account that lacks it.
// FAKE_AGY_LOG (optional, absolute path): JSONL appended per launch and per client→agy message: at, pid, mode, flag names,
//   method; set_config_option configId/value; session/prompt promptChars and history/compact flags. No prompt text, gemini-dir
//   files, or MCP headers. FAKE_LOG is removed so the unit fake writes no full argv/params log.
// Not inert: at session/new the unit fake reads <gemini-dir>/config/mcp_config.json and POSTs MCP initialize and tools/list to the
// Console URL there with that file's headers; TOOL:/TIMEOUT:/ENDEARLY:/BUILTIN prompts call tools through it.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const mode = argv[0] === "--version" ? "version" : argv.includes("/usage") ? "usage" : argv[0] === "acp" ? "acp" : "unsupported";
const log = (entry) => {
  if (!process.env.FAKE_AGY_LOG) return;
  appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`, { mode: 0o600 });
};
log({ mode, flags: argv.filter((arg) => arg.startsWith("-")) });

if (mode === "version") {
  process.stdout.write("1.5.9\n");
} else if (mode === "usage") {
  const reset = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const bucket = (id, remaining_fraction, hours) => ({ id, remaining_fraction, reset_time: reset(hours) });
  process.stdout.write(`${JSON.stringify({
    status: "SUCCESS",
    num_turns: 0,
    command: { name: "usage", data: { groups: [
      { name: "Gemini Models", buckets: [bucket("gemini-5h", 0.8, 3), bucket("gemini-weekly", 0.7, 120)] },
      { name: "Claude and GPT models", buckets: [bucket("3p-5h", 0.6, 3), bucket("3p-weekly", 0.55, 120)] },
    ] } },
  })}\n`);
} else if (mode === "acp") {
  process.env.FAKE_BRIDGE = "1";
  process.env.FAKE_MODELS ||= ["gemini-4-hydrogen", "claude-opus-5-5"].flatMap((base) => ["low", "medium", "high"].map((rung) => `${base}-${rung}`)).join(",");
  delete process.env.FAKE_LOG;
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === undefined) return;
    const entry = { method: message.method };
    if (message.method === "session/set_config_option") Object.assign(entry, { configId: message.params?.configId, value: message.params?.value });
    if (message.method === "session/prompt") {
      const text = (message.params?.prompt ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
      Object.assign(entry, {
        promptChars: text.length,
        history: text.includes("<conversation_history>"),
        compact: text.includes("Create a detailed plaintext handoff summary"),
      });
    }
    log(entry);
  });
  await import(new URL("../../../../runtime/fleet-console/features/ai-gateway/runtime/tests/acp/fake-agy.mjs", import.meta.url).href);
} else {
  process.stderr.write(`fake-agy: unsupported arguments ${JSON.stringify(argv)}\n`);
  process.exitCode = 2;
}
