// Real-window smoke over Notepad (WinUI + RichEdit), Calculator (UWP), Edge (Chromium) and a classic Win32 dialog.
// A separate "person" process owns the foreground and parks the pointer; the helper must not disturb either.
//   node smoke-all.mjs <fleet-computer-use.exe> <smoke-tool.exe>
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [exe, tool] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "fleet-smoke-"));
const ps = (cmd) => { try { return execFileSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }); } catch (error) { console.log("(powershell step failed)"); return ""; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (match, steps) => {
  const file = join(work, `steps-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(steps));
  const r = spawnSync("node", [join(here, "act.mjs"), exe, tool, match, file], { encoding: "utf8", timeout: 300000 });
  console.log(r.stdout + (r.stderr ? "\n" + r.stderr : ""));
};

// -- Notepad ---------------------------------------------------------------------------------------------------------
const marker = `fleet-smoke-${Date.now()}`;
writeFileSync(join(work, `${marker}.txt`), "line one\nline two\n".repeat(80));
ps(`Start-Process notepad.exe -ArgumentList '${join(work, marker + ".txt").replaceAll("\\", "/")}'; Start-Sleep 3`);
console.log("\n===== Notepad (WinUI shell + RichEdit text area) =====");
run(marker, [
  { name: "type via ref (RichEdit)", find: { role: "AXTextArea", label: "텍스트" }, params: { action: "type", text: "한글 ABC ✓" } },
  { name: "key ctrl+a", params: { action: "key", key: "cmd+a" } },
  { name: "key end", params: { action: "key", key: "end" } },
  { name: "click text by point", params: { action: "click", x: 300, y: 300 } },
  { name: "scroll down", params: { action: "scroll", direction: "down", x: 300, y: 300 } },
  { name: "click WinUI menu (B)", find: { role: "AXMenuItem", label: "편집" }, params: { action: "click" } },
  { name: "set_value (B)", find: { role: "AXTextArea", label: "텍스트" }, params: { action: "set_value", text: "set by helper" } },
]);

// -- Calculator ------------------------------------------------------------------------------------------------------
ps("Get-Process CalculatorApp -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 1; Start-Process calc.exe; Start-Sleep 3");
console.log("\n===== Calculator (UWP / CoreWindow) =====");
run("Calculator", [
  { name: "click 7 by ref (B)", find: { role: "AXButton", label: "7" }, params: { action: "click" } },
  { name: "click 8 by point (B hit-test)", findPoint: { role: "AXButton", label: "8" }, params: { action: "click" } },
  { name: "type (no editable focus)", params: { action: "type", text: "5" } },
]);
run("계산기", [
  { name: "click 7 by ref (B)", find: { role: "AXButton", label: "7" }, params: { action: "click" } },
  { name: "click 8 by point (B hit-test)", findPoint: { role: "AXButton", label: "8" }, params: { action: "click" } },
]);

// -- Edge ------------------------------------------------------------------------------------------------------------
const page = join(work, "page.html");
writeFileSync(page, `<!doctype html><html><head><meta charset=utf-8><title>FleetSmokePage</title><style>body{font:20px sans-serif;margin:0;height:5000px}</style></head><body>
<input id=t aria-label="probe input" style="position:fixed;top:20px;left:20px;width:300px"><button id=b style="position:fixed;top:20px;left:360px">Press</button>
<script>let n=0;const t=document.getElementById('t');function u(){document.title='FleetSmokePage c='+n+' y='+Math.round(scrollY)+' v='+t.value}
document.getElementById('b').onclick=()=>{n++;u()};t.oninput=u;onscroll=u;u()</script></body></html>`);
ps(`Start-Process 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' -ArgumentList '--user-data-dir=${join(work, "edge").replaceAll("\\", "/")}','--no-first-run','--new-window','--window-position=120,120','--window-size=1000,800','file:///${page.replaceAll("\\", "/")}'; Start-Sleep 5`);
console.log("\n===== Edge (Chromium) =====");
{ const w = spawnSync("node", [join(here, "prewarm.mjs"), exe, "FleetSmokePage", tool], { encoding: "utf8" }); console.log((w.stdout + w.stderr).trim() || "(prewarm: no output)"); }
run("FleetSmokePage", [
  { name: "click Press (ref)", find: { role: "AXButton", label: "Press" }, params: { action: "click" } },
  { name: "type into input (ref)", find: { role: "AXTextField", label: "probe input" }, params: { action: "type", text: "hi한글" } },
  { name: "key ctrl+a", params: { action: "key", key: "cmd+a" } },
  { name: "click by point", findPoint: { role: "AXButton", label: "Press" }, params: { action: "click" } },
  { name: "scroll down (covered point -> B)", params: { action: "scroll", direction: "down", x: 400, y: 400, pages: 2 } },
  { name: "set_value (B)", find: { role: "AXTextField", label: "probe input" }, params: { action: "set_value", text: "set-by-uia" } },
  { name: "drag (unsupported)", params: { action: "drag", x: 100, y: 200, to: { x: 200, y: 300 } } },
]);
ps("Get-Process msedge | Where-Object { $_.MainWindowTitle -like 'FleetSmokePage*' } | ForEach-Object { $_.CloseMainWindow() | Out-Null }");

// -- Classic Win32 dialog (Run) --------------------------------------------------------------------------------------
ps("Start-Process rundll32.exe -ArgumentList 'shell32.dll,#61'; Start-Sleep 2");
console.log("\n===== Classic Win32 dialog (Run, #32770) =====");
run("Rundll32", [
  { name: "type in Edit", find: { role: "AXTextField", label: "열기" }, params: { action: "type", text: "-smoke 한글" } },
  { name: "key ctrl+a", params: { action: "key", key: "ctrl+a" } },
  { name: "key home", params: { action: "key", key: "home" } },
  { name: "click Cancel button (message)", find: { role: "AXButton", label: "취소" }, params: { action: "click" } },
]);
ps("Get-Process rundll32 -ErrorAction SilentlyContinue | Stop-Process -Force");
