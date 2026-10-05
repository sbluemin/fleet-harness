#!/usr/bin/env node
// Credential-free stand-in for the Claude Code CLI (CLAUDE_BIN) used by the process lifecycle suites. No model, no network.
//
// It is the worst agent a Console has to contain: a chat (SDK stream-json) launch ignores SIGTERM and keeps its open turn
// alive past stdin EOF, so only SIGKILL ends it. Every launch, chat or terminal, starts one stdio MCP child that exits on
// stdin EOF, as real MCP servers do. Each process appends {role, pid, ppid} to $FAKE_AGENT_DIR/procs.jsonl so a suite can
// count what a Console left behind; nothing else (argv may carry local bearer tokens) is recorded.
// With FAKE_AGENT_LEADER_EXITS=1 a chat launch leaves a child that ignores SIGTERM in its process group and exits as its turn
// opens: a registered group whose leader is gone but which still has a member.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.999 (Claude Code)\n");
  process.exit(0);
}

const dir = process.env.FAKE_AGENT_DIR;
if (!dir) {
  process.stderr.write("lifecycle-fake-agent: FAKE_AGENT_DIR is required\n");
  process.exit(2);
}
const record = (entry) => appendFileSync(path.join(dir, "procs.jsonl"), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
const chat = args.some((value, index) => value === "--input-format=stream-json" || (value === "--input-format" && args[index + 1] === "stream-json"));
const role = chat ? "chat" : "terminal";
const mcp = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1 << 30);"], { stdio: ["pipe", "ignore", "ignore"] });
record({ role, pid: process.pid, ppid: process.ppid });
record({ role: `${role}-mcp`, pid: mcp.pid, ppid: process.pid });

if (!chat) {
  // A terminal session ends the way a PTY ends it: hangup or the default SIGTERM disposition.
  process.stdout.write("lifecycle-fake-agent terminal\r\n");
  process.stdin.on("data", (chunk) => process.stdout.write(chunk));
  setInterval(() => {}, 1 << 30);
} else {
  process.on("SIGTERM", () => record({ role: "signal", signal: "SIGTERM", pid: process.pid }));
  const sessionId = randomUUID();
  const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const envelope = () => ({ parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "control_request") {
        const response = message.request?.subtype === "initialize"
          ? { commands: [], models: [], agents: [], account: {}, output_style: "default", available_output_styles: ["default"] }
          : {};
        out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
      } else if (message.type === "user") {
        // The turn opens and never completes: the Console is stopped while an agent is mid-turn.
        out({ type: "system", subtype: "init", session_id: sessionId, model: "default", cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: "default", slash_commands: [], apiKeySource: "none", claude_code_version: "2.1.999", output_style: "default", agents: [], skills: [], plugins: [], uuid: randomUUID() });
        out({ type: "stream_event", event: { type: "message_start", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "default", content: [], usage: { input_tokens: 0, output_tokens: 0 } } }, ...envelope() });
        record({ role: "turn-open", pid: process.pid });
        if (process.env.FAKE_AGENT_LEADER_EXITS === "1") {
          const orphan = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);"], { stdio: "ignore" });
          record({ role: "chat-orphan", pid: orphan.pid, ppid: process.pid });
          setTimeout(() => process.exit(0), 100);
        }
      }
    }
  });
  setInterval(() => {}, 1 << 30);
}
