import { appendFile, mkdir, readFile } from "node:fs/promises";

import { getLogFile } from "./paths.js";
import type { MemoryPaths, WikiLogEntry, WikiLogEvent, WikiLogPayload } from "./types.js";

const LOG_HEADER_PATTERN = /^## (.+) — (.+)$/;
const LOG_BULLET_PATTERN = /^- ([a-z0-9_]+): `([\s\S]*)`$/;
const LOG_EVENTS: WikiLogEvent[] = [
  "raw source added",
  "patch enqueued",
  "patch edited",
  "patch approved",
  "patch rejected",
  "patch set staged",
  "patch set approved",
  "patch set partially approved",
  "conflict detected",
  "drydock run",
  "index rebuilt",
];

export async function appendLog(
  paths: MemoryPaths,
  event: WikiLogEvent,
  payload: WikiLogPayload = {},
  now = new Date(),
): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  const logFile = getLogFile(paths);
  const entryText = formatLogEntry({
    timestamp: now.toISOString(),
    event,
    payload,
  });
  await appendFile(logFile, entryText, { encoding: "utf8", flag: "a" });
}

export async function parseLog(paths: MemoryPaths): Promise<WikiLogEntry[]> {
  const logFile = getLogFile(paths);
  let content: string;
  try {
    content = await readFile(logFile, "utf8");
  } catch {
    return [];
  }
  return parseLogText(content);
}

export function formatLogEntry(entry: WikiLogEntry): string {
  const lines = [`## ${entry.timestamp} — ${entry.event}`, ""];
  for (const key of Object.keys(entry.payload).sort()) {
    const value = entry.payload[key];
    if (value === undefined) continue;
    lines.push(`- ${key}: \`${escapeInlineCode(formatPayloadValue(value))}\``);
  }
  lines.push("", "");
  return lines.join("\n");
}

function parseLogText(content: string): WikiLogEntry[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];
  const chunks = normalized
    .split(/^## /m)
    .map((chunk, index) => (index === 0 ? chunk : `## ${chunk}`))
    .filter((chunk) => chunk.trim().length > 0);
  const entries: WikiLogEntry[] = [];
  for (const chunk of chunks) {
    const lines = chunk.trimEnd().split("\n");
    const header = lines.shift();
    if (!header) {
      throw new Error("log entry missing header");
    }
    const match = header.match(LOG_HEADER_PATTERN);
    if (!match) {
      throw new Error(`invalid log header: ${header}`);
    }
    const [, timestamp, event] = match;
    if (Number.isNaN(Date.parse(timestamp))) {
      throw new Error(`invalid log timestamp: ${timestamp}`);
    }
    if (!LOG_EVENTS.includes(event as WikiLogEvent)) {
      throw new Error(`invalid log event: ${event}`);
    }
    const payload: WikiLogPayload = {};
    for (const line of lines) {
      if (!line.trim()) continue;
      const bulletMatch = line.match(LOG_BULLET_PATTERN);
      if (!bulletMatch) {
        throw new Error(`invalid log bullet: ${line}`);
      }
      const [, key, rawValue] = bulletMatch;
      payload[key] = parsePayloadValue(unescapeInlineCode(rawValue));
    }
    entries.push({
      timestamp,
      event: event as WikiLogEvent,
      payload,
    });
  }
  return entries;
}

function formatPayloadValue(value: Exclude<WikiLogPayload[string], undefined>): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null) return "null";
  return String(value);
}

function parsePayloadValue(value: string): WikiLogPayload[string] {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function escapeInlineCode(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\n");
}

function unescapeInlineCode(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === "n") { out += "\n"; i++; continue; }
      if (next === "`") { out += "`"; i++; continue; }
      if (next === "\\") { out += "\\"; i++; continue; }
    }
    out += ch;
  }
  return out;
}
