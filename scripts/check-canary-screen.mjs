#!/usr/bin/env node
/**
 * Canary default-screen check: serve the BUILT Console in an owned temp slot with the credential-free fake agent,
 * seed it (`seed.mjs --profile basic`), load the default screen in headless Chrome over CDP, and fail on a broken one.
 *
 *   node scripts/check-canary-screen.mjs [--chrome <path>] [--probe]     (build first: pnpm --filter @dotobokuri/fleet-console build)
 *
 * Fails when: the API does not answer, the page throws, logs console.error or gets a 5xx, the app root stays empty, or a landmark is missing.
 * Landmarks are structural (a rendered app root, interactive controls, the seeded commodore's data in the API), never copy,
 * so translations cannot break it. --probe prints a DOM summary instead of asserting (for choosing landmarks).
 * Needs Node >= 22 (global WebSocket/fetch) and a Chrome/Chromium (CHROME_BIN, --chrome, or a standard path).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "runtime/fleet-console/dist/cli.mjs");
const clientIndex = path.join(root, "runtime/fleet-console/dist/client/index.html");
const skillScripts = path.join(root, ".claude/skills/console-e2e/scripts");
const argv = process.argv.slice(2);
const probe = argv.includes("--probe");
const chromeFlag = argv.indexOf("--chrome") >= 0 ? argv[argv.indexOf("--chrome") + 1] : undefined;

const failures = [];
const fail = (message) => { failures.push(message); console.error(`FAIL: ${message}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(cli) || !existsSync(clientIndex)) { console.error("build the Console first (dist/cli.mjs and dist/client are missing)"); process.exit(2); }

const findChrome = () => {
  const candidates = [chromeFlag, process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) { console.error("no Chrome/Chromium found; set CHROME_BIN"); process.exit(2); }
  return found;
};

// Every temporary tree lives under one root, removed on exit and on the signals zsh/sh would otherwise skip.
const T = mkdtempSync(path.join(os.tmpdir(), "canary-screen-"));
const children = [];
const cleanup = () => {
  for (const child of children) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  try { rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on("exit", cleanup);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(signal, () => { cleanup(); process.exit(code); });

for (const dir of ["home", "tmp", "root/console", "fake", "claude", "chrome"]) mkdirSync(path.join(T, dir), { recursive: true });
const slot = path.join(T, "root/console");
const env = {
  PATH: process.env.PATH, HOME: path.join(T, "home"), TMPDIR: path.join(T, "tmp"),
  FLEET_DATA_DIR: path.join(T, "root"), FLEET_CONSOLE_DATA_DIR: slot, CLAUDE_CONFIG_DIR: path.join(T, "claude"),
  CLAUDE_BIN: path.join(skillScripts, "fake-claude.mjs"), FAKE_CLAUDE_DIR: path.join(T, "fake"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

const serve = spawn(process.execPath, [cli, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
children.push(serve);
let serveOutput = "";
serve.stdout.on("data", (chunk) => { serveOutput += chunk; });
serve.stderr.on("data", (chunk) => { serveOutput += chunk; });

async function main() {
  let port = 0;
  for (let i = 0; i < 120 && !port; i += 1) {
    if (serve.exitCode !== null) throw new Error(`Console exited early (${serve.exitCode}):\n${serveOutput.slice(-1500)}`);
    try { port = JSON.parse(readFileSync(path.join(slot, "console.lock"), "utf8")).port ?? 0; } catch { /* not written yet */ }
    if (!port) await sleep(500);
  }
  if (!port) throw new Error("Console wrote no console.lock port within 60s");
  const origin = `http://127.0.0.1:${port}`;

  const seeded = spawnSync(process.execPath, [path.join(skillScripts, "seed/seed.mjs"), "--dir", slot, "--profile", "basic", "--root", path.join(T, "theaters")], { env, encoding: "utf8" });
  if (seeded.status !== 0) throw new Error(`seed failed: ${seeded.stderr.slice(-800)}`);
  const ids = JSON.parse(seeded.stdout);
  const commodoreId = ids.commodores[0].commodoreId;

  // API half: the seeded commodore and its theater are read back, so the server and storage agree.
  const state = await fetch(`${origin}/api/v1/objectives/state`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ commodoreId, language: "en" }) });
  if (!state.ok) fail(`objectives/state answered ${state.status}`);
  const page = await fetch(`${origin}/console/`);
  if (!page.ok) fail(`/console/ answered ${page.status}`);

  // Browser half over CDP.
  const chrome = spawn(findChrome(), ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", `--user-data-dir=${path.join(T, "chrome")}`, "--remote-debugging-port=0", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  children.push(chrome);
  const portFile = path.join(T, "chrome", "DevToolsActivePort");
  for (let i = 0; i < 60 && !existsSync(portFile); i += 1) await sleep(500);
  if (!existsSync(portFile)) throw new Error("Chrome did not open a DevTools port");
  const debugPort = readFileSync(portFile, "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const wsUrl = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error("no page target");

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("CDP socket error")); });
  let seq = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); return; }
    if (msg.method === "Runtime.exceptionThrown") problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push(`console.error: ${msg.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 300)}`);
    // The unauthenticated headless view gets baseline 401/404 answers (e.g. desktop shell-update, taskforce list); only a server fault (5xx) fails.
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      const text = `${msg.params.entry.text} ${msg.params.entry.url ?? ""}`;
      if (msg.params.entry.source !== "network" || /status of 5\d\d/.test(text)) problems.push(`log error: ${text}`.slice(0, 300));
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = (seq += 1); pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  await send("Page.navigate", { url: `${origin}/console/` });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

  // The app has rendered once its root holds elements; give the first-run queries a moment to settle.
  const SUMMARY = `(() => { const root = document.querySelector("#root") ?? document.body; return JSON.stringify({ title: document.title, rootChildren: root.children.length, buttons: document.querySelectorAll("button").length, inputs: document.querySelectorAll("input,textarea,[contenteditable=true]").length, text: document.body.innerText.length, landmarks: [...document.querySelectorAll("nav,aside,main,header,[role=navigation],[role=main]")].map((el) => el.tagName.toLowerCase() + (el.getAttribute("role") ? "[" + el.getAttribute("role") + "]" : "")) }); })()`;
  let summary = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    summary = JSON.parse(await evaluate(SUMMARY));
    if (summary.rootChildren > 0 && summary.buttons > 0) break;
  }
  await sleep(1500); // let late errors surface
  summary = JSON.parse(await evaluate(SUMMARY));
  if (probe) { console.log(JSON.stringify({ summary, problems }, null, 2)); return; }

  if (summary.rootChildren === 0) fail("the app root is empty (the default screen did not render)");
  if (summary.buttons === 0) fail("no interactive controls rendered");
  if (summary.text < 20) fail(`the screen shows almost no text (${summary.text} chars)`);
  if (summary.landmarks.length === 0) fail("no structural landmark (nav/aside/main/header) rendered");
  for (const problem of problems) fail(problem);
  ws.close();
  console.log(`canary screen: root=${summary.rootChildren} buttons=${summary.buttons} text=${summary.text} landmarks=${summary.landmarks.join(",")} errors=${problems.length}`);
}

try { await main(); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
process.exit(failures.length === 0 ? 0 : 1);
