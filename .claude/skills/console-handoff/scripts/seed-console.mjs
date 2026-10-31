#!/usr/bin/env node
/**
 * Seed an isolated Fleet Console so a person can try a change by hand.
 *
 * Two modes, both talking to the Console's own HTTP API with the Origin header its
 * write routes require:
 *
 *   seed   node seed-console.mjs --dir <console-data-dir> --theater <path>
 *                                [--commodore <uuid>] [--prompt "..."] [--model <gateway-id>] [--await ask|turn]
 *   answer node seed-console.mjs --dir <console-data-dir> --answer <sessionId>
 *                                [--pick N | --text "..." | --approve | --dismiss | --revise "..."]
 *
 * The answer mode re-reads the journal to find the parked question rather than taking an
 * id on the command line: a real tool_use id can contain a newline, so it must never travel through a shell variable.
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

/** Read the chat journal over the ticketed WebSocket, calling onEvent for each entry. Returns when onEvent says stop. */
async function readChat(sessionId, onEvent, timeoutMs) {
  // chat-stream SSE는 제거됐다 — 채팅 관측은 티켓 WebSocket이 맡는다.
  const ticketRes = await fetch(`${base}/api/v1/agent/ticket`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ objectiveId: sessionId, channel: "chat" }),
  });
  const ticketText = await ticketRes.text();
  if (!ticketRes.ok) fail(`chat ticket -> ${ticketRes.status} ${ticketText.slice(0, 300)}`);
  let ticket = null;
  try { ticket = JSON.parse(ticketText)?.ticket; } catch { /* 아래에서 검증 */ }
  if (typeof ticket !== "string" || !ticket) fail("chat ticket -> invalid response");
  const url = `${base.replace(/^http/, "ws")}/api/v1/terminal/ws?ticket=${encodeURIComponent(ticket)}`;
  await new Promise((resolve, reject) => {
    let done = false;
    let ws = null;
    const timer = setTimeout(() => finish(null), timeoutMs);
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* 이미 닫힘 */ }
      if (error) reject(error);
      else resolve();
    };
    try {
      ws = new WebSocket(url);
    } catch (error) { finish(error); return; }
    ws.onmessage = (event) => {
      let entry = null;
      try { entry = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); } catch { return; }
      // ack/nack 프레임은 저널이 아니다.
      if (entry?.type === "ok" || entry?.type === "nack") return;
      try {
        if (onEvent(entry.event ?? entry) === true) finish(null);
      } catch (error) { finish(error); }
    };
    ws.onerror = () => finish(new Error("chat socket error"));
    ws.onclose = () => finish(null);
  });
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
  const result = await api("POST", `/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/chat-answer`, body);
  console.log(JSON.stringify({ mode: "answer", sessionId, form: ask.form, sent: body, result }, null, 1));
  process.exit(0);
}

const theaterPath = args.get("theater");
if (typeof theaterPath !== "string") fail("--theater <path> is required");
// The caller chooses the owner explicitly; a folder never chooses a Commodore.
let commodoreId = args.get("commodore");
if (typeof commodoreId !== "string") {
  ({ commodoreId } = await api("POST", "/api/v1/commodore/create", { alias: path.basename(theaterPath) || "Fixture" }));
}
const grant = await api("POST", "/api/v1/theaters/folder-grants", { path: theaterPath });
const { theaterId } = await api("POST", "/api/v1/commodore/theaters/add", { commodoreId, folderGrantId: grant.folderGrantId });
console.error(`seed-console: commodore=${commodoreId} theater=${theaterId} port=${lock.port}`);

const prompt = args.get("prompt");
if (typeof prompt !== "string") {
  console.log(JSON.stringify({ mode: "seed", port: lock.port, commodoreId, theaterId }, null, 1));
  process.exit(0);
}

const session = await api("POST", "/api/v1/agent/sessions", {
  commodoreId,
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
  commodoreId,
  sessionId,
  url: `${base}/console/`,
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
