// Synthetic Claude transcript for the Console restart replay path.
//
// Console replays <CLAUDE_CONFIG_DIR>/projects/*/<sessionId>.jsonl
// (chat-session.ts locateTranscript / replayTranscript, chatReplayFromTranscriptLine).
// fake-claude does not write this file. Re-seeding is not restoration: the same
// record must still be here for that read after restart.
//
// Resume id is the objective record id: the objective id for a commander
// (newObjectiveId) and the member id for a member (childSessionId). Both are
// chat-born, and the first child is pinned to that id.
//
// Nothing else writes session.transcriptPath until a live chat session locates
// this file (chat-session.ts locateTranscript) and stores the path. The capture
// route is gone. Call registerTranscript while that Console is running, after
// the objective record exists and the jsonl is in place. It sends one chat
// message so the open session reports its id and the host stores the path it
// finds. Do not edit objective.json while the process is up — the next save
// overwrites it. Waiting for the path after commence or muster does not finish:
// the file did not exist when that session first looked.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// Claude accepts this shape (--session-id). Objective and member ids match it.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// chat-events.ts INJECTED_TRANSCRIPT_TAGS. A leading tag is not a user bubble.
const INJECTED_TAGS = new Set([
  "task-notification",
  "local-command-stdout",
  "local-command-caveat",
  "command-name",
  "command-message",
  "system-reminder",
  "bash-input",
  "bash-stdout",
]);
const LEADING_TAG = /^<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s>])/;
const DEFAULT_AT = Date.parse("2026-01-01T00:00:00.000Z");

function fail(message) {
  throw new Error(`transcript: ${message}`);
}

function projectDirName(cwd) {
  return path.resolve(cwd).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
}

function startMs(at) {
  if (at === undefined) return DEFAULT_AT;
  const ms = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(ms)) fail("at must be epoch milliseconds or an ISO timestamp");
  return ms;
}

function text(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

/**
 * @param {{ configDir: string, cwd: string, sessionId: string, turns: { user: string, assistant: string }[], at?: number | string }} input
 * @returns {{ path: string }}
 */
export function writeTranscript({ configDir, cwd, sessionId, turns, at } = {}) {
  if (typeof configDir !== "string" || configDir.length === 0) fail("configDir is required");
  if (typeof cwd !== "string" || cwd.length === 0) fail("cwd is required");
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) fail("sessionId must be the commander or member UUID");
  if (!Array.isArray(turns) || turns.length === 0) fail("turns must be a non-empty list");
  const resolvedCwd = path.resolve(cwd);
  const base = startMs(at);
  const lines = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn || typeof turn !== "object") fail(`turns[${index}] must be { user, assistant }`);
    const user = text(turn.user, `turns[${index}].user`);
    const assistant = text(turn.assistant, `turns[${index}].assistant`);
    const tag = LEADING_TAG.exec(user.trimStart())?.[1];
    if (tag !== undefined && INJECTED_TAGS.has(tag)) fail(`turns[${index}].user starts with an injected tag (<${tag}>), which replay does not show as a message`);
    const stamp = (offset) => new Date(base + offset).toISOString();
    lines.push(JSON.stringify({
      type: "user",
      timestamp: stamp(index * 2000),
      cwd: resolvedCwd,
      sessionId,
      message: { role: "user", content: user },
    }));
    lines.push(JSON.stringify({
      type: "assistant",
      timestamp: stamp(index * 2000 + 1000),
      cwd: resolvedCwd,
      sessionId,
      message: { role: "assistant", content: [{ type: "text", text: assistant }] },
    }));
  }
  const dir = path.join(path.resolve(configDir), "projects", projectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const temporary = path.join(dir, `.${sessionId}.${randomBytes(6).toString("hex")}.jsonl`);
  writeFileSync(temporary, `${lines.join("\n")}\n`, "utf8");
  renameSync(temporary, file);
  return { path: file };
}

function directoryNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."));
  } catch {
    return [];
  }
}

/** The live chat locate writes this. A bind that leaves the file without the path did not stick. */
function storedTranscript(dataDir, recordId) {
  const root = path.join(path.resolve(dataDir), "commodore");
  for (const commodore of directoryNames(root)) {
    for (const objective of directoryNames(path.join(root, commodore.name, "objectives"))) {
      const file = path.join(root, commodore.name, "objectives", objective.name, "objective.json");
      let doc;
      try { doc = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
      const rows = [doc, ...(Array.isArray(doc.sessions) ? doc.sessions : [])];
      const hit = rows.find((row) => row && row.id === recordId);
      if (hit) return hit.session ?? null;
    }
  }
  return undefined;
}

/**
 * Bind a written transcript to a running Console's objective record.
 *
 * dataDir is FLEET_CONSOLE_DATA_DIR (<run-dir>/console), not the Claude config dir.
 * recordId is the objective id (commander) or member id. sessionId is that same UUID.
 * transcriptPath is writeTranscript's returned path. The file must already exist.
 *
 * There is no capture route. A live chat session stores the path when it sees its
 * session id and finds the jsonl under projects (locateTranscript). One
 * origin-gated chat message makes that lookup run again. The message is not part
 * of the synthetic history; the caller rewrites the jsonl after this returns if
 * the turn replaced it. Does not print the lock token. Confirms objective.json
 * holds the path before returning.
 *
 * @param {{ dataDir: string, recordId: string, sessionId: string, transcriptPath: string }} input
 * @returns {Promise<{ recordId: string, sessionId: string, transcriptPath: string }>}
 */
export async function registerTranscript({ dataDir, recordId, sessionId, transcriptPath } = {}) {
  if (typeof dataDir !== "string" || dataDir.length === 0) fail("dataDir is required");
  if (typeof recordId !== "string" || !SESSION_ID.test(recordId)) fail("recordId must be the commander objective id or the member id");
  if (typeof sessionId !== "string" || sessionId !== recordId) fail("sessionId must equal recordId");
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) fail("transcriptPath must be the absolute path writeTranscript returned");
  let lock;
  try { lock = JSON.parse(readFileSync(path.join(dataDir, "console.lock"), "utf8")); }
  catch { fail("no console.lock; register while the owned Console is running"); }
  const port = lock?.port;
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    fail("console.lock has no port; register while the owned Console is running");
  }
  const origin = `http://127.0.0.1:${port}`;
  const res = await fetch(`${origin}/api/v1/agent/sessions/${recordId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ text: "ledger transcript bind" }),
  });
  const body = await res.text();
  if (!res.ok) fail(`bind -> ${res.status} ${body.slice(0, 200)}`);
  const deadline = Date.now() + 30_000;
  let stored = storedTranscript(dataDir, recordId);
  while (Date.now() < deadline && (!stored || stored.transcriptPath !== transcriptPath || stored.id !== sessionId || stored.harness !== "claude-code")) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    stored = storedTranscript(dataDir, recordId);
  }
  if (!stored || stored.transcriptPath !== transcriptPath || stored.id !== sessionId || stored.harness !== "claude-code") {
    fail("chat locate did not store this transcript on the objective record");
  }
  return { recordId, sessionId, transcriptPath };
}
