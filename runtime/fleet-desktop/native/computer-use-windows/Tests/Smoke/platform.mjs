// One-shot `--platform` frames and the `--paste-lease` protocol, exactly as the Console speaks them.
import { spawn } from "node:child_process";
const exe = process.argv[2];
const frame = (obj) => { const body = Buffer.from(JSON.stringify(obj)); return Buffer.concat([Buffer.from(String(body.length).padStart(8, "0")), body]); };
function platform(method, params = {}, raw) {
  return new Promise((resolve) => {
    const child = spawn(exe, ["--platform"], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
    child.stdin.end(raw ?? frame({ version: 1, method, params }));
  });
}
const show = async (label, p) => { const t = Date.now(); const r = await p; console.log(label, `(${Date.now() - t}ms)`, `exit=${r.code}`, r.out.slice(0, 300)); return r; };
await show("readPermissions", platform("readPermissions"));
await show("unknown", platform("nope"));
await show("badframe", platform("x", {}, Buffer.from("garbage!")));
const helper = new (await import("./helper-client.mjs")).Helper(exe);
const wins = (await helper.send("windows", { query: process.argv[3] ?? "메모장" })).result.windows;
const w = wins[0];
await helper.stop();
if (w) {
  const id = { pid: w.pid, windowId: w.windowId, processStartedAt: w.processStartedAt };
  await show("verifyWindowIdentity", platform("verifyWindowIdentity", id));
  await show("windowState", platform("windowState", id));
  await show("captureStill(onscreen -> unavailable)", platform("captureStill", id));
  await show("verify stale start", platform("verifyWindowIdentity", { ...id, processStartedAt: id.processStartedAt + 5 }));
}
await show("resolveApp exe", platform("resolveApp", { target: "C:/Windows/System32/notepad.exe" }));
await show("resolveApp name", platform("resolveApp", { target: "계산기" }));
await show("resolveApp aumid", platform("resolveApp", { target: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" }));
await show("resolveApp junk", platform("resolveApp", { target: "no such app xyz" }));
await show("resolveApp dirty", platform("resolveApp", { target: " x" }));
await show("openPrivacySettings", platform("openPrivacySettings", { permissions: ["accessibility"] }));
await show("openApp calc (no activate)", platform("openApp", { app: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", activate: false }));
await show("openApp missing", platform("openApp", { app: "C:/nope/x.exe", activate: false }));

// paste lease: prepare, hold, restore
async function lease(text, html, holdMs, closeHow) {
  return new Promise((resolve) => {
    const child = spawn(exe, ["--paste-lease"], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    const lines = [];
    child.stdout.on("data", (d) => lines.push(...d.toString().split("\n").filter(Boolean)));
    child.on("close", (code) => resolve({ code, lines }));
    child.stdin.write(frame({ version: 1, text, ...(html ? { html } : {}) }));
    setTimeout(() => { if (closeHow === "eof") child.stdin.end(); else if (closeHow === "extra") child.stdin.write("x"); }, holdMs);
  });
}
const ps = (cmd) => new Promise((r) => { const c = spawn("powershell", ["-NoProfile", "-Command", cmd]); let o = ""; c.stdout.on("data", (d) => (o += d)); c.on("close", () => r(o.trim())); });
await ps("Set-Clipboard -Value 'ORIGINAL-CLIPBOARD'");
const during = ps("Start-Sleep -Milliseconds 700; Get-Clipboard");
const r1 = await lease("LEASED TEXT 한글", "<b>bold</b>", 1500, "eof");
console.log("lease eof ->", r1.code, r1.lines.join(" | "), "| during:", await during, "| after:", await ps("Get-Clipboard"));
await ps("Set-Clipboard -Value 'ORIGINAL-2'");
const newer = ps("Start-Sleep -Milliseconds 100; Set-Clipboard -Value 'NEWER-FROM-USER'");
const r2 = await lease("LEASED 2", null, 4000, "eof");
await newer;
console.log("lease newer ->", r2.code, r2.lines.join(" | "), "| after:", await ps("Get-Clipboard"));
const r3 = await lease("LEASED 3", null, 800, "extra");
console.log("lease extra input ->", r3.code, r3.lines.join(" | "), "| after:", await ps("Get-Clipboard"));
