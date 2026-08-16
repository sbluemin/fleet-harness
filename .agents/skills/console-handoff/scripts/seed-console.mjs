#!/usr/bin/env node
/**
 * Seed an isolated Fleet Console so a person can try a change by hand.
 *
 * Two modes, both talking to the Console's own HTTP API with the Origin header its
 * write routes require:
 *
 *   seed   node seed-console.mjs --dir <console-data-dir> --theater <path>
 *                                [--prompt "..."] [--model <gateway-id>] [--await ask|turn]
 *   answer node seed-console.mjs --dir <console-data-dir> --answer <sessionId>
 *                                [--pick N | --text "..." | --approve | --dismiss | --revise "..."]
 *
 * The answer mode re-reads the journal to find the parked question rather than taking an
 * id on the command line: a real tool_use id can contain a newline (measured on the cursor
 * gateway), so it must never travel through a shell variable.
 *
 * Prints one JSON object on stdout; progress goes to stderr.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const args = new Map();
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith("--")) continue;
  const key = argv[i].slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) args.set(key, true);
  else { args.set(key, next); i += 1; }
}

const dir = args.get("dir");
if (typeof dir !== "string") fail("--dir <console-data-dir> is required");

let lock;
try {
  lock = JSON.parse(readFileSync(path.join(dir, "console.lock"), "utf8"));
} catch {
  fail(`no console.lock under ${dir} — is the isolated Console running?`);
}
const base = `http://127.0.0.1:${lock.port}`;

function fail(message) {
  console.error(`seed-console: ${message}`);
  process.exit(1);
}

async function api(method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { Origin: base, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not every route answers JSON */ }
  if (!res.ok) fail(`${method} ${pathname} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}

/** Register the folder as a Theater, or reuse the registration if it already exists. */
async function ensureTheater(dirPath) {
  const listed = await api("GET", "/api/v1/theaters");
  const rows = Array.isArray(listed) ? listed : listed?.theaters ?? [];
  const hit = rows.find((row) => row.path === dirPath || row.rootPath === dirPath);
  if (hit) return hit.id;
  const grant = await api("POST", "/api/v1/theaters/folder-grants", { path: dirPath });
  const theater = await api("POST", "/api/v1/theaters", { folderGrantId: grant?.id ?? grant?.folderGrantId });
  return theater.id;
}

/** Read the chat journal, calling onEvent for each entry. Returns when onEvent says stop. */
async function readChat(sessionId, onEvent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(`${base}/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/chat-stream`, {
    headers: { Origin: base, Accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) fail(`chat-stream -> ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let entry = null;
          try { entry = JSON.parse(payload); } catch { continue; }
          if (onEvent(entry.event ?? entry) === true) { controller.abort(); return; }
        }
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
  }
}

const timeoutMs = Number(args.get("timeout") ?? 240) * 1000;

if (args.has("answer")) {
  const sessionId = args.get("answer");
  if (typeof sessionId !== "string") fail("--answer needs a session id");
  const parked = new Map();
  await readChat(sessionId, (event) => {
    if (event.kind === "ask") parked.set(event.id, event);
    if (event.kind === "ask-settled") parked.delete(event.id);
    return false;
  }, 15_000);
  const ask = [...parked.values()][0];
  if (!ask) fail("no question is waiting on that session");

  let body;
  if (args.has("dismiss")) body = { askId: ask.id };
  else if (args.has("approve")) body = { askId: ask.id, approve: true };
  else if (args.has("revise")) body = { askId: ask.id, message: String(args.get("revise")) };
  else if (args.has("text")) body = { askId: ask.id, answers: [String(args.get("text"))] };
  else {
    const pick = Number(args.get("pick") ?? 1);
    body = {
      askId: ask.id,
      answers: (ask.questions ?? []).map((question) => question.options[pick - 1]?.label ?? question.options[0].label),
    };
  }
  const result = await api("POST", `/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/chat-answer`, body);
  console.log(JSON.stringify({ mode: "answer", sessionId, form: ask.form, sent: body, result }, null, 1));
  process.exit(0);
}

const theaterPath = args.get("theater");
if (typeof theaterPath !== "string") fail("--theater <path> is required");
const theaterId = await ensureTheater(theaterPath);
console.error(`seed-console: theater=${theaterId} port=${lock.port}`);

const prompt = args.get("prompt");
if (typeof prompt !== "string") {
  console.log(JSON.stringify({ mode: "seed", port: lock.port, theaterId }, null, 1));
  process.exit(0);
}

const session = await api("POST", "/plugins/terminal/agent/sessions", {
  theaterId,
  cliId: "claude-gateway",
  viewMode: "chat",
  prompt,
  ...(typeof args.get("model") === "string" ? { model: args.get("model") } : {}),
});
const sessionId = session.sessionId ?? session.id;
console.error(`seed-console: session=${sessionId}`);

const until = args.get("await");
let asked = null;
let ended = false;
if (until === "ask" || until === "turn") {
  await readChat(sessionId, (event) => {
    if (event.kind === "ask") { asked = event; return until === "ask"; }
    if (event.kind === "turn-end") { ended = true; return true; }
    return false;
  }, timeoutMs);
}

console.log(JSON.stringify({
  mode: "seed",
  port: lock.port,
  theaterId,
  sessionId,
  url: `${base}/console/operations`,
  asked: asked
    ? {
      form: asked.form,
      questions: (asked.questions ?? []).map((question) => ({
        header: question.header,
        question: question.question,
        multiSelect: question.multiSelect,
        options: question.options.map((option) => option.label),
      })),
    }
    : null,
  turnEnded: ended,
}, null, 1));
