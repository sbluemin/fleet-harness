// Real-window smoke: for each step, a separate "person" process takes the foreground and parks the pointer,
// the helper acts on the target window, and foreground changes / pointer movement are reported.
import { Helper } from "./helper-client.mjs";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [exe, tool, match, stepsFile] = process.argv.slice(2);
const steps = JSON.parse(readFileSync(stepsFile, "utf8"));
const watchFile = join(tmpdir(), `fleet-watch-${process.pid}.log`);
const watcher = spawn(tool, ["watch", watchFile], { stdio: "ignore" });
const blocker = spawn(tool, ["blocker"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const h = new Helper(exe);
const hello = await h.send("hello");
console.log("selfCheck", JSON.stringify(hello.result.selfCheck));
const user = () => execFileSync(tool, ["focus"], { encoding: "utf8" }).trim();
const state = () => execFileSync(tool, ["state"], { encoding: "utf8" }).trim();
const lines = () => (existsSync(watchFile) ? readFileSync(watchFile, "utf8").split("\n").filter(Boolean) : []);
const findWindow = async () => (await h.send("windows", { query: match })).result.windows[0];
user(); await new Promise((r) => setTimeout(r, 600)); user();
let win = await findWindow();
if (!win) { console.log("no window for", match); process.exit(1); }
console.log("target", win.windowId, win.engine, win.title, "app=" + win.app);
const flat = (elements) => elements;
async function resolveRef(spec, wantFrame = false) {
  const r = await h.send("snapshot", { pid: win.pid, windowId: win.windowId, processStartedAt: win.processStartedAt, limit: 1500 }, 30000);
  if (!r.ok) throw new Error("snapshot " + JSON.stringify(r.error));
  const els = flat(r.result.elements);
  const hit = els.filter((e) => (spec.role ? e.role === spec.role : true) && (spec.label ? (e.label ?? "").includes(spec.label) : true) && (spec.editable ? e.editable : true));
  if (!hit.length) throw new Error("no element for " + JSON.stringify(spec) + ` among ${els.length}`);
  const pick = hit[spec.index ?? 0];
  return wantFrame ? pick.frame : pick.ref;
}
const summary = [];
for (const step of steps) {
  win = (await findWindow()) ?? win;
  const params = { pid: win.pid, windowId: win.windowId, processStartedAt: win.processStartedAt, ...step.params };
  if (step.find) params.ref = await resolveRef(step.find);
  if (step.findPoint) { const f = await resolveRef(step.findPoint, true); params.x = Math.round(f.x + f.w / 2); params.y = Math.round(f.y + f.h / 2); }
  const setup = user();
  const mark = lines().length;
  const t0 = Date.now();
  const r = await h.send(step.method ?? "act", params, 30000);
  const ms = Date.now() - t0;
  await new Promise((res) => setTimeout(res, 400));
  const after = state();
  const events = lines().slice(mark).filter((l) => process.env.ALL_EVENTS || !/FLEET-BLOCKER/.test(l) || l.startsWith("cursor"));
  const out = r.ok
    ? `via=${r.result.via} observation=${r.result.observation} verified=${r.result.verified ?? "-"} notes=${JSON.stringify(r.result.notes ?? r.result)}`
    : `ERR ${r.error.code}${r.error.dispatch ? "/" + r.error.dispatch : ""}`;
  const all = lines().slice(mark);
  const fgEvents = all.filter((l) => l.startsWith("fg-event") && !/FLEET-BLOCKER/.test(l)).length;
  const fgPolled = all.filter((l) => l.startsWith("fg-poll") && !/FLEET-BLOCKER/.test(l)).length;
  const pointerMoved = all.some((l) => l.startsWith("cursor") && l !== "cursor 60,60");
  const fgKept = /FLEET-BLOCKER/.test(after);
  summary.push({ name: step.name, ms, ok: r.ok, via: r.ok ? r.result.via : null, fgEvents, fgPolled, pointerMoved, fgKept });
  console.log(`[${step.name}] ${ms}ms ${out}`);
  console.log(`    fg-change-events=${fgEvents} (polled-visible=${fgPolled}) pointer=${pointerMoved ? "MOVED" : "unchanged"} final-foreground=${fgKept ? "user window" : "CHANGED " + after}`);
  if (process.env.ALL_EVENTS) console.log(`    events: ${events.length ? events.join(" ; ") : "none"}`);
}
console.log("SUMMARY " + JSON.stringify({ target: win.app, steps: summary.length, fgChangeEventsTotal: summary.reduce((n, x) => n + x.fgEvents, 0), pointerMoved: summary.some((x) => x.pointerMoved), foregroundNotKept: summary.filter((x) => !x.fgKept).map((x) => x.name) }));
await h.stop();
watcher.kill(); blocker.kill();
