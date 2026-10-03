#!/usr/bin/env node
// Act as a fake-claude launch on one of the MCP servers Console gave it (e.g. fleet-objectives, fleet-console-use).
// Usage: node fake-claude-mcp.mjs --dir <FAKE_CLAUDE_DIR> --server <name> --tool <tool> [--args '<json>'] [--pid <launch pid>]
//        node fake-claude-mcp.mjs --dir <FAKE_CLAUDE_DIR> --list            (launches with saved MCP configs; no secrets)
// Without --pid the most recent launch that received <server> is used. Prints the tool result JSON only;
// the bearer token is read from the owner-only file fake-claude.mjs saved and is never printed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dir = opt("--dir");
if (!dir) fail("--dir <FAKE_CLAUDE_DIR> is required");
const mcpDir = join(dir, "mcp");
const launches = readdirSync(mcpDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({ pid: Number(name.slice(0, -5)), file: join(mcpDir, name), mtime: statSync(join(mcpDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
  .map((launch) => ({ ...launch, servers: JSON.parse(readFileSync(launch.file, "utf8")).mcpServers ?? {} }));

if (argv.includes("--list")) {
  for (const launch of launches) {
    process.stdout.write(`${JSON.stringify({ pid: launch.pid, at: new Date(launch.mtime).toISOString(), servers: Object.entries(launch.servers).map(([name, s]) => ({ name, url: s?.url ?? null })) })}\n`);
  }
  process.exit(0);
}

const serverName = opt("--server");
const tool = opt("--tool");
if (!serverName || !tool) fail("--server and --tool are required");
const pid = opt("--pid");
const launch = launches.find((candidate) => (pid === undefined || String(candidate.pid) === pid) && candidate.servers[serverName]);
if (!launch) fail(`no saved launch received MCP server ${serverName}${pid ? ` (pid ${pid})` : ""}`);
const server = launch.servers[serverName];
let toolArgs = {};
try {
  toolArgs = JSON.parse(opt("--args") ?? "{}");
} catch {
  fail("--args must be JSON");
}

let sessionHeader;
let nextId = 1;
async function rpc(method, params, notification = false) {
  const body = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params };
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      ...(server.headers ?? {}),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionHeader ? { "mcp-session-id": sessionHeader } : {}),
    },
    body: JSON.stringify(body),
  });
  sessionHeader = response.headers.get("mcp-session-id") ?? sessionHeader;
  if (notification) return undefined;
  const text = await response.text();
  if (!response.ok) fail(`${method} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  // Streamable HTTP answers either with JSON or with an SSE stream whose data lines carry the JSON-RPC response.
  const payloads = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
    : [text];
  for (const payload of payloads) {
    const message = JSON.parse(payload);
    if (message.id === body.id) {
      if (message.error) fail(`${method} -> ${JSON.stringify(message.error)}`);
      return message.result;
    }
  }
  fail(`${method} -> no JSON-RPC response`);
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude-mcp", version: "1" } });
await rpc("notifications/initialized", {}, true);
const result = await rpc("tools/call", { name: tool, arguments: toolArgs });
process.stdout.write(`${JSON.stringify(result)}\n`);

function fail(message) {
  process.stderr.write(`fake-claude-mcp: ${message}\n`);
  process.exit(1);
}
